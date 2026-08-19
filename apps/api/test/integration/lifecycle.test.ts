// The request lifecycle from docs/01 §3, exercised through real HTTP against a real
// database. Every guard, the interceptor and the filter are the ones AppModule wires.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { createTestApp, get, tokenFor, type TestApp } from '../support/app.js';

let harness: TestApp;
const church = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  harness = await createTestApp();
  const client = await harness.pool.connect();
  try {
    await ensureAppRole(client);
    await applyMigrations(client, collectMigrations([CORE_MIGRATIONS_DIR]), { appRole: APP_ROLE });
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await harness.close();
});

const staff = () => tokenFor({ sub: 'user-1', church_id: church, roles: ['STAFF'] });
const member = () => tokenFor({ sub: 'user-2', church_id: church, roles: ['MEMBER'] });

describe('authentication', () => {
  it('lets a public route through with no token', async () => {
    expect(await get(harness.app, '/probe/open')).toMatchObject({
      status: 200,
      body: { ok: true },
    });
  });

  it('refuses a protected route with no token, a malformed header, or a bad signature', async () => {
    for (const token of [undefined, 'not-a-jwt', 'eyJhbGciOiJIUzI1NiJ9.e30.wrong']) {
      const response = await get(harness.app, '/probe/tenant', token);
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
    }
  });

  it('returns the contract error envelope, with a request id, on every failure', async () => {
    const { body } = await get(harness.app, '/probe/tenant');
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'requestId']);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('authorization', () => {
  it('allows a route whose permission the role holds', async () => {
    const response = await get(harness.app, '/probe/tenant', await staff());
    expect(response.status).toBe(200);
  });

  it('denies a route whose permission the role lacks, without naming it', async () => {
    const response = await get(harness.app, '/probe/privileged', await member());
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
    expect(JSON.stringify(response.body)).not.toContain('church:manage');
  });

  it('refuses a route that declares no permission at all', async () => {
    // The usual way an authorization system fails is not a wrong rule, it is a route
    // nobody put a rule on. That must fail closed, and loudly.
    const response = await get(harness.app, '/probe/undeclared', await staff());
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('INTERNAL');
  });
});

describe('tenant context', () => {
  it('runs the handler inside the tenant from the token', async () => {
    const response = await get(harness.app, '/probe/tenant', await staff());
    expect(response.body).toEqual({ churchId: church, userId: 'user-1' });
  });

  it('establishes context per request, not once per process', async () => {
    // AsyncLocalStorage set in the wrong place leaks between concurrent requests, and the
    // symptom is one tenant seeing another's data under load. Interleave two tenants.
    const other = '22222222-2222-4222-8222-222222222222';
    const [a, b] = await Promise.all([
      tokenFor({ sub: 'u-a', church_id: church, roles: ['STAFF'] }),
      tokenFor({ sub: 'u-b', church_id: other, roles: ['STAFF'] }),
    ]);
    const responses = await Promise.all([
      get(harness.app, '/probe/tenant', a),
      get(harness.app, '/probe/tenant', b),
      get(harness.app, '/probe/tenant', a),
      get(harness.app, '/probe/tenant', b),
    ]);
    expect(responses.map((r) => r.body.churchId)).toEqual([church, other, church, other]);
  });
});

describe('error handling', () => {
  it('turns an unexpected throw into a bare 500 with nothing internal in it', async () => {
    const response = await get(harness.app, '/probe/boom/plain', await staff());
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: 'INTERNAL', message: 'Something went wrong' });
    expect(JSON.stringify(response.body)).not.toContain('SELECT secrets');
  });

  it('404s an unknown route in the same envelope', async () => {
    const response = await get(harness.app, '/no/such/route');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});
