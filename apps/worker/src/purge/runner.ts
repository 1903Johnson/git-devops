import type { Pool } from 'pg';
import { AuditService } from '@church/audit';
import {
  type DueModule,
  FINAL_GRACE_DAYS,
  type LoadedModule,
  PurgeRefusedError,
  addIsoDuration,
  decidePurgeStep,
  executePurge,
  findDue,
  planPurge,
} from '@church/module-kit';
import { TenantDatabase, runWithTenant } from '@church/tenancy';

export interface PurgeRunOptions {
  /** Report what would happen and change nothing. */
  readonly dryRun?: boolean;
  readonly now?: Date;
}

export type PurgeOutcome =
  | {
      readonly kind: 'scheduled';
      readonly churchId: string;
      readonly moduleKey: string;
      readonly purgeAfter: Date;
    }
  | {
      readonly kind: 'purged';
      readonly churchId: string;
      readonly moduleKey: string;
      readonly rows: number;
    }
  | {
      readonly kind: 'skipped';
      readonly churchId: string;
      readonly moduleKey: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'planned';
      readonly churchId: string;
      readonly moduleKey: string;
      readonly rows: number;
    };

/**
 * The purge job: one pass over everything whose clock has run out.
 *
 * Two transitions, each its own step so a church always gets the second grace period:
 *
 *   disabled ──(retentionAfterDisable elapsed)──▶ pending_purge ──(14 days)──▶ purged
 *
 * Doing both in one pass would collapse the warning period a church is owed. An entry is
 * written for each, so "we told you" is a record rather than a claim.
 */
export class PurgeRunner {
  private readonly db: TenantDatabase;
  private readonly manifests: Map<string, LoadedModule>;

  constructor(
    private readonly pool: Pool,
    modules: readonly LoadedModule[],
    private readonly appRole?: string,
  ) {
    this.db = new TenantDatabase(pool, appRole ? { appRole } : {});
    this.manifests = new Map(modules.map((module) => [module.manifest.key, module]));
  }

  async run(options: PurgeRunOptions = {}): Promise<PurgeOutcome[]> {
    const now = options.now ?? new Date();
    // Finding the work is cross-tenant by necessity: the job does not know which churches
    // it concerns until it looks. Every step after this scopes itself to one church.
    const client = await this.pool.connect();
    let due: DueModule[];
    try {
      due = await findDue(client, now);
    } finally {
      client.release();
    }

    const outcomes: PurgeOutcome[] = [];
    for (const item of due) {
      outcomes.push(await this.process(item, now, options.dryRun === true));
    }
    return outcomes;
  }

  private async process(item: DueModule, now: Date, dryRun: boolean): Promise<PurgeOutcome> {
    const loaded = this.manifests.get(item.moduleKey);
    if (!loaded) {
      // A church_module row for a module this deployment no longer ships. Its tables may
      // not even exist, and guessing which ones to drop is not a guess worth making.
      return skip(item, 'no manifest in this deployment');
    }

    try {
      return await runWithTenant({ churchId: item.churchId }, () =>
        this.db.transaction(async (tx) => {
          // Two runners, two replicas, or a cron that fired twice must not purge the same
          // thing concurrently. The lock is transaction-scoped, so it releases on commit or
          // rollback with nothing to clean up.
          const lock = await tx.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS locked',
            [item.churchId, item.moduleKey],
          );
          if (lock.rows[0]?.locked !== true) return skip(item, 'another run holds the lock');

          // Re-read inside the transaction. The state may have changed between the scan
          // and now — most importantly, an admin may have re-enabled the module, which
          // stops the clock and must stop the purge with it.
          const { rows } = await tx.query<{ status: string; purge_after: Date | null }>(
            `SELECT status, purge_after FROM church_module
              WHERE module_key = $1 FOR UPDATE`,
            [item.moduleKey],
          );
          const current = rows[0];
          if (!current) return skip(item, 'row disappeared');

          const decision = decidePurgeStep(
            { status: current.status, purgeAfter: current.purge_after },
            now,
          );
          if (decision.step === 'skip') return skip(item, decision.reason);

          const audit = new AuditService(tx);

          if (decision.step === 'schedule') {
            const finalDate = addIsoDuration(now, `P${FINAL_GRACE_DAYS}D`);
            if (dryRun) {
              return {
                kind: 'scheduled' as const,
                churchId: item.churchId,
                moduleKey: item.moduleKey,
                purgeAfter: finalDate,
              };
            }
            await tx.query(
              `UPDATE church_module
                  SET status = 'pending_purge', purge_after = $2, updated_at = now()
                WHERE module_key = $1`,
              [item.moduleKey, finalDate],
            );
            await audit.record({
              action: 'module.purge_scheduled',
              resourceType: 'module',
              resourceId: item.moduleKey,
              before: { status: 'disabled' },
              after: { status: 'pending_purge', purgeAfter: finalDate.toISOString() },
              reason: `retention period elapsed; final grace of ${FINAL_GRACE_DAYS} days begins`,
            });
            return {
              kind: 'scheduled',
              churchId: item.churchId,
              moduleKey: item.moduleKey,
              purgeAfter: finalDate,
            };
          }

          if (dryRun) {
            const plan = await planPurge(tx, loaded.manifest, item.churchId);
            return {
              kind: 'planned' as const,
              churchId: item.churchId,
              moduleKey: item.moduleKey,
              rows: plan.totalRows,
            };
          }

          const result = await executePurge(tx, loaded.manifest, item.churchId);
          await tx.query(
            `UPDATE church_module
                SET status = 'purged', purged_at = now(), purge_after = NULL, updated_at = now()
              WHERE module_key = $1`,
            [item.moduleKey],
          );
          // Counts and classes, never content (docs/02 §3). The point of the record is to
          // prove what was destroyed and when, not to keep a copy of it.
          await audit.record({
            action: 'module.purged',
            resourceType: 'module',
            resourceId: item.moduleKey,
            before: { status: 'pending_purge' },
            after: {
              status: 'purged',
              rowsDeleted: result.totalRows,
              tables: result.deleted.map((table) => `${table.table}: ${table.rows}`),
              dataClasses: loaded.manifest.dataClasses.map((dataClass) => dataClass.name),
            },
            reason: 'final grace period elapsed',
          });
          return {
            kind: 'purged',
            churchId: item.churchId,
            moduleKey: item.moduleKey,
            rows: result.totalRows,
          };
        }),
      );
    } catch (error) {
      if (error instanceof PurgeRefusedError) {
        // A refusal is not a crash. It stops this one module, leaves its state untouched,
        // and lets the rest of the run continue — one module with a legal hold must not
        // block every other church's purge.
        return skip(item, `${error.code}: ${error.message}`);
      }
      throw error;
    }
  }
}

const skip = (item: DueModule, reason: string): PurgeOutcome => ({
  kind: 'skipped',
  churchId: item.churchId,
  moduleKey: item.moduleKey,
  reason,
});
