// Audit at the boundary: entries written by real requests, and readable only by an
// administrator of the church they belong to.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { loadModules, syncModuleDefinitions } from '@church/module-kit';
import { IdentityService, counterFor, fromBase32, generateCode } from '@church/identity';
import { createTestApp, tokenFor, type TestApp } from '../support/app.js';

const FIXTURES = new URL('../../../../packages/module-kit/test/fixtures/', import.meta.url)
  .pathname;
let harness: TestApp;
const church = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PASSWORD = 'correct horse battery staple';
let adminId = '';

const request = async (method: 'GET' | 'POST', url: string, token?: string, body?: unknown) => {
  const response = await harness.app.inject({
    method,
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: response.statusCode, body: JSON.parse(response.body || '{}') };
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
  const client = await harness.pool.connect();
  try {
    await client.query('DELETE FROM church WHERE id = $1', [church]);
    await client.query(
      `INSERT INTO church (id, name, country, plan) VALUES ($1, 'audit-api', 'US', 'ENTERPRISE')`,
      [church],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO app_user (church_id, email) VALUES ($1, $2) RETURNING id`,
      [church, `admin-${Math.random().toString(36).slice(2)}@example.org`],
    );
    adminId = rows[0]!.id;
  } finally {
    client.release();
  }
});

const admin = () => tokenFor({ sub: adminId, church_id: church, roles: ['CHURCH_ADMIN'] });
const member = () => tokenFor({ sub: adminId, church_id: church, roles: ['MEMBER'] });

describe('entries written by real requests', () => {
  it('records enabling a module, with before and after', async () => {
    const token = await admin();
    await request('POST', `/churches/${church}/modules/good_module/enable`, token);

    const { body } = await request('GET', `/churches/${church}/audit`, token);
    const entries = body.data as Array<Record<string, unknown>>;
    const entry = entries.find((e) => e.action === 'module.enabled');
    expect(entry).toMatchObject({
      resourceType: 'module',
      resourceId: 'good_module',
      actorUserId: adminId,
      actorRoles: ['CHURCH_ADMIN'],
    });
    expect(entry?.before).toEqual({ status: 'disabled' });
    expect(entry?.after).toMatchObject({ status: 'enabled' });
    expect(entry?.changedFields).toContain('status');
  });

  it('records the consent acknowledgement that let a restricted module be enabled', async () => {
    // The line that shows an administrator was told what the module collects before it
    // started collecting it.
    const token = await admin();
    await request('POST', `/churches/${church}/modules/good_module/enable`, token);
    await request('POST', `/churches/${church}/modules/needs_good/enable`, token, {
      acknowledgeRestrictedData: true,
    });

    const { body } = await request('GET', `/churches/${church}/audit?resourceId=needs_good`, token);
    const entry = (body.data as Array<Record<string, unknown>>)[0];
    expect(entry?.reason).toMatch(/acknowledgement/);
  });

  it('records disabling, including when the data becomes purgeable', async () => {
    const token = await admin();
    await request('POST', `/churches/${church}/modules/good_module/enable`, token);
    await request('POST', `/churches/${church}/modules/good_module/disable`, token);

    const { body } = await request(
      'GET',
      `/churches/${church}/audit?action=module.disabled`,
      token,
    );
    const entry = (body.data as Array<Record<string, unknown>>)[0];
    expect(entry?.after).toMatchObject({ status: 'disabled' });
    expect((entry?.after as Record<string, unknown>).purgeAfter).toBeTruthy();
  });

  it('writes nothing when the action was refused', async () => {
    // A refused enable is not a change, and a log full of things that did not happen is
    // worse than no log — it teaches its readers to skim.
    const token = await admin();
    const refused = await request('POST', `/churches/${church}/modules/needs_good/enable`, token, {
      acknowledgeRestrictedData: true,
    });
    expect(refused.status).toBe(409);

    const { body } = await request('GET', `/churches/${church}/audit`, token);
    expect(body.data).toEqual([]);
  });

  it('records a sign-in', async () => {
    const email = `signin-${Math.random().toString(36).slice(2)}@example.org`;
    const created = await new IdentityService({
      pool: harness.pool,
      appRole: APP_ROLE,
      policy: { checkBreaches: false },
    }).register(church, email, PASSWORD);
    if (created.status !== 'created') throw new Error('setup failed');

    const client = await harness.pool.connect();
    try {
      await client.query(
        `INSERT INTO user_role (church_id, user_id, role) VALUES ($1, $2, 'CHURCH_ADMIN')`,
        [church, created.userId],
      );
    } finally {
      client.release();
    }

    // CHURCH_ADMIN must hold a second factor, so the session begins at the end of
    // enrollment rather than at login (REV-004) — and the sign-in has to be audited from
    // there just the same, which is the half of that path this test now covers.
    const login = await request('POST', '/auth/login', undefined, { email, password: PASSWORD });
    expect(login.body.status).toBe('mfa_enrollment_required');
    const enrollmentTicket = login.body.enrollmentTicket as string;

    const started = await request('POST', '/auth/mfa/enroll', undefined, { enrollmentTicket });
    const confirmed = await request('POST', '/auth/mfa/enroll/confirm', undefined, {
      enrollmentTicket,
      code: generateCode(fromBase32((started.body as { secret: string }).secret), counterFor()),
    });
    const token = (confirmed.body.tokens as { accessToken: string }).accessToken;

    const { body } = await request(
      'GET',
      `/churches/${church}/audit?action=session.started`,
      token,
    );
    const entry = (body.data as Array<Record<string, unknown>>)[0];
    expect(entry?.actorUserId).toBe(created.userId);
  });
});

describe('reading', () => {
  it('needs audit:read', async () => {
    const { status, body } = await request('GET', `/churches/${church}/audit`, await member());
    expect(status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
  });

  it('shows a church its own history and nothing else', async () => {
    const token = await admin();
    await request('POST', `/churches/${church}/modules/good_module/enable`, token);

    const other = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const client = await harness.pool.connect();
    try {
      await client.query('DELETE FROM church WHERE id = $1', [other]);
      await client.query(`INSERT INTO church (id, name, country) VALUES ($1, 'other', 'US')`, [
        other,
      ]);
      await client.query(
        `INSERT INTO audit_entry (church_id, action, resource_type, reason)
         VALUES ($1, 'medical_note.read', 'medical_note', 'their private business')`,
        [other],
      );
    } finally {
      client.release();
    }

    const { body } = await request('GET', `/churches/${church}/audit`, token);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('their private business');
    expect(serialized).not.toContain('medical_note');

    const cleanup = await harness.pool.connect();
    try {
      await cleanup.query('DELETE FROM church WHERE id = $1', [other]);
    } finally {
      cleanup.release();
    }
  });

  it('offers a cursor only when the page is full', async () => {
    const token = await admin();
    await request('POST', `/churches/${church}/modules/good_module/enable`, token);
    await request('POST', `/churches/${church}/modules/good_module/disable`, token);

    const full = await request('GET', `/churches/${church}/audit?limit=1`, token);
    expect(full.body.nextCursor).toBeTruthy();

    const short = await request('GET', `/churches/${church}/audit?limit=50`, token);
    expect(short.body.nextCursor).toBeUndefined();
  });
});
