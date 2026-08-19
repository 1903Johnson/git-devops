import type { Family, FamilyCreate, FamilyMember, FamilyMemberCreate } from '@church/contracts';
import { AuditService } from '@church/audit';
import { type Page, decodeCursor, encodeCursor } from '@church/church';
import { CORE_PERMISSIONS, type Subject, assertCan } from '@church/policy';
import { TenantRepository, type TenantTransaction, currentTenant } from '@church/tenancy';
import {
  type FamilyMemberRow,
  type FamilyRow,
  type PersonRow,
  toFamily,
  toFamilyMember,
  toPerson,
} from './mapping.js';

class FamilyRepository extends TenantRepository<FamilyRow> {
  protected readonly table = 'family';
}

export class FamilyNotFoundError extends Error {
  constructor(id: string) {
    super(`no family with id ${id}`);
    this.name = 'FamilyNotFoundError';
  }
}

export class AlreadyInFamilyError extends Error {
  constructor(personId: string, familyId: string) {
    super(`person ${personId} is already in family ${familyId}`);
    this.name = 'AlreadyInFamilyError';
  }
}

export const FAMILY_PAGE_SIZE = { default: 25, max: 100 } as const;

/**
 * Households.
 *
 * Membership is many-to-many. A person belongs to more than one family after a remarriage,
 * and an adult child appears in both their parents' household and their own; modelling it
 * as a column on `person` would make the platform pick one, which is a real pastoral
 * problem rather than a data-modelling nicety.
 *
 * **A relationship here is not an authorisation.** `parent` or `guardian` on a family member
 * says who is related, never who may collect a child at check-in — that is an explicit
 * `GuardianAuthorisation` owned by the children's check-in module (docs/02 §5). A custody
 * order routinely leaves a parent on this list and off that one, so nothing in this file
 * exposes a helper that could be mistaken for the other question.
 */
export class FamilyService {
  private readonly repository = new FamilyRepository();

  async list(
    tx: TenantTransaction,
    subject: Subject,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<Family>> {
    assertCan(subject, CORE_PERMISSIONS.person_read);
    const limit = Math.min(options.limit ?? FAMILY_PAGE_SIZE.default, FAMILY_PAGE_SIZE.max);
    const after = decodeCursor(options.cursor);

    const { rows } = await tx.query<FamilyRow>(
      `SELECT id, church_id, name, created_at, updated_at
         FROM family
        ${after ? 'WHERE (lower(name), id) > ($2, $3)' : ''}
        ORDER BY lower(name), id
        LIMIT $1`,
      after ? [limit + 1, after.name, after.id] : [limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    // Members are deliberately absent from a list: a directory of two hundred households
    // would otherwise embed every person in the church, several times over.
    return {
      data: page.map((row) => toFamily(row)),
      ...(hasMore && last
        ? { nextCursor: encodeCursor({ name: last.name.toLowerCase(), id: last.id }) }
        : {}),
    };
  }

  /** One family with its members, each carrying the person, so a household renders in one call. */
  async get(tx: TenantTransaction, subject: Subject, familyId: string): Promise<Family> {
    assertCan(subject, CORE_PERMISSIONS.person_read);
    const row = await this.repository.findById(tx, familyId);
    if (!row) throw new FamilyNotFoundError(familyId);
    return toFamily(row, await this.membersOf(tx, familyId));
  }

  async create(tx: TenantTransaction, subject: Subject, input: FamilyCreate): Promise<Family> {
    assertCan(subject, CORE_PERMISSIONS.person_manage);
    const row = await this.repository.insert(tx, { name: input.name });

    for (const member of input.members ?? []) {
      await this.addMemberRow(tx, row.id, member);
    }

    const family = toFamily(row, await this.membersOf(tx, row.id));
    await new AuditService(tx).record({
      action: 'family.created',
      resourceType: 'family',
      resourceId: family.id,
      after: { name: family.name, memberCount: family.members?.length ?? 0 },
    });
    return family;
  }

  async rename(
    tx: TenantTransaction,
    subject: Subject,
    familyId: string,
    name: string,
  ): Promise<Family> {
    assertCan(subject, CORE_PERMISSIONS.person_manage);
    const before = await this.get(tx, subject, familyId);
    const row = await this.repository.update(tx, familyId, { name });
    if (!row) throw new FamilyNotFoundError(familyId);

    await new AuditService(tx).record({
      action: 'family.renamed',
      resourceType: 'family',
      resourceId: familyId,
      before: { name: before.name },
      after: { name },
    });
    return toFamily(row, before.members);
  }

  async addMember(
    tx: TenantTransaction,
    subject: Subject,
    familyId: string,
    input: FamilyMemberCreate,
  ): Promise<FamilyMember> {
    assertCan(subject, CORE_PERMISSIONS.person_manage);
    // Existence first, so adding to a family that is not ours reads as "no such family"
    // rather than as a foreign-key error naming a table.
    await this.get(tx, subject, familyId);

    const row = await this.addMemberRow(tx, familyId, input);
    await new AuditService(tx).record({
      action: 'family.member_added',
      resourceType: 'family',
      resourceId: familyId,
      after: { personId: input.personId, relationship: input.relationship },
    });
    return toFamilyMember(row);
  }

  async removeMember(
    tx: TenantTransaction,
    subject: Subject,
    familyId: string,
    personId: string,
  ): Promise<void> {
    assertCan(subject, CORE_PERMISSIONS.person_manage);
    await this.get(tx, subject, familyId);

    const { rowCount } = await tx.query(
      'DELETE FROM family_member WHERE family_id = $1 AND person_id = $2',
      [familyId, personId],
    );
    if ((rowCount ?? 0) === 0) throw new FamilyNotFoundError(`${familyId}/${personId}`);

    await new AuditService(tx).record({
      action: 'family.member_removed',
      resourceType: 'family',
      resourceId: familyId,
      before: { personId },
    });
  }

  /** Every household a person belongs to — plural, and that is the point. */
  async familiesOf(tx: TenantTransaction, subject: Subject, personId: string): Promise<Family[]> {
    assertCan(subject, CORE_PERMISSIONS.person_read);
    const { rows } = await tx.query<FamilyRow>(
      `SELECT f.id, f.church_id, f.name, f.created_at, f.updated_at
         FROM family f
         JOIN family_member m ON m.family_id = f.id
        WHERE m.person_id = $1
        ORDER BY lower(f.name), f.id`,
      [personId],
    );
    return rows.map((row) => toFamily(row));
  }

  private async addMemberRow(
    tx: TenantTransaction,
    familyId: string,
    input: FamilyMemberCreate,
  ): Promise<FamilyMemberRow> {
    const { churchId } = currentTenant('FamilyService.addMember');
    const existing = await tx.query(
      'SELECT 1 FROM family_member WHERE family_id = $1 AND person_id = $2',
      [familyId, input.personId],
    );
    if ((existing.rowCount ?? 0) > 0) throw new AlreadyInFamilyError(input.personId, familyId);

    const { rows } = await tx.query<FamilyMemberRow>(
      `INSERT INTO family_member (church_id, family_id, person_id, relationship)
       VALUES ($1, $2, $3, $4)
       RETURNING id, family_id, person_id, relationship, created_at`,
      [churchId, familyId, input.personId, input.relationship],
    );
    return rows[0]!;
  }

  private async membersOf(tx: TenantTransaction, familyId: string): Promise<FamilyMember[]> {
    const { rows } = await tx.query<FamilyMemberRow & { person: PersonRow | null }>(
      `SELECT m.id, m.family_id, m.person_id, m.relationship, m.created_at,
              to_jsonb(p.*) AS person
         FROM family_member m
         JOIN person p ON p.id = m.person_id
        WHERE m.family_id = $1
        ORDER BY p.last_name, p.first_name, m.id`,
      [familyId],
    );
    return rows.map((row) =>
      toFamilyMember(row, row.person ? toPerson(hydrate(row.person)) : undefined),
    );
  }
}

/**
 * `to_jsonb` gives back strings where the driver would have given Dates, because JSON has
 * no date type. Rehydrating them here keeps one mapping function for both paths instead of
 * two that can disagree about what a birthday is.
 */
function hydrate(row: PersonRow): PersonRow {
  return {
    ...row,
    archived_at: row.archived_at ? new Date(row.archived_at) : null,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}
