// Church and campus over real HTTP. The service tests cover the rules; this covers the
// mapping — statuses, shapes, and the path parameter that is not a scope.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { createTestApp, tokenFor, type TestApp } from '../support/app.js';

let harness: TestApp;
const church = 'cafe0000-0000-4000-8000-000000000001';
const other = 'cafe0000-0000-4000-8000-000000000002';
const admin = '00000000-0000-4000-8000-00000000ad00';
let mainCampus = '';

const call = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token?: string,
  body?: unknown,
) => {
  const response = await harness.app.inject({
    method,
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: response.statusCode, body: JSON.parse(response.body || '{}') };
};

const adminToken = () => tokenFor({ sub: admin, church_id: church, roles: ['CHURCH_ADMIN'] });
const memberToken = () => tokenFor({ sub: admin, church_id: church, roles: ['MEMBER'] });

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
  const client = await harness.pool.connect();
  try {
    await client.query('DELETE FROM church WHERE id = ANY($1::uuid[])', [[church, other]]);
  } finally {
    client.release();
    await harness.close();
  }
});

beforeEach(async () => {
  const client = await harness.pool.connect();
  try {
    await client.query('DELETE FROM church WHERE id = ANY($1::uuid[])', [[church, other]]);
    await client.query(`INSERT INTO church (id, name, country) VALUES ($1, 'Ours', 'GB')`, [
      church,
    ]);
    await client.query(`INSERT INTO church (id, name, country) VALUES ($1, 'Theirs', 'US')`, [
      other,
    ]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO campus (church_id, name, is_primary) VALUES ($1, 'Main', true) RETURNING id`,
      [church],
    );
    mainCampus = rows[0]!.id;
    await client.query(`INSERT INTO campus (church_id, name) VALUES ($1, 'Not Yours')`, [other]);
  } finally {
    client.release();
  }
});

describe('the church', () => {
  it('reads and updates it', async () => {
    const token = await adminToken();
    expect((await call('GET', `/churches/${church}`, token)).body).toMatchObject({ name: 'Ours' });

    const updated = await call('PATCH', `/churches/${church}`, token, { name: 'Renamed' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Renamed');
  });

  it('ignores the church named in the path and uses the token', async () => {
    // The path parameter is for routing, never for scoping. Naming someone else's church
    // returns your own — there was never a decision to make, so there is nothing to refuse.
    const token = await adminToken();
    const response = await call('GET', `/churches/${other}`, token);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(church);
    expect(response.body.name).not.toBe('Theirs');
  });

  it('refuses a member', async () => {
    expect(
      (await call('PATCH', `/churches/${church}`, await memberToken(), { name: 'x' })).status,
    ).toBe(403);
  });
});

describe('campuses', () => {
  it('creates, reads, updates and deletes', async () => {
    const token = await adminToken();
    const created = await call('POST', `/churches/${church}/campuses`, token, { name: 'North' });
    expect(created.status).toBe(201);

    const id = created.body.id as string;
    expect((await call('GET', `/campuses/${id}`, token)).body.name).toBe('North');

    const patched = await call('PATCH', `/campuses/${id}`, token, { name: 'North Side' });
    expect(patched.body.name).toBe('North Side');

    expect((await call('DELETE', `/campuses/${id}`, token)).status).toBe(204);
    expect((await call('GET', `/campuses/${id}`, token)).status).toBe(404);
  });

  it('rejects a create with no name', async () => {
    expect(
      (await call('POST', `/churches/${church}/campuses`, await adminToken(), {})).status,
    ).toBe(400);
  });

  it('409s on removing the last campus', async () => {
    const response = await call('DELETE', `/campuses/${mainCampus}`, await adminToken());
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONFLICT');
  });

  it('404s another church campus, identically to one that does not exist', async () => {
    const token = await adminToken();
    const client = await harness.pool.connect();
    let theirs: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM campus WHERE church_id = $1`,
        [other],
      );
      theirs = rows[0]!.id;
    } finally {
      client.release();
    }
    const foreign = await call('GET', `/campuses/${theirs}`, token);
    const missing = await call('GET', `/campuses/00000000-0000-4000-8000-000000000999`, token);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.message).toBe(missing.body.message);
  });

  it('pages with a cursor and reports hasMore', async () => {
    const token = await adminToken();
    for (const name of ['Alpha', 'Bravo', 'Charlie']) {
      await call('POST', `/churches/${church}/campuses`, token, { name });
    }
    const first = await call('GET', `/churches/${church}/campuses?limit=2`, token);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.page.hasMore).toBe(true);

    const second = await call(
      'GET',
      `/churches/${church}/campuses?limit=2&cursor=${encodeURIComponent(first.body.page.nextCursor)}`,
      token,
    );
    const names = [...first.body.data, ...second.body.data].map(
      (campus: { name: string }) => campus.name,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('never lists another church campuses', async () => {
    const { body } = await call(
      'GET',
      `/churches/${church}/campuses?limit=100`,
      await adminToken(),
    );
    expect(JSON.stringify(body)).not.toContain('Not Yours');
  });
});
