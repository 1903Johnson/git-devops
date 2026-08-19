import type { ModuleManifest } from './manifest.js';
import type { QueryLike } from './registry.js';

/**
 * Deleting a church's module data. The one operation in this codebase that destroys
 * something, so it is written as a series of refusals with a delete at the end.
 *
 * Every check below exists because of a specific way this could go wrong, and each one
 * fails the purge rather than narrowing it. A purge that half-runs leaves a church with
 * some of its data gone and a `purged` marker saying it all is — worse than one that
 * refuses and pages someone.
 */

export interface PurgeTable {
  readonly table: string;
  readonly rows: number;
}

export interface PurgePlan {
  readonly moduleKey: string;
  readonly churchId: string;
  readonly tables: PurgeTable[];
  readonly totalRows: number;
  /** Data classes the manifest holds back from deletion. Non-empty means the purge stops. */
  readonly legalHoldClasses: string[];
}

export class PurgeRefusedError extends Error {
  constructor(
    readonly code:
      | 'UNKNOWN_MODULE'
      | 'NOT_DUE'
      | 'STILL_ENABLED'
      | 'TABLE_NOT_TENANT_SCOPED'
      | 'LEGAL_HOLD_UNSUPPORTED'
      | 'ALREADY_PURGED',
    message: string,
  ) {
    super(message);
    this.name = 'PurgeRefusedError';
  }
}

/** `mod_<key>_` — the prefix boundary rule C4 exists to guarantee. */
export const tablePrefixFor = (moduleKey: string): string => `mod_${moduleKey}_`;

export interface TableRow extends Record<string, unknown> {
  table_name: string;
  has_church_id: boolean;
  /** Tables in this module that this one references. Deleted after those reference it. */
  parents: string[];
}

/**
 * The module's tables, ordered so a child is always deleted before its parent.
 *
 * A topological sort rather than a count of dependants. Counting looks equivalent on two
 * tables and breaks on a chain: with a -> b -> c, both b and c are "parent of one" and the
 * tie is resolved arbitrarily, so roughly half the time the delete fails partway through
 * with a foreign-key violation and the module is left half-purged.
 *
 * Tables outside the module are not consulted, because core may never reference a module
 * table (docs/01 §2). If that rule is ever broken, this purge is where it surfaces — as a
 * foreign-key violation that aborts the transaction, not as silent corruption.
 */
export async function purgeTables(query: QueryLike, moduleKey: string): Promise<TableRow[]> {
  const { rows } = await query.query<TableRow>(
    `WITH module_tables AS (
       SELECT c.oid, c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE $1
     )
     SELECT t.table_name,
            EXISTS (
              SELECT 1 FROM information_schema.columns col
               WHERE col.table_name = t.table_name AND col.column_name = 'church_id'
            ) AS has_church_id,
            COALESCE((
              SELECT array_agg(DISTINCT parent.table_name)
                FROM pg_constraint con
                JOIN module_tables parent ON parent.oid = con.confrelid
               WHERE con.contype = 'f'
                 AND con.conrelid = t.oid
                 AND con.conrelid <> con.confrelid
            ), '{}') AS parents
       FROM module_tables t
      ORDER BY t.table_name`,
    [`${tablePrefixFor(moduleKey)}%`],
  );
  return orderForDelete(rows);
}

/**
 * Children first, parents last. A cycle between two module tables is not resolvable and is
 * reported rather than guessed at — a self-referencing table is fine, since a row deleted
 * in the same statement as its parent is not a violation.
 */
export function orderForDelete(tables: readonly TableRow[]): TableRow[] {
  const byName = new Map(tables.map((table) => [table.table_name, table]));
  const ordered: TableRow[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (name: string, trail: string[]): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      throw new PurgeRefusedError(
        'TABLE_NOT_TENANT_SCOPED',
        `circular foreign keys between module tables: ${[...trail, name].join(' -> ')}`,
      );
    }
    state.set(name, 'visiting');
    // Anything that references this table must be deleted before it, so visit dependants
    // first: they end up earlier in the output.
    for (const other of tables) {
      if (other.table_name !== name && other.parents.includes(name)) {
        visit(other.table_name, [...trail, name]);
      }
    }
    state.set(name, 'done');
    const table = byName.get(name);
    if (table) ordered.push(table);
  };

  for (const table of tables) visit(table.table_name, []);
  return ordered;
}

/**
 * What a purge would delete, without deleting it.
 *
 * Always run before the real thing, and exposed so an operator can look at the numbers
 * first. A purge is not reversible and a preview costs one query per table.
 */
export async function planPurge(
  query: QueryLike,
  manifest: ModuleManifest,
  churchId: string,
): Promise<PurgePlan> {
  const tables = await purgeTables(query, manifest.key);
  const counted: PurgeTable[] = [];

  for (const table of tables) {
    if (!table.has_church_id) {
      // The most dangerous shape this code could meet: a module table with no tenant
      // column. There is no correct WHERE clause for it, and the incorrect one deletes
      // every church's rows. Boundary rule C5 forbids it; this refuses to trust that.
      throw new PurgeRefusedError(
        'TABLE_NOT_TENANT_SCOPED',
        `${table.table_name} has no church_id column, so it cannot be purged for one church`,
      );
    }
    const { rows } = await query.query<{ count: string }>(
      // The table name comes from pg_class filtered by a parameterised LIKE, never from a
      // caller, so it cannot carry an injection.
      `SELECT count(*)::text AS count FROM "${table.table_name}" WHERE church_id = $1`,
      [churchId],
    );
    counted.push({ table: table.table_name, rows: Number(rows[0]?.count ?? 0) });
  }

  return {
    moduleKey: manifest.key,
    churchId,
    tables: counted,
    totalRows: counted.reduce((sum, table) => sum + table.rows, 0),
    legalHoldClasses: [...(manifest.purgePolicy.legalHoldClasses ?? [])],
  };
}

export interface PurgeResult {
  readonly moduleKey: string;
  readonly churchId: string;
  /** Rows deleted per table. The audit record carries counts and classes, never content. */
  readonly deleted: PurgeTable[];
  readonly totalRows: number;
}

/**
 * Deletes a module's data for one church, inside the caller's transaction.
 *
 * The caller supplies the transaction so the deletes, the status change and the audit entry
 * commit together. A purge that deleted rows and then failed to record itself would leave
 * a church's data gone with nothing saying why.
 */
export async function executePurge(
  query: QueryLike,
  manifest: ModuleManifest,
  churchId: string,
): Promise<PurgeResult> {
  if ((manifest.purgePolicy.legalHoldClasses ?? []).length > 0) {
    // docs/02 §3: legally-held classes are moved to core-owned archival tables *before*
    // the purge runs. No archival table exists yet, and deleting data someone is legally
    // required to keep is not a failure this job gets to have. It stops instead.
    throw new PurgeRefusedError(
      'LEGAL_HOLD_UNSUPPORTED',
      `${manifest.key} declares legal-hold classes (${manifest.purgePolicy.legalHoldClasses!.join(
        ', ',
      )}) and archival is not implemented; refusing to purge`,
    );
  }

  const plan = await planPurge(query, manifest, churchId);
  const deleted: PurgeTable[] = [];

  for (const table of plan.tables) {
    const result = await query.query(`DELETE FROM "${table.table}" WHERE church_id = $1`, [
      churchId,
    ]);
    deleted.push({ table: table.table, rows: result.rowCount ?? 0 });
  }

  return {
    moduleKey: manifest.key,
    churchId,
    deleted,
    totalRows: deleted.reduce((sum, table) => sum + table.rows, 0),
  };
}

export interface DueModule {
  readonly churchId: string;
  readonly moduleKey: string;
  readonly status: 'disabled' | 'pending_purge';
  readonly purgeAfter: Date;
}

/** How long a church has after `pending_purge` before the data actually goes. */
export const FINAL_GRACE_DAYS = 14;

/**
 * Everything whose clock has run out, across every tenant.
 *
 * Deliberately cross-tenant: this is a platform job, not a request, and it runs outside any
 * tenant context by necessity — it does not know which churches it is about until it looks.
 * Every consumer then scopes itself to one church before touching a row.
 */
export async function findDue(query: QueryLike, now: Date = new Date()): Promise<DueModule[]> {
  const { rows } = await query.query<{
    church_id: string;
    module_key: string;
    status: 'disabled' | 'pending_purge';
    purge_after: Date;
  }>(
    `SELECT church_id, module_key, status, purge_after
       FROM church_module
      WHERE status IN ('disabled', 'pending_purge')
        AND purge_after IS NOT NULL
        AND purge_after <= $1
      ORDER BY purge_after`,
    [now],
  );
  return rows.map((row) => ({
    churchId: row.church_id,
    moduleKey: row.module_key,
    status: row.status,
    purgeAfter: row.purge_after,
  }));
}

export type PurgeStep =
  | { readonly step: 'schedule' }
  | { readonly step: 'purge' }
  | { readonly step: 'skip'; readonly reason: string };

/**
 * What to do with a module row that the scan said was due, judged again from its current
 * state.
 *
 * Pure, and separate from the runner, because this is the decision that destroys data and
 * every branch of it needs to be reachable in a test. Driving it through the job means
 * racing a scan against an update to reach the interesting cases, and a race-based test
 * that guards a delete is worse than none — it passes when it did not run.
 */
export function decidePurgeStep(
  current: { status: string; purgeAfter: Date | null },
  now: Date,
): PurgeStep {
  // An admin re-enabled it during the grace period. The clock stops and so does this.
  if (current.status === 'enabled')
    return { step: 'skip', reason: 're-enabled during the grace period' };
  if (current.status === 'purged') return { step: 'skip', reason: 'already purged' };
  if (!current.purgeAfter) return { step: 'skip', reason: 'no purge clock set' };
  if (current.purgeAfter > now) return { step: 'skip', reason: 'clock was reset' };
  if (current.status === 'disabled') return { step: 'schedule' };
  if (current.status === 'pending_purge') return { step: 'purge' };
  return { step: 'skip', reason: `unrecognised status "${current.status}"` };
}
