import { Pool } from 'pg';
import { loadModules } from '@church/module-kit';
import { PurgeRunner } from './purge/runner.js';

/**
 * Scheduled jobs, run one pass at a time and then exit.
 *
 * There is deliberately no timer in here. A long-lived process with `setInterval` inside an
 * autoscaled deployment means every replica racing the same purge, and a process that has
 * been up for three weeks silently stops running the job the moment it wedges. Scheduling
 * belongs to the platform — a Kubernetes CronJob, an ECS scheduled task, a cron line — which
 * can be observed, alerted on, and made to run exactly once.
 *
 *   pnpm --filter @church/worker run purge:plan   # what would happen
 *   pnpm --filter @church/worker run purge:run    # do it
 *
 * The job is safe to run concurrently regardless, because whatever schedules it will
 * eventually double-fire: each module is taken under a transaction-scoped advisory lock.
 */
async function main(): Promise<number> {
  const [command, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes('--dry-run');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    return 2;
  }

  if (command !== 'purge') {
    console.error(`usage: worker purge [--dry-run]`);
    return 2;
  }

  const modulesDir =
    process.env.MODULES_DIR ?? new URL('../../../modules/', import.meta.url).pathname;
  const pool = new Pool({ connectionString, max: 4 });

  try {
    const modules = await loadModules(modulesDir);
    const runner = new PurgeRunner(pool, modules, process.env.APP_DB_ROLE);
    const outcomes = await runner.run({ dryRun });

    for (const outcome of outcomes) {
      const where = `${outcome.churchId} ${outcome.moduleKey}`;
      switch (outcome.kind) {
        case 'scheduled':
          console.log(`scheduled  ${where} — purge after ${outcome.purgeAfter.toISOString()}`);
          break;
        case 'purged':
          console.log(`purged     ${where} — ${outcome.rows} row(s) deleted`);
          break;
        case 'planned':
          console.log(`would purge ${where} — ${outcome.rows} row(s)`);
          break;
        case 'skipped':
          // Skips are printed, not swallowed. A purge that quietly does nothing for weeks
          // is indistinguishable from one that is working.
          console.log(`skipped    ${where} — ${outcome.reason}`);
          break;
      }
    }
    console.log(`${dryRun ? 'purge plan' : 'purge run'}: ${outcomes.length} item(s)`);
    return 0;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
