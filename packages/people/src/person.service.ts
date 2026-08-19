import type {
  MembershipStatusChange,
  Milestone,
  MilestoneCreate,
  Person,
  PersonCreate,
  PersonUpdate,
} from '@church/contracts';
import { AuditService } from '@church/audit';
import { type Page, decodeCursor, encodeCursor } from '@church/church';
import { CORE_PERMISSIONS, type Subject, assertCan, campusScopeOf } from '@church/policy';
import { TenantRepository, type TenantTransaction, currentTenant } from '@church/tenancy';
import {
  type MilestoneRow,
  type PersonRow,
  type StatusChangeRow,
  toMilestone,
  toPerson,
  toStatusChange,
} from './mapping.js';

class PersonRepository extends TenantRepository<PersonRow> {
  protected readonly table = 'person';
}

export class PersonNotFoundError extends Error {
  constructor(id: string) {
    super(`no person with id ${id}`);
    this.name = 'PersonNotFoundError';
  }
}

export const PERSON_PAGE_SIZE = { default: 25, max: 100 } as const;

export interface ListPeopleOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: Person['status'];
  readonly campusId?: string;
  readonly includeArchived?: boolean;
}

/**
 * People — the platform's central record.
 *
 * A Person is not a login. Children and visitors are Person records with no account at all,
 * so nothing here may assume a `User` exists for one, and no method takes a user id where it
 * means a person.
 */
export class PersonService {
  private readonly repository = new PersonRepository();

  /**
   * A page of people, by surname.
   *
   * Archived people are excluded unless asked for: a directory that lists people who have
   * left is a directory nobody trusts, and the ones who left are exactly the entries a
   * volunteer would act on by mistake.
   */
  async list(
    tx: TenantTransaction,
    subject: Subject,
    options: ListPeopleOptions = {},
  ): Promise<Page<Person>> {
    assertCan(subject, CORE_PERMISSIONS.person_read);
    const limit = Math.min(options.limit ?? PERSON_PAGE_SIZE.default, PERSON_PAGE_SIZE.max);
    const after = decodeCursor(options.cursor);

    // A campus admin's confinement has to be applied here, because the engine compares one
    // resource at a time and a listing presents it none — so without this the broad
    // `person:read` check above is the only thing standing between them and every record
    // in the church, which is not what the role means.
    //
    // Naming someone else's campus is refused rather than quietly narrowed: silently
    // returning their own campus would answer a question they did not ask and hide that
    // they were denied.
    const confinedTo = campusScopeOf(subject);
    if (confinedTo && options.campusId && options.campusId !== confinedTo) {
      assertCan(subject, CORE_PERMISSIONS.person_read, {
        type: 'person',
        churchId: subject.churchId,
        campusId: options.campusId,
      });
    }
    const campusId = confinedTo ?? options.campusId;

    const where: string[] = [];
    const values: unknown[] = [limit + 1];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      where.push(clause.replace('?', `$${values.length}`));
    };

    if (options.includeArchived !== true) where.push('archived_at IS NULL');
    if (options.status) add('status = ?', options.status);
    if (campusId) add('campus_id = ?', campusId);
    if (after) {
      values.push(after.name, after.id);
      where.push(`(lower(last_name), id) > ($${values.length - 1}, $${values.length})`);
    }

    const { rows } = await tx.query<PersonRow>(
      `SELECT * FROM person
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY lower(last_name), id
        LIMIT $1`,
      values,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map(toPerson),
      ...(hasMore && last
        ? { nextCursor: encodeCursor({ name: last.last_name.toLowerCase(), id: last.id }) }
        : {}),
    };
  }

  async get(tx: TenantTransaction, subject: Subject, personId: string): Promise<Person> {
    const row = await this.repository.findById(tx, personId);
    if (!row) throw new PersonNotFoundError(personId);
    // Resource-level: `person:read_self` lets a member read their own record and no one
    // else's, which the engine can only decide once it has the row.
    assertCan(subject, CORE_PERMISSIONS.person_read, {
      type: 'person',
      churchId: row.church_id,
      personId: row.id,
      ...(row.campus_id ? { campusId: row.campus_id } : {}),
    });
    return toPerson(row);
  }

  async create(tx: TenantTransaction, subject: Subject, input: PersonCreate): Promise<Person> {
    // A campus admin creating a person with no campus named gets their own, rather than an
    // unassigned record they would immediately be unable to see. Naming another campus is
    // a write outside their reach and is refused.
    const campusId = input.campusId ?? campusScopeOf(subject) ?? null;
    assertCan(subject, CORE_PERMISSIONS.person_manage, {
      type: 'person',
      churchId: subject.churchId,
      ...(campusId ? { campusId } : {}),
    });
    const { userId } = currentTenant('PersonService.create');

    const row = await this.repository.insert(tx, {
      campus_id: campusId,
      first_name: input.firstName,
      last_name: input.lastName,
      preferred_name: input.preferredName ?? null,
      gender: input.gender ?? null,
      date_of_birth: input.dateOfBirth ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address_line1: input.address?.line1 ?? null,
      address_line2: input.address?.line2 ?? null,
      city: input.address?.city ?? null,
      region: input.address?.region ?? null,
      postal_code: input.address?.postalCode ?? null,
      country: input.address?.country ?? null,
      photo_url: input.photoUrl ?? null,
      status: input.status ?? 'visitor',
    });

    // The first history entry, written with the person. A membership history that starts
    // at the first *change* cannot say how someone arrived, which is half of what a church
    // wants it for.
    await this.appendHistory(tx, row.id, row.status, userId, 'record created');

    const person = toPerson(row);
    await new AuditService(tx).record({
      action: 'person.created',
      resourceType: 'person',
      resourceId: person.id,
      after: { ...person },
    });
    return person;
  }

  /**
   * Updates a person's details.
   *
   * Not status, and not archival. Status moves only through `changeStatus`, which appends
   * to the history in the same transaction; allowing it here would let a caller rewrite
   * someone's standing with no record of who did it or why.
   */
  async update(
    tx: TenantTransaction,
    subject: Subject,
    personId: string,
    changes: PersonUpdate,
  ): Promise<Person> {
    const before = await this.get(tx, subject, personId);
    assertCan(subject, CORE_PERMISSIONS.person_manage, {
      type: 'person',
      churchId: before.churchId,
      personId,
      ...(before.campusId ? { campusId: before.campusId } : {}),
    });

    // Moving a record is a write to where it lands as well as where it left, and only the
    // first of those is the record we just checked.
    if (changes.campusId != null && changes.campusId !== before.campusId) {
      assertCan(subject, CORE_PERMISSIONS.person_manage, {
        type: 'person',
        churchId: before.churchId,
        campusId: changes.campusId,
      });
    }

    const patch: Record<string, unknown> = {};
    const set = (column: string, value: unknown) => {
      if (value !== undefined) patch[column] = value;
    };
    set('campus_id', changes.campusId);
    set('first_name', changes.firstName);
    set('last_name', changes.lastName);
    set('preferred_name', changes.preferredName);
    set('gender', changes.gender);
    set('date_of_birth', changes.dateOfBirth);
    set('email', changes.email);
    set('phone', changes.phone);
    set('photo_url', changes.photoUrl);
    if (changes.address !== undefined) {
      set('address_line1', changes.address.line1 ?? null);
      set('address_line2', changes.address.line2 ?? null);
      set('city', changes.address.city ?? null);
      set('region', changes.address.region ?? null);
      set('postal_code', changes.address.postalCode ?? null);
      set('country', changes.address.country ?? null);
    }
    if (Object.keys(patch).length === 0) return before;

    const row = await this.repository.update(tx, personId, patch);
    if (!row) throw new PersonNotFoundError(personId);
    const after = toPerson(row);

    await new AuditService(tx).record({
      action: 'person.updated',
      resourceType: 'person',
      resourceId: personId,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }

  /**
   * Archives rather than deletes.
   *
   * Giving and attendance history reference people, and a hard delete would silently
   * rewrite the past — a church's giving report for last year would change because someone
   * tidied the directory this year. Erasure is a separate, deliberate request under the
   * data-privacy workflow.
   */
  async archive(tx: TenantTransaction, subject: Subject, personId: string): Promise<void> {
    const before = await this.get(tx, subject, personId);
    assertCan(subject, CORE_PERMISSIONS.person_manage, {
      type: 'person',
      churchId: before.churchId,
      personId,
    });
    if (before.archivedAt) return;

    await this.repository.update(tx, personId, { archived_at: new Date() });
    await new AuditService(tx).record({
      action: 'person.archived',
      resourceType: 'person',
      resourceId: personId,
      before: { archivedAt: null },
      after: { archivedAt: new Date().toISOString() },
    });
  }

  async history(
    tx: TenantTransaction,
    subject: Subject,
    personId: string,
  ): Promise<MembershipStatusChange[]> {
    await this.get(tx, subject, personId);
    const { rows } = await tx.query<StatusChangeRow>(
      `SELECT id, person_id, status, changed_at, changed_by, note
         FROM membership_status_history
        WHERE person_id = $1
        ORDER BY changed_at DESC, id DESC`,
      [personId],
    );
    return rows.map(toStatusChange);
  }

  /**
   * Records a change of standing.
   *
   * The history row and the denormalised `person.status` are written in one transaction,
   * because two sources of truth that can disagree will.
   */
  async changeStatus(
    tx: TenantTransaction,
    subject: Subject,
    personId: string,
    status: Person['status'],
    note?: string,
  ): Promise<MembershipStatusChange> {
    const before = await this.get(tx, subject, personId);
    assertCan(subject, CORE_PERMISSIONS.person_manage, {
      type: 'person',
      churchId: before.churchId,
      personId,
    });
    const { userId } = currentTenant('PersonService.changeStatus');

    const entry = await this.appendHistory(tx, personId, status, userId, note);
    await this.repository.update(tx, personId, { status });

    await new AuditService(tx).record({
      action: 'person.status_changed',
      resourceType: 'person',
      resourceId: personId,
      before: { status: before.status },
      after: { status },
      ...(note ? { reason: note } : {}),
    });
    return entry;
  }

  async milestones(
    tx: TenantTransaction,
    subject: Subject,
    personId: string,
  ): Promise<Milestone[]> {
    await this.get(tx, subject, personId);
    const { rows } = await tx.query<MilestoneRow>(
      `SELECT * FROM milestone WHERE person_id = $1 ORDER BY occurred_on DESC, id DESC`,
      [personId],
    );
    return rows.map(toMilestone);
  }

  async recordMilestone(
    tx: TenantTransaction,
    subject: Subject,
    personId: string,
    input: MilestoneCreate,
  ): Promise<Milestone> {
    const person = await this.get(tx, subject, personId);
    assertCan(subject, CORE_PERMISSIONS.person_manage, {
      type: 'person',
      churchId: person.churchId,
      personId,
      ...(person.campusId ? { campusId: person.campusId } : {}),
    });

    // A milestone carries its own campus — where the baptism happened, not where the
    // person is filed — so it needs checking in its own right.
    const milestoneCampus = input.campusId ?? campusScopeOf(subject) ?? null;
    if (milestoneCampus && milestoneCampus !== person.campusId) {
      assertCan(subject, CORE_PERMISSIONS.person_manage, {
        type: 'person',
        churchId: person.churchId,
        campusId: milestoneCampus,
      });
    }

    const { churchId } = currentTenant('PersonService.recordMilestone');
    const { rows } = await tx.query<MilestoneRow>(
      `INSERT INTO milestone (church_id, person_id, campus_id, type, occurred_on, officiant, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        churchId,
        personId,
        milestoneCampus,
        input.type,
        input.occurredOn,
        input.officiant ?? null,
        input.notes ?? null,
      ],
    );
    const milestone = toMilestone(rows[0]!);

    await new AuditService(tx).record({
      action: 'milestone.recorded',
      resourceType: 'milestone',
      resourceId: milestone.id,
      after: { ...milestone },
    });
    return milestone;
  }

  private async appendHistory(
    tx: TenantTransaction,
    personId: string,
    status: Person['status'],
    changedBy: string | undefined,
    note?: string,
  ): Promise<MembershipStatusChange> {
    const { churchId } = currentTenant('PersonService.appendHistory');
    const { rows } = await tx.query<StatusChangeRow>(
      `INSERT INTO membership_status_history (church_id, person_id, status, changed_by, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, person_id, status, changed_at, changed_by, note`,
      [churchId, personId, status, changedBy ?? null, note ?? null],
    );
    return toStatusChange(rows[0]!);
  }
}
