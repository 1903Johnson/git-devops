// Tenant isolation proved at the HTTP boundary.
//
// The package suites prove RLS holds when a query runs inside `runWithTenant`. This one
// proves the API actually puts it there — that a bearer token for church A cannot reach
// church B's rows through a real request, with no test-only shortcut in the path. It is the
// difference between "the database is safe" and "the product is safe".

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { createTestApp, get, tokenFor, type TestApp } from '../support/app.js';

let harness: TestApp;
const churchA = '33333333-3333-4333-8333-333333333333';
const churchB = '44444444-4444-4444-8444-444444444444';
let campusA = '';
let campusB = '';

beforeAll(async () => {
  harness = await createTestApp();
  const client = await harness.pool.connect();
  try {
    await ensureAppRole(client);
    await applyMigrations(client, collectMigrations([CORE_MIGRATIONS_DIR]), { appRole: APP_ROLE });
    // Committed, not rolled back: the request under test runs on a different connection
    // from this one, so an open transaction's rows would be invisible to it.
    await client.query('DELETE FROM church WHERE id = ANY($1::uuid[])', [[churchA, churchB]]);
    for (const [id, name] of [
      [churchA, 'iso-a'],
      [churchB, 'iso-b'],
    ]) {
      await client.query('INSERT INTO church (id, name, country) VALUES ($1, $2, $3)', [
        id,
        name,
        'US',
      ]);
    }
    const a = await client.query<{ id: string }>(
      `INSERT INTO campus (church_id, name) VALUES ($1, 'A Main') RETURNING id`,
      [churchA],
    );
    const b = await client.query<{ id: string }>(
      `INSERT INTO campus (church_id, name) VALUES ($1, 'B Main') RETURNING id`,
      [churchB],
    );
    campusA = a.rows[0]!.id;
    campusB = b.rows[0]!.id;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  const client = await harness.pool.connect();
  try {
    await client.query('DELETE FROM church WHERE id = ANY($1::uuid[])', [[churchA, churchB]]);
  } finally {
    client.release();
    await harness.close();
  }
});

const staffOf = (churchId: string) =>
  tokenFor({ sub: `user-${churchId.slice(0, 4)}`, church_id: churchId, roles: ['STAFF'] });

describe('a request sees only its own church', () => {
  it('returns church A its campus and not church B', async () => {
    const response = await get(harness.app, '/probe/campuses', await staffOf(churchA));
    expect(response.status).toBe(200);
    expect(response.body.ids).toEqual([campusA]);
    expect(response.body.ids).not.toContain(campusB);
  });

  it('returns church B its campus and not church A', async () => {
    // Both directions, because a filter that happens to match one tenant proves nothing.
    const response = await get(harness.app, '/probe/campuses', await staffOf(churchB));
    expect(response.body.ids).toEqual([campusB]);
    expect(response.body.ids).not.toContain(campusA);
  });

  it('keeps them separate when both are in flight at once', async () => {
    // Tenant context lives in AsyncLocalStorage. If it were established anywhere shared —
    // module scope, a pool-level setting, a connection reused across requests — this is the
    // test that would catch it, and the bug it catches is one church reading another's data
    // under ordinary load.
    const [a, b] = [await staffOf(churchA), await staffOf(churchB)];
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => get(harness.app, '/probe/campuses', i % 2 ? b : a)),
    );
    for (const [index, response] of responses.entries()) {
      expect(response.body.ids).toEqual([index % 2 ? campusB : campusA]);
    }
  });

  it('does not honour a church id supplied by the caller', async () => {
    // The tenant comes from the signed token and nowhere else. A query string or header
    // that could override it would make every other control in the stack decorative.
    const response = await get(
      harness.app,
      `/probe/campuses?churchId=${churchB}&church_id=${churchB}`,
      await staffOf(churchA),
    );
    expect(response.body.ids).toEqual([campusA]);
  });

  it('sees nothing at all for a church with no rows', async () => {
    const empty = '55555555-5555-4555-8555-555555555555';
    const response = await get(harness.app, '/probe/campuses', await staffOf(empty));
    expect(response.status).toBe(200);
    expect(response.body.ids).toEqual([]);
  });
});
