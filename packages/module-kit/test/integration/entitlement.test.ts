// Entitlement against a real database. docs/01 §5: a module runs only when the plan allows
// it AND an admin has turned it on, and these are separate questions with separate answers.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import {
  ModuleLifecycle,
  ModuleStateReader,
  entitlementFor,
  loadModules,
  syncModuleDefinitions,
} from '../../src/index.js';
import type { ModuleManifest } from '../../src/index.js';

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;
let pool: Pool;
let client: PoolClient;
let manifests: ModuleManifest[];
const church = '99999999-9999-4999-8999-999999999999';

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

const setPlan = async (plan: string) => {
  await client.query('DELETE FROM church WHERE id = $1', [church]);
  await client.query(`INSERT INTO church (id, name, country, plan) VALUES ($1, 'ent', 'US', $2)`, [
    church,
    plan,
  ]);
  await client.query(`SET app.current_church_id = '${church}'`);
};

beforeEach(async () => {
  await setPlan('ENTERPRISE');
});

describe('reading entitlement', () => {
  it('reports the plan and the module minimum together', async () => {
    await setPlan('BASIC');
    expect(await entitlementFor(client, 'needs_good')).toEqual({
      moduleKey: 'needs_good',
      minPlan: 'PRO',
      plan: 'BASIC',
      entitled: false,
    });
    expect(await entitlementFor(client, 'good_module')).toMatchObject({ entitled: true });
  });

  it('returns nothing for a module this deployment does not have', async () => {
    expect(await entitlementFor(client, 'imaginary')).toBeUndefined();
  });
});

describe('enabling', () => {
  it('refuses a module the plan does not cover', async () => {
    await setPlan('FREE');
    await expect(
      new ModuleLifecycle(client, manifests).enable('needs_good', {
        acknowledgeRestrictedData: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_ENTITLED' });
  });

  it('reports entitlement before requirements', async () => {
    // A church on the wrong plan should be told that, not walked through requirement
    // errors for a module it cannot have either way.
    await setPlan('FREE');
    await expect(
      new ModuleLifecycle(client, manifests).enable('needs_good', {
        acknowledgeRestrictedData: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_ENTITLED' });
  });

  it('allows it once the plan is high enough', async () => {
    const lifecycle = new ModuleLifecycle(client, manifests);
    await lifecycle.enable('good_module');
    await lifecycle.enable('needs_good', { acknowledgeRestrictedData: true });
    expect(await lifecycle.statusOf('needs_good')).toBe('enabled');
  });
});

describe('consent', () => {
  it('refuses to enable a module holding restricted data without an acknowledgement', async () => {
    // needs_good declares a restricted data class. Enabling it silently would mean a
    // church starts collecting that data because someone clicked a toggle.
    const lifecycle = new ModuleLifecycle(client, manifests);
    await lifecycle.enable('good_module');
    await expect(lifecycle.enable('needs_good')).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
  });

  it('does not ask for one where no data class is restricted', async () => {
    await new ModuleLifecycle(client, manifests).enable('good_module');
    expect(await new ModuleLifecycle(client, manifests).statusOf('good_module')).toBe('enabled');
  });
});

describe('losing entitlement', () => {
  it('makes an enabled module unavailable without touching its stored state', async () => {
    // The downgrade case. docs/01 §5: entitlement is lost, the module stops running, and
    // the data is retained — a downgrade must never delete anything.
    const lifecycle = new ModuleLifecycle(client, manifests);
    await lifecycle.enable('good_module');
    await lifecycle.enable('needs_good', { acknowledgeRestrictedData: true });

    await client.query('UPDATE church SET plan = $1 WHERE id = $2', ['FREE', church]);
    const reader = new ModuleStateReader(client);

    expect(await reader.isAvailable('needs_good')).toBe(false);
    // Still recorded as enabled: the admin's decision is intact, and re-upgrading restores
    // it without anyone re-enabling anything.
    expect(await reader.isEnabled('needs_good')).toBe(true);
    expect(await lifecycle.statusOf('needs_good')).toBe('enabled');
  });

  it('drops it from the available set but not from the enabled set', async () => {
    const lifecycle = new ModuleLifecycle(client, manifests);
    await lifecycle.enable('good_module');
    await lifecycle.enable('needs_good', { acknowledgeRestrictedData: true });
    await client.query('UPDATE church SET plan = $1 WHERE id = $2', ['FREE', church]);

    const reader = new ModuleStateReader(client);
    expect(await reader.availableKeys()).toEqual(['good_module']);
    expect(await reader.enabledKeys()).toEqual(['good_module', 'needs_good']);
  });

  it('comes back on upgrade, still enabled', async () => {
    const lifecycle = new ModuleLifecycle(client, manifests);
    await lifecycle.enable('good_module');
    await lifecycle.enable('needs_good', { acknowledgeRestrictedData: true });
    await client.query('UPDATE church SET plan = $1 WHERE id = $2', ['FREE', church]);
    await client.query('UPDATE church SET plan = $1 WHERE id = $2', ['PRO', church]);
    expect(await new ModuleStateReader(client).isAvailable('needs_good')).toBe(true);
  });
});
