import { Inject, Injectable } from '@nestjs/common';
import type { ChurchModule } from '@church/contracts';
import {
  type LoadedModule,
  ModuleLifecycle,
  ModuleLifecycleError,
  type ModuleStatus,
  entitlementFor,
  requiresConsent,
} from '@church/module-kit';
import { AuditService } from '@church/audit';
import { TenantDatabase, type TenantTransaction } from '@church/tenancy';
import { LOADED_MODULES } from '../common/tokens.js';

interface StateRow {
  module_key: string;
  status: ModuleStatus;
  enabled_at: Date | null;
  disabled_at: Date | null;
  purge_after: Date | null;
}

/**
 * The administrative view of the module registry, and the two actions on it.
 *
 * Everything here runs inside one transaction per request, so the state a response reports
 * is the state the write produced — reading it back on a second connection could catch a
 * concurrent change and report someone else's outcome as this caller's.
 */
@Injectable()
export class ModulesService {
  constructor(
    private readonly db: TenantDatabase,
    @Inject(LOADED_MODULES) private readonly modules: LoadedModule[],
  ) {}

  /**
   * The whole catalogue, including modules this church cannot have. That is deliberate:
   * hiding unentitled modules would also hide the upgrade path, and an admin cannot ask for
   * what they cannot see. `GET /me/modules` — the member-facing payload — shows only what
   * is actually running.
   */
  async list(): Promise<ChurchModule[]> {
    return this.db.transaction(async (tx) => {
      const states = await this.statesByKey(tx);
      const entries: ChurchModule[] = [];
      for (const { manifest } of this.modules) {
        const entitlement = await entitlementFor(tx, manifest.key);
        entries.push(
          this.present(manifest.key, states.get(manifest.key), entitlement?.entitled === true),
        );
      }
      return entries.sort((a, b) => a.key.localeCompare(b.key));
    });
  }

  async enable(
    moduleKey: string,
    options: {
      enabledBy?: string;
      acknowledgeRestrictedData?: boolean;
      settings?: Record<string, unknown>;
    },
  ): Promise<ChurchModule> {
    return this.db.transaction(async (tx) => {
      const before = await this.stateOf(tx, moduleKey);
      await this.lifecycle(tx).enable(moduleKey, options);
      const after = await this.readBack(tx, moduleKey);

      // In the same transaction as the change. An entry written separately can commit while
      // the enable rolls back, leaving a log that says a module was switched on when it was
      // not.
      await new AuditService(tx).record({
        action: 'module.enabled',
        resourceType: 'module',
        resourceId: moduleKey,
        before,
        after: { status: after.status, entitled: after.entitled },
        // Consent is the point of this record: the line that shows an administrator was
        // told what the module collects before it started collecting it.
        ...(options.acknowledgeRestrictedData
          ? { reason: 'restricted-data acknowledgement given' }
          : {}),
      });
      return after;
    });
  }

  async disable(moduleKey: string): Promise<ChurchModule> {
    return this.db.transaction(async (tx) => {
      const before = await this.stateOf(tx, moduleKey);
      await this.lifecycle(tx).disable(moduleKey);
      const after = await this.readBack(tx, moduleKey);

      await new AuditService(tx).record({
        action: 'module.disabled',
        resourceType: 'module',
        resourceId: moduleKey,
        before,
        after: { status: after.status, purgeAfter: after.purgeAfter },
      });
      return after;
    });
  }

  /** The stored state, for the `before` half of an audit entry. */
  private async stateOf(
    tx: TenantTransaction,
    moduleKey: string,
  ): Promise<Record<string, unknown>> {
    const state = (await this.statesByKey(tx)).get(moduleKey);
    // No row is the same thing as off, and the log should say so rather than say nothing.
    return { status: state?.status ?? 'disabled' };
  }

  private lifecycle(tx: TenantTransaction): ModuleLifecycle {
    return new ModuleLifecycle(
      tx,
      this.modules.map((module) => module.manifest),
    );
  }

  private async readBack(tx: TenantTransaction, moduleKey: string): Promise<ChurchModule> {
    const states = await this.statesByKey(tx);
    const entitlement = await entitlementFor(tx, moduleKey);
    return this.present(moduleKey, states.get(moduleKey), entitlement?.entitled === true);
  }

  private async statesByKey(tx: TenantTransaction): Promise<Map<string, StateRow>> {
    const { rows } = await tx.query<StateRow>(
      'SELECT module_key, status, enabled_at, disabled_at, purge_after FROM church_module',
    );
    return new Map(rows.map((row) => [row.module_key, row]));
  }

  private present(moduleKey: string, state: StateRow | undefined, entitled: boolean): ChurchModule {
    const manifest = this.modules.find((module) => module.manifest.key === moduleKey)?.manifest;
    if (!manifest) throw new ModuleLifecycleError('UNKNOWN_MODULE', `no manifest for ${moduleKey}`);
    // A church that has never touched a module has no row, which is the same thing as off.
    const status = state?.status ?? 'disabled';
    return {
      key: manifest.key,
      name: manifest.name,
      version: manifest.version,
      minPlan: manifest.minPlan,
      status,
      entitled,
      available: entitled && status === 'enabled',
      requiresConsent: requiresConsent(manifest),
      requires: [...manifest.requires],
      enabledAt: state?.enabled_at?.toISOString() ?? null,
      disabledAt: state?.disabled_at?.toISOString() ?? null,
      purgeAfter: state?.purge_after?.toISOString() ?? null,
    };
  }
}
