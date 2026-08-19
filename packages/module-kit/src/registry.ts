import type { Pool, PoolClient } from 'pg';
import type { ModuleManifest, ModuleStatus } from './manifest.js';
import { PLAN_ORDER } from './entitlement.js';

export interface SyncResult {
  readonly inserted: string[];
  readonly updated: string[];
  /**
   * Rows in `module_definition` with no manifest behind them any more. Never deleted: a
   * church may still hold that module's data, and `church_module` references the row. A
   * deployment that dropped a module needs to purge tenants first, deliberately.
   */
  readonly orphaned: string[];
}

/**
 * Projects manifests into `module_definition` at boot.
 *
 * The manifest is the source of truth; this table is a queryable copy of it, so the sync
 * is an upsert and never a merge. Runs outside tenant context — the catalogue is the same
 * for everyone.
 */
export async function syncModuleDefinitions(
  client: PoolClient,
  manifests: readonly ModuleManifest[],
): Promise<SyncResult> {
  const inserted: string[] = [];
  const updated: string[] = [];

  for (const manifest of manifests) {
    const { rows } = await client.query<{ inserted: boolean }>(
      `INSERT INTO module_definition
         (key, name, version, min_plan, default_enabled, requires, permissions, data_classes,
          purge_policy, nav)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)
       ON CONFLICT (key) DO UPDATE SET
         name = EXCLUDED.name,
         version = EXCLUDED.version,
         min_plan = EXCLUDED.min_plan,
         default_enabled = EXCLUDED.default_enabled,
         requires = EXCLUDED.requires,
         permissions = EXCLUDED.permissions,
         data_classes = EXCLUDED.data_classes,
         purge_policy = EXCLUDED.purge_policy,
         nav = EXCLUDED.nav,
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        manifest.key,
        manifest.name,
        manifest.version,
        manifest.minPlan,
        manifest.defaultEnabled,
        JSON.stringify(manifest.requires),
        JSON.stringify(manifest.permissions),
        JSON.stringify(manifest.dataClasses),
        JSON.stringify(manifest.purgePolicy),
        JSON.stringify(manifest.nav),
      ],
    );
    (rows[0]?.inserted ? inserted : updated).push(manifest.key);
  }

  const known = new Set(manifests.map((manifest) => manifest.key));
  const { rows: existing } = await client.query<{ key: string }>(
    'SELECT key FROM module_definition',
  );

  return {
    inserted,
    updated,
    orphaned: existing.map((row) => row.key).filter((key) => !known.has(key)),
  };
}

export interface ModuleState {
  readonly moduleKey: string;
  readonly status: ModuleStatus;
  readonly settings: Record<string, unknown>;
}

/**
 * Reads per-tenant module state.
 *
 * Every method must run inside a tenant context: `church_module` is RLS-scoped, so a query
 * without one returns nothing rather than everything. That is the safe direction — a
 * missing context denies access instead of granting it — but it is still a bug, so callers
 * establish the context and these methods do not silently paper over its absence.
 */
export class ModuleStateReader {
  constructor(private readonly query: QueryLike) {}

  /**
   * Whether a module may actually serve this tenant right now: enabled **and** entitled.
   *
   * Both halves, in one query, because docs/01 §5 says a module runs only when both are
   * true. Checking enablement alone would leave a downgraded church still using a module
   * its plan no longer covers until Billing got round to switching it off — the invariant
   * would depend on a background job remembering, rather than being true by construction.
   *
   * Absent, disabled, pending_purge, purged and unentitled all mean no. An unknown key is
   * indistinguishable from a disabled one by design, so probing cannot enumerate what a
   * deployment supports.
   */
  async isAvailable(moduleKey: string): Promise<boolean> {
    const { rows } = await this.query.query<{ available: boolean }>(
      `SELECT (cm.status = 'enabled') AS available
         FROM church_module cm
         JOIN module_definition d ON d.key = cm.module_key
         JOIN church c ON c.id = cm.church_id
        WHERE cm.module_key = $1
          AND cm.church_id = current_setting('app.current_church_id', true)::uuid
          AND array_position($2::text[], c.plan) >= array_position($2::text[], d.min_plan)`,
      [moduleKey, PLAN_ORDER as unknown as string[]],
    );
    return rows[0]?.available === true;
  }

  /** Enablement alone, ignoring entitlement. For admin screens that must show a locked state. */
  async isEnabled(moduleKey: string): Promise<boolean> {
    const { rows } = await this.query.query<{ status: ModuleStatus }>(
      'SELECT status FROM church_module WHERE module_key = $1',
      [moduleKey],
    );
    return rows[0]?.status === 'enabled';
  }

  async get(moduleKey: string): Promise<ModuleState | undefined> {
    const { rows } = await this.query.query<{
      module_key: string;
      status: ModuleStatus;
      settings: Record<string, unknown>;
    }>('SELECT module_key, status, settings FROM church_module WHERE module_key = $1', [moduleKey]);
    const row = rows[0];
    return row
      ? { moduleKey: row.module_key, status: row.status, settings: row.settings }
      : undefined;
  }

  /** Enabled and entitled, which is what a nav payload should be built from. */
  async availableKeys(): Promise<string[]> {
    const { rows } = await this.query.query<{ module_key: string }>(
      `SELECT cm.module_key
         FROM church_module cm
         JOIN module_definition d ON d.key = cm.module_key
         JOIN church c ON c.id = cm.church_id
        WHERE cm.status = 'enabled'
          AND cm.church_id = current_setting('app.current_church_id', true)::uuid
          AND array_position($1::text[], c.plan) >= array_position($1::text[], d.min_plan)
        ORDER BY cm.module_key`,
      [PLAN_ORDER as unknown as string[]],
    );
    return rows.map((row) => row.module_key);
  }

  async enabledKeys(): Promise<string[]> {
    const { rows } = await this.query.query<{ module_key: string }>(
      `SELECT module_key FROM church_module WHERE status = 'enabled' ORDER BY module_key`,
    );
    return rows.map((row) => row.module_key);
  }
}

/** The slice of pg's client surface this file needs, so a Pool, client, or tx all fit. */
export interface QueryLike {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export type { Pool, PoolClient };
