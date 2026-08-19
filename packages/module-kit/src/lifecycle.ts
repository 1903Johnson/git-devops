import type { ModuleManifest, ModuleStatus } from './manifest.js';
import type { QueryLike } from './registry.js';

export class ModuleLifecycleError extends Error {
  constructor(
    readonly code:
      'UNKNOWN_MODULE' | 'MISSING_REQUIREMENT' | 'REQUIRED_BY_ANOTHER' | 'INVALID_TRANSITION',
    message: string,
  ) {
    super(message);
    this.name = 'ModuleLifecycleError';
  }
}

/**
 * Which transitions the state machine in docs/02 §3 actually permits.
 *
 * `purged` is terminal by omission: once a church's module data has been deleted, the row
 * records that it happened. Re-enabling is a fresh enable, and pretending otherwise would
 * imply the old data is coming back.
 */
const ALLOWED: Record<ModuleStatus, readonly ModuleStatus[]> = {
  enabled: ['disabled'],
  disabled: ['enabled', 'pending_purge'],
  pending_purge: ['enabled', 'purged'],
  purged: ['enabled'],
};

/** ISO 8601 durations, only the forms a purge policy uses. */
export function addIsoDuration(from: Date, duration: string): Date {
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/.exec(duration);
  if (!match) throw new TypeError(`unsupported ISO 8601 duration "${duration}"`);
  const [years, months, days] = [match[1], match[2], match[3]].map((part) => Number(part ?? 0));
  const result = new Date(from.getTime());
  result.setUTCFullYear(result.getUTCFullYear() + years!);
  result.setUTCMonth(result.getUTCMonth() + months!);
  result.setUTCDate(result.getUTCDate() + days!);
  return result;
}

export interface EnableOptions {
  /** The user who clicked Enable, for the audit trail. */
  readonly enabledBy?: string;
  readonly settings?: Record<string, unknown>;
}

/**
 * The per-tenant module state machine.
 *
 * Owns the invariants — which transitions are legal, that `requires[]` is satisfied, and
 * when the purge clock starts. It deliberately does **not** own plan entitlement (CORE-023)
 * or the purge job itself (CORE-024): this class decides whether a transition is coherent,
 * not whether the church has paid for it or what happens to the rows afterwards.
 *
 * Every method runs inside a tenant context; `church_module` is RLS-scoped.
 */
export class ModuleLifecycle {
  private readonly byKey: ReadonlyMap<string, ModuleManifest>;

  constructor(
    private readonly query: QueryLike,
    manifests: readonly ModuleManifest[],
  ) {
    this.byKey = new Map(manifests.map((manifest) => [manifest.key, manifest]));
  }

  async statusOf(moduleKey: string): Promise<ModuleStatus | undefined> {
    const { rows } = await this.query.query<{ status: ModuleStatus }>(
      'SELECT status FROM church_module WHERE module_key = $1',
      [moduleKey],
    );
    return rows[0]?.status;
  }

  /**
   * Turns a module on. Fails if any module it requires is not already enabled — a module
   * running against a missing dependency fails somewhere deep in a request, long after the
   * admin who caused it has closed the tab.
   */
  async enable(moduleKey: string, options: EnableOptions = {}): Promise<void> {
    const manifest = this.manifest(moduleKey);
    await this.assertTransition(moduleKey, 'enabled');

    for (const required of manifest.requires) {
      const status = await this.statusOf(required);
      if (status !== 'enabled') {
        throw new ModuleLifecycleError(
          'MISSING_REQUIREMENT',
          `${moduleKey} requires ${required}, which is ${status ?? 'not enabled'}`,
        );
      }
    }

    await this.query.query(
      `INSERT INTO church_module
         (church_id, module_key, status, enabled_at, enabled_by, settings)
       VALUES (current_setting('app.current_church_id')::uuid, $1, 'enabled', now(), $2, $3::jsonb)
       ON CONFLICT (church_id, module_key) DO UPDATE SET
         status = 'enabled',
         enabled_at = now(),
         enabled_by = EXCLUDED.enabled_by,
         disabled_at = NULL,
         -- Re-enabling within the grace period stops the clock. That is the whole point of
         -- retaining data on disable: a church that turns something off by mistake, or
         -- pauses it for a season, gets it back intact.
         purge_after = NULL,
         settings = COALESCE(EXCLUDED.settings, church_module.settings),
         updated_at = now()`,
      [moduleKey, options.enabledBy ?? null, JSON.stringify(options.settings ?? {})],
    );
  }

  /**
   * Turns a module off. Data is retained and the purge clock starts; routes and nav stop
   * working immediately, which is what makes this safe to offer to an admin at all.
   */
  async disable(moduleKey: string, now: Date = new Date()): Promise<void> {
    const manifest = this.manifest(moduleKey);
    await this.assertTransition(moduleKey, 'disabled');

    // Refuse while something still enabled depends on it, rather than leaving the dependent
    // module running against a module that is gone.
    for (const [key, other] of this.byKey) {
      if (!other.requires.includes(moduleKey)) continue;
      if ((await this.statusOf(key)) === 'enabled') {
        throw new ModuleLifecycleError(
          'REQUIRED_BY_ANOTHER',
          `${moduleKey} cannot be disabled while ${key} is enabled and requires it`,
        );
      }
    }

    const purgeAfter = addIsoDuration(now, manifest.purgePolicy.retentionAfterDisable);
    await this.query.query(
      `UPDATE church_module
          SET status = 'disabled', disabled_at = now(), purge_after = $2, updated_at = now()
        WHERE module_key = $1`,
      [moduleKey, purgeAfter],
    );
  }

  /** Moves a disabled module past its grace period. The purge job itself is CORE-024. */
  async markPendingPurge(moduleKey: string): Promise<void> {
    this.manifest(moduleKey);
    await this.assertTransition(moduleKey, 'pending_purge');
    await this.query.query(
      `UPDATE church_module SET status = 'pending_purge', updated_at = now() WHERE module_key = $1`,
      [moduleKey],
    );
  }

  private manifest(moduleKey: string): ModuleManifest {
    const manifest = this.byKey.get(moduleKey);
    if (!manifest) {
      throw new ModuleLifecycleError('UNKNOWN_MODULE', `no module manifest for "${moduleKey}"`);
    }
    return manifest;
  }

  private async assertTransition(moduleKey: string, to: ModuleStatus): Promise<void> {
    const from = await this.statusOf(moduleKey);
    // No row yet: the church has never touched this module, so enabling is the only move.
    if (from === undefined) {
      if (to === 'enabled') return;
      throw new ModuleLifecycleError(
        'INVALID_TRANSITION',
        `${moduleKey} has no state for this church; only enable is possible`,
      );
    }
    if (from === to) return;
    if (!ALLOWED[from].includes(to)) {
      throw new ModuleLifecycleError('INVALID_TRANSITION', `${moduleKey}: ${from} -> ${to}`);
    }
  }
}
