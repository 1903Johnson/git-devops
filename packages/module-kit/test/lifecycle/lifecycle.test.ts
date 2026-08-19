// Enable / disable / purge, the state machine in docs/02 §3, against a real database.
//
// This is the suite CI demands once any modules/* package exists. It runs against fixture
// modules rather than a real one so the machinery is covered from the day it is written;
// a module adds its own data-level lifecycle tests on top.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import {
  ModuleLifecycle,
  ModuleLifecycleError,
  addIsoDuration,
  loadModules,
  syncModuleDefinitions,
} from '../../src/index.js';
import type { ModuleManifest } from '../../src/index.js';

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;

let pool: Pool;
let client: PoolClient;
let manifests: ModuleManifest[];
const church = '66666666-6666-4666-8666-666666666666';

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, max: 2 });
  client = await pool.connect();
  await ensureAppRole(client);
  await applyMigrations(client, collectMigrations([CORE_MIGRATIONS_DIR]), { appRole: APP_ROLE });
  manifests = (await loadModules(FIXTURES)).map((module) => module.manifest);
  await syncModuleDefinitions(client, manifests);
});

afterAll(async () => {
  await client.query('DELETE FROM church WHERE id = $1', [church]);
  client.release();
  await pool.end();
});

beforeEach(async () => {
  // A real church row and a real tenant context: church_module is RLS-scoped, so a
  // lifecycle running without one would silently do nothing at all.
  await client.query('DELETE FROM church WHERE id = $1', [church]);
  // ENTERPRISE so plan entitlement is not what these tests are exercising; the entitlement
  // rules have their own suite.
  await client.query(
    `INSERT INTO church (id, name, country, plan) VALUES ($1, 'lifecycle', 'US', 'ENTERPRISE')`,
    [church],
  );
  await client.query(`SET app.current_church_id = '${church}'`);
});

const lifecycleFor = () => new ModuleLifecycle(client, manifests);

describe('enable', () => {
  it('turns a module on and records when', async () => {
    const lifecycle = lifecycleFor();
    await lifecycle.enable('good_module');
    expect(await lifecycle.statusOf('good_module')).toBe('enabled');
    const { rows } = await client.query<{ enabled_at: Date | null }>(
      'SELECT enabled_at FROM church_module WHERE module_key = $1',
      ['good_module'],
    );
    expect(rows[0]?.enabled_at).toBeInstanceOf(Date);
  });

  it('refuses a module whose requirement is not enabled', async () => {
    // A module running against a missing dependency fails deep inside a request, long
    // after the admin who caused it has closed the tab.
    const lifecycle = lifecycleFor();
    const enabling = () => lifecycle.enable('needs_good', { acknowledgeRestrictedData: true });
    // Asserting the class as well as the code: toMatchObject alone would be satisfied by
    // any object carrying that string, including one thrown by something unrelated.
    await expect(enabling()).rejects.toBeInstanceOf(ModuleLifecycleError);
    await expect(enabling()).rejects.toMatchObject({ code: 'MISSING_REQUIREMENT' });
  });

  it('allows it once the requirement is on', async () => {
    const lifecycle = lifecycleFor();
    await lifecycle.enable('good_module');
    await lifecycle.enable('needs_good', { acknowledgeRestrictedData: true });
    expect(await lifecycle.statusOf('needs_good')).toBe('enabled');
  });

  it('rejects a module this deployment does not have', async () => {
    await expect(lifecycleFor().enable('imaginary')).rejects.toMatchObject({
      code: 'UNKNOWN_MODULE',
    });
  });

  it('is idempotent', async () => {
    const lifecycle = lifecycleFor();
    await lifecycle.enable('good_module');
    await lifecycle.enable('good_module');
    expect(await lifecycle.statusOf('good_module')).toBe('enabled');
  });
});

describe('disable', () => {
  it('retains data and starts the purge clock from the module policy', async () => {
    // Disabling withdraws access, never data. The clock is what CORE-024 later reads.
    const lifecycle = lifecycleFor();
    await lifecycle.enable('good_module');
    const at = new Date('2026-01-01T00:00:00Z');
    await lifecycle.disable('good_module', at);

    const { rows } = await client.query<{ status: string; purge_after: Date }>(
      'SELECT status, purge_after FROM church_module WHERE module_key = $1',
      ['good_module'],
    );
    expect(rows[0]?.status).toBe('disabled');
    // good_module declares P90D.
    expect(rows[0]?.purge_after.toISOString()).toBe(addIsoDuration(at, 'P90D').toISOString());
  });

  it('refuses while an enabled module still requires it', async () => {
    const lifecycle = lifecycleFor();
    await lifecycle.enable('good_module');
    await lifecycle.enable('needs_good', { acknowledgeRestrictedData: true });
    await expect(lifecycle.disable('good_module')).rejects.toMatchObject({
      code: 'REQUIRED_BY_ANOTHER',
    });
  });

  it('allows it once the dependent is off', async () => {
    const lifecycle = lifecycleFor();
    await lifecycle.enable('good_module');
    await lifecycle.enable('needs_good', { acknowledgeRestrictedData: true });
    await lifecycle.disable('needs_good');
    await lifecycle.disable('good_module');
    expect(await lifecycle.statusOf('good_module')).toBe('disabled');
  });
});

describe('re-enable within the grace period', () => {
  it('stops the purge clock', async () => {
    // The whole point of retaining data on disable: a church that turns something off by
    // mistake, or pauses it for a season, gets it back intact.
    const lifecycle = lifecycleFor();
    await lifecycle.enable('good_module');
    await lifecycle.disable('good_module');
    await lifecycle.enable('good_module');

    const { rows } = await client.query<{
      status: string;
      purge_after: Date | null;
      disabled_at: Date | null;
    }>('SELECT status, purge_after, disabled_at FROM church_module WHERE module_key = $1', [
      'good_module',
    ]);
    expect(rows[0]?.status).toBe('enabled');
    expect(rows[0]?.purge_after).toBeNull();
    expect(rows[0]?.disabled_at).toBeNull();
  });
});

describe('pending purge', () => {
  it('follows disable, and can still be rescued by an enable', async () => {
    const lifecycle = lifecycleFor();
    await lifecycle.enable('good_module');
    await lifecycle.disable('good_module');
    await lifecycle.markPendingPurge('good_module');
    expect(await lifecycle.statusOf('good_module')).toBe('pending_purge');

    await lifecycle.enable('good_module');
    expect(await lifecycle.statusOf('good_module')).toBe('enabled');
  });

  it('cannot be reached directly from enabled', async () => {
    const lifecycle = lifecycleFor();
    await lifecycle.enable('good_module');
    await expect(lifecycle.markPendingPurge('good_module')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('cannot be reached before the church has ever enabled the module', async () => {
    await expect(lifecycleFor().markPendingPurge('good_module')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });
});

describe('the database enforces the invariants too', () => {
  it('rejects a status the state machine does not define', async () => {
    await client.query('BEGIN');
    await expect(
      client.query(
        `INSERT INTO church_module (church_id, module_key, status) VALUES ($1, 'good_module', 'zombie')`,
        [church],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK');
  });

  it('rejects an enabled row with no enabled_at', async () => {
    // Without this the status column drifts from the timestamps, and every later audit
    // question becomes guesswork.
    await client.query('BEGIN');
    await expect(
      client.query(
        `INSERT INTO church_module (church_id, module_key, status) VALUES ($1, 'good_module', 'enabled')`,
        [church],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK');
  });

  it('refuses a module_key with no definition', async () => {
    await client.query('BEGIN');
    await expect(
      client.query(
        `INSERT INTO church_module (church_id, module_key, status) VALUES ($1, 'imaginary', 'disabled')`,
        [church],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await client.query('ROLLBACK');
  });
});

describe('addIsoDuration', () => {
  it('handles the forms a purge policy uses', () => {
    expect(addIsoDuration(new Date('2026-01-01T00:00:00Z'), 'P90D').toISOString()).toBe(
      '2026-04-01T00:00:00.000Z',
    );
    expect(addIsoDuration(new Date('2026-01-31T00:00:00Z'), 'P2Y').toISOString()).toBe(
      '2028-01-31T00:00:00.000Z',
    );
  });

  it('rolls a month-end overflow forward rather than clamping', () => {
    // 31 January plus one month has no correct answer; this one lands on 3 March. Pinned
    // rather than fixed because every purge policy in the codebase is expressed in days or
    // years, and a retention date being two days late is not worth a custom calendar.
    expect(addIsoDuration(new Date('2026-01-31T00:00:00Z'), 'P1M').toISOString()).toBe(
      '2026-03-03T00:00:00.000Z',
    );
  });

  it('rejects a duration it cannot honour rather than silently ignoring it', () => {
    // Returning `from` unchanged for an unsupported duration would set a purge date in the
    // past, and the job would delete the moment it next ran.
    expect(() => addIsoDuration(new Date(), 'PT5M')).toThrow();
    expect(() => addIsoDuration(new Date(), 'nonsense')).toThrow();
  });
});
