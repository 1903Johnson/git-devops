// ModuleGuard: a module a tenant has not enabled must be indistinguishable from a module
// that does not exist.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { loadModules, syncModuleDefinitions } from '@church/module-kit';
import { createTestApp, get, tokenFor, type TestApp } from '../support/app.js';

const FIXTURES = new URL('../../../../packages/module-kit/test/fixtures/', import.meta.url)
  .pathname;

let harness: TestApp;
const church = '77777777-7777-4777-8777-777777777777';

beforeAll(async () => {
  harness = await createTestApp();
  const client = await harness.pool.connect();
  try {
    await ensureAppRole(client);
    await applyMigrations(client, collectMigrations([CORE_MIGRATIONS_DIR]), { appRole: APP_ROLE });
    await syncModuleDefinitions(
      client,
      (await loadModules(FIXTURES)).map((m) => m.manifest),
    );
    await client.query('DELETE FROM church WHERE id = $1', [church]);
    await client.query(`INSERT INTO church (id, name, country) VALUES ($1, 'guard', 'US')`, [
      church,
    ]);
  } finally {
    client.release();
  }
});

afterAll(async () => {
  const client = await harness.pool.connect();
  try {
    await client.query('DELETE FROM church WHERE id = $1', [church]);
  } finally {
    client.release();
    await harness.close();
  }
});

const setStatus = async (status: string | null) => {
  const client = await harness.pool.connect();
  try {
    if (status === null) {
      await client.query('DELETE FROM church_module WHERE church_id = $1', [church]);
      return;
    }
    await client.query(
      `INSERT INTO church_module (church_id, module_key, status, enabled_at, purged_at)
       VALUES ($1, 'good_module', $2,
               CASE WHEN $2 = 'enabled' THEN now() END,
               CASE WHEN $2 = 'purged' THEN now() END)
       ON CONFLICT (church_id, module_key) DO UPDATE
         SET status = EXCLUDED.status,
             enabled_at = EXCLUDED.enabled_at,
             purged_at = EXCLUDED.purged_at`,
      [church, status],
    );
  } finally {
    client.release();
  }
};

const staff = () => tokenFor({ sub: 'guard-user', church_id: church, roles: ['STAFF'] });

describe('a module route', () => {
  it('is reachable when the tenant has the module enabled', async () => {
    await setStatus('enabled');
    expect(await get(harness.app, '/probe/module/thing', await staff())).toMatchObject({
      status: 200,
      body: { ok: true },
    });
  });

  it('404s — not 403 — for every state that is not enabled', async () => {
    // 403 would confirm the module exists for a tenant that has not enabled it, which
    // tells a caller what the deployment supports and what their church has not bought.
    for (const status of ['disabled', 'pending_purge', 'purged', null]) {
      await setStatus(status);
      const response = await get(harness.app, '/probe/module/thing', await staff());
      expect(response.status, `status=${status}`).toBe(404);
      expect(response.body.code, `status=${status}`).toBe('MODULE_NOT_ENABLED');
    }
  });

  it('answers with the same status as a route that does not exist', async () => {
    // Status parity is the invariant that matters: anything probing by status code — a
    // proxy, a scanner, an unauthenticated crawler — learns nothing from the difference.
    //
    // The `code` deliberately does differ, and that is not an oversight. By the time this
    // guard runs, AuthGuard and PolicyGuard have already established that the caller is
    // authenticated in this church and holds the permission. Telling *that* person their
    // church has not enabled a feature is the intended behaviour — it is what lets the SDK
    // show "this feature isn't enabled for your church" instead of a dead end. Someone who
    // could learn something they should not have been stopped two guards earlier.
    await setStatus('disabled');
    const disabled = await get(harness.app, '/probe/module/thing', await staff());
    const imaginary = await get(harness.app, '/probe/module/nothing-here', await staff());
    expect(disabled.status).toBe(404);
    expect(imaginary.status).toBe(404);
  });

  it('tells an unauthorized caller nothing at all about the module', async () => {
    // The other half of the same argument: without the permission, the answer is 403 and
    // carries no module information, whether the module is on, off, or imaginary.
    const member = await tokenFor({ sub: 'nosy', church_id: church, roles: ['MEMBER'] });
    for (const status of ['enabled', 'disabled', null]) {
      await setStatus(status);
      const response = await get(harness.app, '/probe/module/thing', member);
      expect(response.status, `status=${status}`).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain('good_module');
    }
  });

  it('checks permission before it checks the module', async () => {
    // Ordering matters: a caller who may not use the feature at all should not learn
    // whether their church has it enabled.
    await setStatus('enabled');
    const member = await tokenFor({ sub: 'm', church_id: church, roles: ['MEMBER'] });
    const response = await get(harness.app, '/probe/module/thing', member);
    expect(response.status).toBe(403);
  });

  it('takes effect immediately when the module is disabled', async () => {
    // docs/02 §3 requires that disabling withdraws routes at once — sometimes it is a
    // safeguarding decision. A cached lookup would leave the route live for the TTL.
    await setStatus('enabled');
    expect((await get(harness.app, '/probe/module/thing', await staff())).status).toBe(200);
    await setStatus('disabled');
    expect((await get(harness.app, '/probe/module/thing', await staff())).status).toBe(404);
  });

  it('leaves core routes alone', async () => {
    await setStatus(null);
    expect((await get(harness.app, '/probe/tenant', await staff())).status).toBe(200);
  });

  it('does not leak one church enablement to another', async () => {
    await setStatus('enabled');
    const other = await tokenFor({
      sub: 'other',
      church_id: '88888888-8888-4888-8888-888888888888',
      roles: ['STAFF'],
    });
    const response = await get(harness.app, '/probe/module/thing', other);
    expect(response.status).toBe(404);
  });
});

describe('entitlement at the guard', () => {
  it('404s an enabled module the plan no longer covers', async () => {
    // The downgrade case. Billing switching modules off on downgrade is a background job,
    // and a background job that has not run yet must not mean a church keeps using
    // something it stopped paying for.
    await setStatus('enabled');
    const client = await harness.pool.connect();
    try {
      await client.query(`UPDATE module_definition SET min_plan = 'PRO' WHERE key = 'good_module'`);
      const response = await get(harness.app, '/probe/module/thing', await staff());
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('MODULE_NOT_ENABLED');
    } finally {
      await client.query(
        `UPDATE module_definition SET min_plan = 'FREE' WHERE key = 'good_module'`,
      );
      client.release();
    }
  });
});
