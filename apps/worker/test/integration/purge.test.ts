// The purge job, against real module tables holding two churches' data.
//
// The assertion everything else serves: purging one church deletes that church's rows and
// nobody else's. A purge that over-reaches is unrecoverable, so it is checked on every path
// through this file rather than once.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import {
  type LoadedModule,
  PurgeRefusedError,
  executePurge,
  loadModules,
  planPurge,
  syncModuleDefinitions,
} from '@church/module-kit';
import { runWithTenant, TenantDatabase } from '@church/tenancy';
import { PurgeRunner } from '../../src/purge/runner.js';

const FIXTURES = new URL('../../../../packages/module-kit/test/fixtures/', import.meta.url)
  .pathname;

let pool: Pool;
let client: PoolClient;
let modules: LoadedModule[];
const target = '11111111-2222-4333-8444-555555555555';
const bystander = '66666666-7777-4888-8999-aaaaaaaaaaaa';

/** Two tables with a foreign key between them, so delete ordering is genuinely exercised. */
async function createModuleTables(c: PoolClient): Promise<void> {
  await c.query('DROP TABLE IF EXISTS mod_good_module_line, mod_good_module_note CASCADE');
  for (const [table, extra] of [
    ['mod_good_module_note', ''],
    [
      'mod_good_module_line',
      `, note_id uuid NOT NULL REFERENCES mod_good_module_note (id) ON DELETE RESTRICT`,
    ],
  ] as const) {
    await c.query(`
      CREATE TABLE ${table} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        church_id uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
        body text NOT NULL DEFAULT 'x'${extra}
      )`);
    await c.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await c.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await c.query(`CREATE POLICY tenant_isolation ON ${table}
      USING (church_id = current_setting('app.current_church_id', true)::uuid)
      WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid)`);
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${APP_ROLE}`);
  }
}

async function seedRows(c: PoolClient, churchId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO mod_good_module_note (church_id) VALUES ($1) RETURNING id`,
      [churchId],
    );
    await c.query(`INSERT INTO mod_good_module_line (church_id, note_id) VALUES ($1, $2)`, [
      churchId,
      rows[0]!.id,
    ]);
  }
}

/** Puts a module into a given state with its clock already expired. */
async function setState(
  churchId: string,
  status: 'disabled' | 'pending_purge' | 'enabled',
  purgeAfter: Date | null,
): Promise<void> {
  await client.query(
    `INSERT INTO church_module (church_id, module_key, status, enabled_at, purge_after)
     VALUES ($1, 'good_module', $2, now(), $3)
     ON CONFLICT (church_id, module_key) DO UPDATE
       SET status = EXCLUDED.status, purge_after = EXCLUDED.purge_after, enabled_at = now()`,
    [churchId, status, purgeAfter],
  );
}

const countRows = async (churchId: string): Promise<number> => {
  const { rows } = await client.query<{ count: string }>(
    `SELECT (SELECT count(*) FROM mod_good_module_note WHERE church_id = $1)
          + (SELECT count(*) FROM mod_good_module_line WHERE church_id = $1) AS count`,
    [churchId],
  );
  return Number(rows[0]!.count);
};

const runner = () => new PurgeRunner(pool, modules, APP_ROLE);
const yesterday = () => new Date(Date.now() - 86_400_000);

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, max: 4 });
  client = await pool.connect();
  await ensureAppRole(client);
  await applyMigrations(client, collectMigrations([CORE_MIGRATIONS_DIR]), { appRole: APP_ROLE });
  modules = await loadModules(FIXTURES);
  await syncModuleDefinitions(
    client,
    modules.map((module) => module.manifest),
  );
  await createModuleTables(client);
});

afterAll(async () => {
  await client.query('DROP TABLE IF EXISTS mod_good_module_line, mod_good_module_note CASCADE');
  await client.query('DELETE FROM church WHERE id = ANY($1::uuid[])', [[target, bystander]]);
  client.release();
  await pool.end();
});

beforeEach(async () => {
  await client.query('DELETE FROM church WHERE id = ANY($1::uuid[])', [[target, bystander]]);
  for (const [id, name] of [
    [target, 'purge-target'],
    [bystander, 'purge-bystander'],
  ]) {
    await client.query(`INSERT INTO church (id, name, country) VALUES ($1, $2, 'US')`, [id, name]);
  }
  await seedRows(client, target, 3);
  await seedRows(client, bystander, 2);
});

describe('the two-step clock', () => {
  it('moves a due disabled module to pending_purge and deletes nothing yet', async () => {
    // The grace period a church is owed. Collapsing both transitions into one pass would
    // take it away silently.
    await setState(target, 'disabled', yesterday());

    const [outcome] = await runner().run();
    expect(outcome).toMatchObject({ kind: 'scheduled', moduleKey: 'good_module' });
    expect(await countRows(target)).toBe(6);

    const { rows } = await client.query<{ status: string; purge_after: Date }>(
      `SELECT status, purge_after FROM church_module WHERE church_id = $1`,
      [target],
    );
    expect(rows[0]?.status).toBe('pending_purge');
    // Fourteen days out, not immediately due again.
    expect(rows[0]!.purge_after.getTime()).toBeGreaterThan(Date.now());
  });

  it('purges once the final grace has elapsed', async () => {
    await setState(target, 'pending_purge', yesterday());

    const [outcome] = await runner().run();
    expect(outcome).toMatchObject({ kind: 'purged', rows: 6 });
    expect(await countRows(target)).toBe(0);

    const { rows } = await client.query<{
      status: string;
      purged_at: Date | null;
      purge_after: Date | null;
    }>(`SELECT status, purged_at, purge_after FROM church_module WHERE church_id = $1`, [target]);
    expect(rows[0]?.status).toBe('purged');
    expect(rows[0]?.purged_at).toBeInstanceOf(Date);
    expect(rows[0]?.purge_after).toBeNull();
  });

  it('leaves every other church untouched', async () => {
    // The assertion that matters most. A purge that over-reaches cannot be undone.
    await setState(target, 'pending_purge', yesterday());
    await runner().run();
    expect(await countRows(target)).toBe(0);
    expect(await countRows(bystander)).toBe(4);
  });

  it('scopes the delete itself, not only through RLS', async () => {
    // This is the test that catches a missing WHERE clause. Through the job the delete runs
    // as the application role under a tenant context, so RLS scopes it even if the clause
    // is gone — every other test here passes with an unscoped DELETE, which is exactly the
    // false confidence worth removing. Run as the owner, RLS does not apply and the clause
    // is the only thing standing between one church's purge and everybody's data.
    const result = await executePurge(client, modules[0]!.manifest, target);
    expect(result.totalRows).toBe(6);
    expect(await countRows(target)).toBe(0);
    expect(await countRows(bystander)).toBe(4);
  });

  it('ignores a module whose clock has not run out', async () => {
    await setState(target, 'pending_purge', new Date(Date.now() + 86_400_000));
    expect(await runner().run()).toEqual([]);
    expect(await countRows(target)).toBe(6);
  });
});

describe('refusals', () => {
  it('does not consider a re-enabled module due at all', async () => {
    // Two defences, and this is the outer one: re-enabling clears the clock, so the scan
    // never returns the row. The inner one — re-reading the locked row before acting — is
    // covered exhaustively by the decidePurgeStep unit tests, because reaching it through
    // the job means racing a scan against an update.
    await setState(target, 'pending_purge', yesterday());
    await setState(target, 'enabled', null);

    expect(await runner().run()).toEqual([]);
    expect(await countRows(target)).toBe(6);
  });

  it('refuses a module table with no church_id rather than deleting everything', async () => {
    // The most dangerous shape this code could meet. There is no correct WHERE clause for
    // it, and the incorrect one takes every church's rows.
    await client.query(
      `CREATE TABLE mod_good_module_orphan (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`,
    );
    try {
      await expect(
        runWithTenant({ churchId: target }, () =>
          new TenantDatabase(pool, { appRole: APP_ROLE }).transaction((tx) =>
            planPurge(tx, modules[0]!.manifest, target),
          ),
        ),
      ).rejects.toMatchObject({ code: 'TABLE_NOT_TENANT_SCOPED' });
    } finally {
      await client.query('DROP TABLE mod_good_module_orphan');
    }
  });

  it('refuses to purge a module holding legally-held data', async () => {
    // Deleting data someone is legally required to keep is not a failure this job gets to
    // have. Until archival exists, it stops.
    const withHold: LoadedModule = {
      ...modules[0]!,
      manifest: {
        ...modules[0]!.manifest,
        purgePolicy: { ...modules[0]!.manifest.purgePolicy, legalHoldClasses: ['note'] },
      },
    };
    await expect(
      runWithTenant({ churchId: target }, () =>
        new TenantDatabase(pool, { appRole: APP_ROLE }).transaction((tx) =>
          executePurge(tx, withHold.manifest, target),
        ),
      ),
    ).rejects.toBeInstanceOf(PurgeRefusedError);
    expect(await countRows(target)).toBe(6);
  });

  it('skips a module this deployment no longer ships, and keeps going', async () => {
    // One unknown module must not stop every other church's purge.
    await client.query(
      `INSERT INTO church_module (church_id, module_key, status, purge_after)
       VALUES ($1, 'needs_good', 'pending_purge', $2)`,
      [bystander, yesterday()],
    );
    await setState(target, 'pending_purge', yesterday());

    const outcomes = await new PurgeRunner(pool, [modules[0]!], APP_ROLE).run();
    const skipped = outcomes.find((outcome) => outcome.moduleKey === 'needs_good');
    expect(skipped).toMatchObject({ kind: 'skipped' });
    expect(outcomes.find((outcome) => outcome.moduleKey === 'good_module')).toMatchObject({
      kind: 'purged',
    });
  });
});

describe('dry run', () => {
  it('reports what would go and changes nothing', async () => {
    await setState(target, 'pending_purge', yesterday());
    const [outcome] = await runner().run({ dryRun: true });
    expect(outcome).toMatchObject({ kind: 'planned', rows: 6 });
    expect(await countRows(target)).toBe(6);

    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM church_module WHERE church_id = $1`,
      [target],
    );
    expect(rows[0]?.status).toBe('pending_purge');
  });
});

describe('the record it leaves', () => {
  it('writes counts and classes, never content', async () => {
    await setState(target, 'pending_purge', yesterday());
    await runner().run();

    const { rows } = await client.query<{
      action: string;
      after: Record<string, unknown>;
      reason: string;
    }>(`SELECT action, after, reason FROM audit_entry WHERE church_id = $1 ORDER BY seq DESC`, [
      target,
    ]);
    const entry = rows[0];
    expect(entry?.action).toBe('module.purged');
    expect(entry?.after).toMatchObject({ status: 'purged', rowsDeleted: 6 });
    expect(entry?.after.dataClasses).toEqual(['note']);
    // Counts and table names, never a row's contents.
    expect(JSON.stringify(entry?.after)).not.toContain('body');
  });

  it('records the scheduling step too, so the warning is evidence', async () => {
    await setState(target, 'disabled', yesterday());
    await runner().run();
    const { rows } = await client.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM audit_entry WHERE church_id = $1 ORDER BY seq DESC`,
      [target],
    );
    expect(rows[0]?.action).toBe('module.purge_scheduled');
    expect(rows[0]?.reason).toMatch(/final grace/);
  });

  it('survives as a record after the data is gone', async () => {
    await setState(target, 'pending_purge', yesterday());
    await runner().run();
    const { rowCount } = await client.query(
      `SELECT 1 FROM audit_entry WHERE church_id = $1 AND action = 'module.purged'`,
      [target],
    );
    expect(rowCount).toBe(1);
  });
});
