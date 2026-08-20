// The module administration API. Entitlement, consent and dependency rules over real HTTP.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { loadModules, syncModuleDefinitions } from '@church/module-kit';
import { apiPath, createTestApp, tokenFor, type TestApp } from '../support/app.js';

const FIXTURES = new URL('../../../../packages/module-kit/test/fixtures/', import.meta.url)
  .pathname;

let harness: TestApp;
const church = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const request = async (
  method: 'GET' | 'POST',
  url: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await harness.app.inject({
    method,
    url: apiPath(url),
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: response.statusCode, body: JSON.parse(response.body || '{}') };
};

// A real user row, because church_module.enabled_by is a foreign key into app_user: the
// audit trail is only worth having if it points at someone who exists.
let adminId = '';

const setPlan = async (plan: string) => {
  const client = await harness.pool.connect();
  try {
    await client.query('DELETE FROM church WHERE id = $1', [church]);
    await client.query(
      `INSERT INTO church (id, name, country, plan) VALUES ($1, 'api', 'US', $2)`,
      [church, plan],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO app_user (church_id, email) VALUES ($1, $2) RETURNING id`,
      [church, `admin-${Math.random().toString(36).slice(2)}@example.org`],
    );
    adminId = rows[0]!.id;
  } finally {
    client.release();
  }
};

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

beforeEach(async () => {
  await setPlan('ENTERPRISE');
});

const admin = () => tokenFor({ sub: adminId, church_id: church, roles: ['CHURCH_ADMIN'] });
const member = () => tokenFor({ sub: adminId, church_id: church, roles: ['MEMBER'] });
const base = `/churches/${church}/modules`;

describe('listing', () => {
  it('returns the whole catalogue with per-church state', async () => {
    const { status, body } = await request('GET', base, await admin());
    expect(status).toBe(200);
    const data = body.data as Array<Record<string, unknown>>;
    expect(data.map((m) => m.key)).toEqual(['good_module', 'needs_good']);
    expect(data[0]).toMatchObject({ status: 'disabled', entitled: true, available: false });
  });

  it('includes modules the plan does not cover, so the upgrade path is visible', async () => {
    // Hiding them would also hide the upgrade path, and an admin cannot ask for what they
    // cannot see.
    await setPlan('FREE');
    const { body } = await request('GET', base, await admin());
    const data = body.data as Array<Record<string, unknown>>;
    const gated = data.find((m) => m.key === 'needs_good');
    expect(gated).toMatchObject({ entitled: false, available: false, minPlan: 'PRO' });
  });

  it('flags which modules need a consent acknowledgement', async () => {
    const { body } = await request('GET', base, await admin());
    const data = body.data as Array<Record<string, unknown>>;
    expect(data.find((m) => m.key === 'good_module')?.requiresConsent).toBe(false);
    expect(data.find((m) => m.key === 'needs_good')?.requiresConsent).toBe(true);
  });

  it('refuses a caller without module:manage', async () => {
    const { status, body } = await request('GET', base, await member());
    expect(status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
  });
});

describe('enabling', () => {
  it('turns a module on and reports it available', async () => {
    const { status, body } = await request('POST', `${base}/good_module/enable`, await admin());
    expect(status).toBe(201);
    expect(body).toMatchObject({ key: 'good_module', status: 'enabled', available: true });
    expect(body.enabledAt).not.toBeNull();
  });

  it('answers PLAN_UPGRADE_REQUIRED, not FORBIDDEN, when the plan is too low', async () => {
    // Different remedies need different screens: "ask your administrator" and "your plan
    // does not include this" are not the same problem.
    await setPlan('FREE');
    const { status, body } = await request('POST', `${base}/needs_good/enable`, await admin());
    expect(status).toBe(403);
    expect(body.code).toBe('PLAN_UPGRADE_REQUIRED');
  });

  it('refuses a module collecting restricted data without an acknowledgement', async () => {
    await request('POST', `${base}/good_module/enable`, await admin());
    const { status, body } = await request('POST', `${base}/needs_good/enable`, await admin());
    expect(status).toBe(400);
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('accepts it with one', async () => {
    await request('POST', `${base}/good_module/enable`, await admin());
    const { status, body } = await request('POST', `${base}/needs_good/enable`, await admin(), {
      acknowledgeRestrictedData: true,
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ status: 'enabled', available: true });
  });

  it('409s when a required module is off', async () => {
    const { status, body } = await request('POST', `${base}/needs_good/enable`, await admin(), {
      acknowledgeRestrictedData: true,
    });
    expect(status).toBe(409);
    expect(body.code).toBe('CONFLICT');
  });

  it('404s an unknown module', async () => {
    const { status, body } = await request('POST', `${base}/imaginary/enable`, await admin());
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('refuses a caller without module:manage', async () => {
    const { status } = await request('POST', `${base}/good_module/enable`, await member());
    expect(status).toBe(403);
  });
});

describe('disabling', () => {
  it('retains data and reports when it becomes purgeable', async () => {
    await request('POST', `${base}/good_module/enable`, await admin());
    const { status, body } = await request('POST', `${base}/good_module/disable`, await admin());
    expect(status).toBe(201);
    expect(body).toMatchObject({ status: 'disabled', available: false });
    expect(body.purgeAfter).not.toBeNull();
  });

  it('409s while another enabled module requires it', async () => {
    await request('POST', `${base}/good_module/enable`, await admin());
    await request('POST', `${base}/needs_good/enable`, await admin(), {
      acknowledgeRestrictedData: true,
    });
    const { status, body } = await request('POST', `${base}/good_module/disable`, await admin());
    expect(status).toBe(409);
    expect(body.code).toBe('CONFLICT');
  });

  it('stops the purge clock when re-enabled', async () => {
    await request('POST', `${base}/good_module/enable`, await admin());
    await request('POST', `${base}/good_module/disable`, await admin());
    const { body } = await request('POST', `${base}/good_module/enable`, await admin());
    expect(body).toMatchObject({ status: 'enabled', purgeAfter: null, disabledAt: null });
  });
});

describe('one church cannot administer another', () => {
  it('sees its own state, not a neighbour is', async () => {
    await request('POST', `${base}/good_module/enable`, await admin());
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const client = await harness.pool.connect();
    try {
      await client.query('DELETE FROM church WHERE id = $1', [other]);
      await client.query(`INSERT INTO church (id, name, country) VALUES ($1, 'other', 'US')`, [
        other,
      ]);
    } finally {
      client.release();
    }
    const outsider = await tokenFor({
      sub: '00000000-0000-4000-8000-000000000001',
      church_id: other,
      roles: ['CHURCH_ADMIN'],
    });
    // The path names this church; the tenant comes from the token, and the token wins.
    const { body } = await request('GET', base, outsider);
    const data = body.data as Array<Record<string, unknown>>;
    expect(data.find((m) => m.key === 'good_module')).toMatchObject({ status: 'disabled' });

    const cleanup = await harness.pool.connect();
    try {
      await cleanup.query('DELETE FROM church WHERE id = $1', [other]);
    } finally {
      cleanup.release();
    }
  });
});
