import { currentTenant, tryCurrentTenant } from '@church/tenancy';
import { changedFields, redact } from './redact.js';

export type Sensitivity = 'standard' | 'restricted';

export interface AuditRecord {
  /** Dotted and past tense: `module.enabled`, `person.updated`, `medical_note.read`. */
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly campusId?: string;
  readonly sensitivity?: Sensitivity;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
  readonly reason?: string;
  readonly requestId?: string;
  /**
   * Overrides the actor from the ambient tenant context. Used for platform actions with no
   * human behind them, and for the login path, where the actor is known before there is a
   * request context to read them from.
   */
  readonly actor?: { userId?: string; roles?: readonly string[] };
}

export interface AuditEntry {
  readonly id: string;
  /** Total order across the log. The cursor for the next page. */
  readonly seq: string;
  readonly occurredAt: string;
  readonly actorUserId: string | null;
  readonly actorRoles: string[];
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly campusId: string | null;
  readonly sensitivity: Sensitivity;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly changedFields: string[];
  readonly reason: string | null;
  readonly requestId: string | null;
}

export interface AuditQuery {
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly actorUserId?: string;
  readonly sensitivity?: Sensitivity;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit?: number;
  /** Cursor: the `seq` of the last entry on the previous page. */
  readonly beforeSeq?: string;
}

/** The slice of a client this needs, so a transaction or a pool client both fit. */
export interface QueryLike {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export const AUDIT_PAGE_SIZE = { default: 50, max: 200 } as const;

/**
 * Writes and reads the audit log.
 *
 * `record` takes the caller's transaction rather than opening its own, and that is the
 * whole design. An audit entry written on a separate connection can commit while the work
 * it describes rolls back — producing a log that says a thing happened which did not — or
 * be lost while the work commits, which is worse. Sharing the transaction makes the entry
 * and the change atomic: both or neither.
 */
export class AuditService {
  constructor(private readonly query: QueryLike) {}

  async record(entry: AuditRecord): Promise<void> {
    const context = tryCurrentTenant();
    const churchId = context?.churchId;
    if (!churchId) {
      // Deliberately loud. A silent no-op here would mean actions vanishing from the log
      // exactly when the tenant context is wrong, which is when the log matters most.
      throw new MissingAuditContextError(entry.action);
    }

    const actorUserId = entry.actor?.userId ?? context?.userId ?? null;
    const actorRoles = entry.actor?.roles ?? context?.roles ?? [];
    const before = entry.before ? (redact(entry.before) as Record<string, unknown>) : null;
    const after = entry.after ? (redact(entry.after) as Record<string, unknown>) : null;

    await this.query.query(
      `INSERT INTO audit_entry
         (church_id, actor_user_id, actor_roles, action, resource_type, resource_id,
          campus_id, sensitivity, before, after, changed_fields, reason, request_id)
       VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::text[], $12, $13)`,
      [
        churchId,
        actorUserId,
        [...actorRoles],
        entry.action,
        entry.resourceType,
        entry.resourceId ?? null,
        entry.campusId ?? null,
        entry.sensitivity ?? 'standard',
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        changedFields(entry.before, entry.after),
        entry.reason ?? null,
        entry.requestId ?? null,
      ],
    );
  }

  /**
   * Most recent first, which is the order an investigation reads in.
   *
   * Paginated by `seq` rather than by offset or timestamp. An offset shifts under a reader
   * as the log grows at the head, so an entry slips past unseen; a timestamp cursor has the
   * same problem for a different reason, since entries written in one transaction share one
   * timestamp exactly.
   */
  async list(filters: AuditQuery = {}): Promise<AuditEntry[]> {
    currentTenant();
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      where.push(clause.replace('?', `$${values.length}`));
    };

    if (filters.action) add('action = ?', filters.action);
    if (filters.resourceType) add('resource_type = ?', filters.resourceType);
    if (filters.resourceId) add('resource_id = ?', filters.resourceId);
    if (filters.actorUserId) add('actor_user_id = ?', filters.actorUserId);
    if (filters.sensitivity) add('sensitivity = ?', filters.sensitivity);
    if (filters.since) add('occurred_at >= ?', filters.since);
    if (filters.until) add('occurred_at <= ?', filters.until);
    if (filters.beforeSeq !== undefined) add('seq < ?', filters.beforeSeq);

    const limit = Math.min(filters.limit ?? AUDIT_PAGE_SIZE.default, AUDIT_PAGE_SIZE.max);
    values.push(limit);

    const { rows } = await this.query.query<AuditRow>(
      `SELECT id, seq, occurred_at, actor_user_id, actor_roles, action, resource_type, resource_id,
              campus_id, sensitivity, before, after, changed_fields, reason, request_id
         FROM audit_entry
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY seq DESC
        LIMIT $${values.length}`,
      values,
    );
    return rows.map(toEntry);
  }
}

interface AuditRow extends Record<string, unknown> {
  id: string;
  seq: string;
  occurred_at: Date;
  actor_user_id: string | null;
  actor_roles: string[];
  action: string;
  resource_type: string;
  resource_id: string | null;
  campus_id: string | null;
  sensitivity: Sensitivity;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changed_fields: string[];
  reason: string | null;
  request_id: string | null;
}

const toEntry = (row: AuditRow): AuditEntry => ({
  id: row.id,
  seq: String(row.seq),
  occurredAt: row.occurred_at.toISOString(),
  actorUserId: row.actor_user_id,
  actorRoles: row.actor_roles,
  action: row.action,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  campusId: row.campus_id,
  sensitivity: row.sensitivity,
  before: row.before,
  after: row.after,
  changedFields: row.changed_fields,
  reason: row.reason,
  requestId: row.request_id,
});

export class MissingAuditContextError extends Error {
  constructor(action: string) {
    super(
      `cannot audit "${action}" with no tenant context. Audit entries are written inside ` +
        'the transaction that performs the work — see packages/audit/README.md.',
    );
    this.name = 'MissingAuditContextError';
  }
}
