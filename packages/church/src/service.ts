import type { Campus, CampusCreate, CampusUpdate, Church, ChurchUpdate } from '@church/contracts';
import { AuditService } from '@church/audit';
import {
  CORE_PERMISSIONS,
  ForbiddenError,
  type Subject,
  assertCan,
  campusScopeOf,
} from '@church/policy';
import { TenantRepository, currentTenant, type TenantTransaction } from '@church/tenancy';
import { decodeCursor, encodeCursor } from './cursor.js';

/** Rows as the database holds them. snake_case stops at this file's boundary. */
interface ChurchRow {
  id: string;
  name: string;
  country: string;
  timezone: string;
  status: Church['status'];
  plan: string;
  created_at: Date;
}

interface CampusRow {
  id: string;
  church_id: string;
  name: string;
  timezone: string | null;
  is_primary: boolean;
  created_at: Date;
}

class CampusRepository extends TenantRepository<CampusRow> {
  protected readonly table = 'campus';
}

export class NotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`no ${what} with id ${id}`);
    this.name = 'NotFoundError';
  }
}

export class LastCampusError extends Error {
  constructor() {
    super('a church must keep at least one campus');
    this.name = 'LastCampusError';
  }
}

export interface Page<T> {
  readonly data: T[];
  readonly nextCursor?: string;
}

export const CAMPUS_PAGE_SIZE = { default: 25, max: 100 } as const;

/**
 * Church and campus, the two records every other feature hangs off.
 *
 * Both services take the caller's `Subject` and check it before acting. The guard in
 * `apps/api` has already checked that the caller may perform the operation at all; these
 * checks are the resource-level half — the one that needs the row, which the guard does not
 * have. Doing it here rather than in the controller means a future worker or job gets the
 * same answer as an HTTP request.
 */
export class ChurchService {
  /**
   * The caller's own church. There is no "get church by id" — the id comes from the token,
   * and a church can only ever read itself. A path parameter naming a church is for routing
   * and validation, never for scoping.
   */
  async get(tx: TenantTransaction, subject: Subject): Promise<Church> {
    assertCan(subject, CORE_PERMISSIONS.church_read);
    const { churchId } = currentTenant('ChurchService.get');
    const { rows } = await tx.query<ChurchRow>(
      'SELECT id, name, country, timezone, status, plan, created_at FROM church WHERE id = $1',
      [churchId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('church', churchId);
    return toChurch(row);
  }

  /**
   * Updates the church's own details.
   *
   * `status` and `plan` are not accepted, matching `ChurchUpdate` in the contract: a church
   * lifting its own suspension or promoting its own plan would be a billing bypass, and
   * both are owned elsewhere.
   */
  async update(tx: TenantTransaction, subject: Subject, changes: ChurchUpdate): Promise<Church> {
    assertCan(subject, CORE_PERMISSIONS.church_manage);
    const { churchId } = currentTenant('ChurchService.update');

    const before = await this.get(tx, subject);
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (changes.name !== undefined) set('name', changes.name);
    if (changes.country !== undefined) set('country', changes.country.toUpperCase());
    if (changes.timezone !== undefined) set('timezone', changes.timezone);
    if (fields.length === 0) return before;

    values.push(churchId);
    const { rows } = await tx.query<ChurchRow>(
      `UPDATE church SET ${fields.join(', ')}, updated_at = now()
        WHERE id = $${values.length}
        RETURNING id, name, country, timezone, status, plan, created_at`,
      values,
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('church', churchId);
    const after = toChurch(row);

    await new AuditService(tx).record({
      action: 'church.updated',
      resourceType: 'church',
      resourceId: churchId,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }
}

export class CampusService {
  private readonly repository = new CampusRepository();

  /**
   * Campuses, alphabetically, keyset-paginated.
   *
   * Sorted by (name, id) rather than name alone: two campuses may share a name — a church
   * that opens "North" in two towns is not doing anything wrong — and a cursor over a
   * non-unique key either repeats a row or skips one.
   */
  async list(
    tx: TenantTransaction,
    subject: Subject,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<Campus>> {
    assertCan(subject, CORE_PERMISSIONS.campus_read);
    const limit = Math.min(options.limit ?? CAMPUS_PAGE_SIZE.default, CAMPUS_PAGE_SIZE.max);
    const after = decodeCursor(options.cursor);

    const { rows } = await tx.query<CampusRow>(
      `SELECT id, church_id, name, timezone, is_primary, created_at
         FROM campus
        ${after ? 'WHERE (name, id) > ($2, $3)' : ''}
        ORDER BY name, id
        LIMIT $1`,
      after ? [limit + 1, after.name, after.id] : [limit + 1],
    );

    // One row more than asked for, so "is there another page?" is answered by looking
    // rather than by guessing from a count that may have changed.
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map(toCampus),
      ...(hasMore && last ? { nextCursor: encodeCursor({ name: last.name, id: last.id }) } : {}),
    };
  }

  async get(tx: TenantTransaction, subject: Subject, campusId: string): Promise<Campus> {
    assertCan(subject, CORE_PERMISSIONS.campus_read);
    const row = await this.repository.findById(tx, campusId);
    // RLS has already limited this to the caller's church, so a miss means "not here" and
    // is reported the same way whether the campus belongs to someone else or to nobody.
    if (!row) throw new NotFoundError('campus', campusId);
    assertCan(subject, CORE_PERMISSIONS.campus_read, {
      type: 'campus',
      churchId: row.church_id,
      campusId: row.id,
    });
    return toCampus(row);
  }

  async create(tx: TenantTransaction, subject: Subject, input: CampusCreate): Promise<Campus> {
    assertCan(subject, CORE_PERMISSIONS.campus_manage);

    // A campus that does not exist yet has no id for the engine's campus rule to compare
    // against, so this is the one campus operation it cannot decide. Updating and removing
    // are already confined — both read the row first, and that read is scoped — but
    // creating would otherwise let an administrator trusted with one site add another and
    // then not administer it. Opening a site is a church-wide act.
    if (campusScopeOf(subject)) {
      throw new ForbiddenError(CORE_PERMISSIONS.campus_manage, {
        allowed: false,
        rule: 'campus_scope',
        detail: 'a new campus',
      });
    }

    const row = await this.repository.insert(tx, {
      name: input.name,
      timezone: input.timezone ?? null,
      is_primary: input.isPrimary ?? false,
    });
    if (input.isPrimary === true) await this.demoteOthers(tx, row.id);

    const campus = toCampus(row);
    await new AuditService(tx).record({
      action: 'campus.created',
      resourceType: 'campus',
      resourceId: campus.id,
      after: { ...campus },
    });
    return campus;
  }

  async update(
    tx: TenantTransaction,
    subject: Subject,
    campusId: string,
    changes: CampusUpdate,
  ): Promise<Campus> {
    assertCan(subject, CORE_PERMISSIONS.campus_manage);
    const before = await this.get(tx, subject, campusId);

    const patch: Record<string, unknown> = {};
    if (changes.name !== undefined) patch['name'] = changes.name;
    if (changes.timezone !== undefined) patch['timezone'] = changes.timezone;
    if (changes.isPrimary !== undefined) patch['is_primary'] = changes.isPrimary;
    if (Object.keys(patch).length === 0) return before;

    const row = await this.repository.update(tx, campusId, patch);
    if (!row) throw new NotFoundError('campus', campusId);
    if (changes.isPrimary === true) await this.demoteOthers(tx, campusId);

    const after = toCampus(row);
    await new AuditService(tx).record({
      action: 'campus.updated',
      resourceType: 'campus',
      resourceId: campusId,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }

  /**
   * Removes a campus.
   *
   * Refuses the last one. Every person, event and attendance record can name a campus, and
   * a church with none leaves all of them pointing at nothing — a state with no screen to
   * fix it from. Refusing is a worse afternoon for one administrator and a better outcome
   * than the alternative.
   */
  async remove(tx: TenantTransaction, subject: Subject, campusId: string): Promise<void> {
    assertCan(subject, CORE_PERMISSIONS.campus_manage);
    const before = await this.get(tx, subject, campusId);

    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM campus',
    );
    if (Number(rows[0]?.count ?? 0) <= 1) throw new LastCampusError();

    const deleted = await this.repository.deleteById(tx, campusId);
    if (deleted === 0) throw new NotFoundError('campus', campusId);

    await new AuditService(tx).record({
      action: 'campus.deleted',
      resourceType: 'campus',
      resourceId: campusId,
      before: { ...before },
    });
  }

  /** One primary campus per church. Setting a new one steps the old one down. */
  private async demoteOthers(tx: TenantTransaction, keepId: string): Promise<void> {
    await tx.query('UPDATE campus SET is_primary = false WHERE id <> $1 AND is_primary', [keepId]);
  }
}

const toChurch = (row: ChurchRow): Church => ({
  id: row.id,
  name: row.name,
  country: row.country,
  timezone: row.timezone,
  status: row.status,
  createdAt: row.created_at.toISOString(),
});

const toCampus = (row: CampusRow): Campus => ({
  id: row.id,
  churchId: row.church_id,
  name: row.name,
  ...(row.timezone ? { timezone: row.timezone } : {}),
  isPrimary: row.is_primary,
  createdAt: row.created_at.toISOString(),
});
