// People and families over real HTTP. The service tests cover the rules; this covers the
// mapping — statuses, query parsing, and the contract shapes going out on the wire.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { apiPath, createTestApp, tokenFor, type TestApp } from '../support/app.js';

let harness: TestApp;
const church = 'dede0000-0000-4000-8000-000000000001';
const staffId = '00000000-0000-4000-8000-0000000cc000';

const call = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token?: string,
  body?: unknown,
) => {
  const response = await harness.app.inject({
    method,
    url: apiPath(url),
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: response.statusCode, body: JSON.parse(response.body || '{}') };
};

const staff = () => tokenFor({ sub: staffId, church_id: church, roles: ['STAFF'] });
const member = () => tokenFor({ sub: staffId, church_id: church, roles: ['MEMBER'] });

const newPerson = async (first: string, last: string, extra: Record<string, unknown> = {}) => {
  const created = await call('POST', `/churches/${church}/people`, await staff(), {
    firstName: first,
    lastName: last,
    ...extra,
  });
  return created.body as { id: string };
};

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
    await client.query(`INSERT INTO church (id, name, country) VALUES ($1, 'People API', 'GB')`, [
      church,
    ]);
    await client.query(`INSERT INTO app_user (church_id, id, email) VALUES ($1, $2, $3)`, [
      church,
      staffId,
      `staff-${Math.random().toString(36).slice(2)}@example.org`,
    ]);
  } finally {
    client.release();
  }
});

describe('people', () => {
  it('creates, reads, updates and archives', async () => {
    const token = await staff();
    const created = await call('POST', `/churches/${church}/people`, token, {
      firstName: 'Jo',
      lastName: 'Smith',
      dateOfBirth: '2015-06-15',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ firstName: 'Jo', status: 'visitor' });

    const id = created.body.id as string;
    // The birthday must survive the round trip exactly; a timezone shift here puts a child
    // in the wrong class.
    expect((await call('GET', `/people/${id}`, token)).body.dateOfBirth).toBe('2015-06-15');

    const patched = await call('PATCH', `/people/${id}`, token, { preferredName: 'Jojo' });
    expect(patched.body.preferredName).toBe('Jojo');

    expect((await call('DELETE', `/people/${id}`, token)).status).toBe(204);
    // Archived, not deleted: still fetchable, and gone from the directory.
    expect((await call('GET', `/people/${id}`, token)).body.archivedAt).not.toBeNull();
    const listed = await call('GET', `/churches/${church}/people`, token);
    expect((listed.body.data as { id: string }[]).map((p) => p.id)).not.toContain(id);
  });

  it('rejects a create with no name', async () => {
    expect((await call('POST', `/churches/${church}/people`, await staff(), {})).status).toBe(400);
  });

  it('404s a person who does not exist', async () => {
    const response = await call(
      'GET',
      '/people/00000000-0000-4000-8000-000000000000',
      await staff(),
    );
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('refuses a member trying to create', async () => {
    const response = await call('POST', `/churches/${church}/people`, await member(), {
      firstName: 'No',
      lastName: 'Chance',
    });
    expect(response.status).toBe(403);
  });

  it('only reveals archived people for the literal string true', async () => {
    // `?includeArchived=0` and `?includeArchived=false` must not reveal people who have
    // left. Truthiness on a query string is how that goes wrong.
    const token = await staff();
    const person = await newPerson('Gone', 'Away');
    await call('DELETE', `/people/${person.id}`, token);

    for (const value of ['0', 'false', 'no', '']) {
      const listed = await call(
        'GET',
        `/churches/${church}/people?includeArchived=${value}`,
        token,
      );
      expect(
        (listed.body.data as { id: string }[]).map((p) => p.id),
        value,
      ).not.toContain(person.id);
    }
    const revealed = await call('GET', `/churches/${church}/people?includeArchived=true`, token);
    expect((revealed.body.data as { id: string }[]).map((p) => p.id)).toContain(person.id);
  });

  it('pages and reports hasMore', async () => {
    const token = await staff();
    for (const last of ['Alpha', 'Bravo', 'Charlie']) await newPerson('X', last);
    const first = await call('GET', `/churches/${church}/people?limit=2`, token);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.page.hasMore).toBe(true);

    const second = await call(
      'GET',
      `/churches/${church}/people?limit=2&cursor=${encodeURIComponent(first.body.page.nextCursor)}`,
      token,
    );
    expect(second.body.page.hasMore).toBe(false);
  });
});

describe('membership history', () => {
  it('changes status and records it', async () => {
    const token = await staff();
    const person = await newPerson('Growing', 'Member');

    const changed = await call('POST', `/people/${person.id}/status`, token, {
      status: 'member',
      note: 'joined at Easter',
    });
    expect(changed.status).toBe(201);
    expect(changed.body).toMatchObject({ status: 'member', note: 'joined at Easter' });

    const history = await call('GET', `/people/${person.id}/status`, token);
    expect((history.body as { status: string }[]).map((e) => e.status)).toEqual([
      'member',
      'visitor',
    ]);
    expect((await call('GET', `/people/${person.id}`, token)).body.status).toBe('member');
  });

  it('rejects a change with no status', async () => {
    const person = await newPerson('No', 'Status');
    expect((await call('POST', `/people/${person.id}/status`, await staff(), {})).status).toBe(400);
  });
});

describe('milestones', () => {
  it('records one and lists it', async () => {
    const token = await staff();
    const person = await newPerson('Baptised', 'Person');
    const created = await call('POST', `/people/${person.id}/milestones`, token, {
      type: 'baptism',
      occurredOn: '1974-04-14',
    });
    expect(created.status).toBe(201);
    expect(created.body.occurredOn).toBe('1974-04-14');

    const listed = await call('GET', `/people/${person.id}/milestones`, token);
    expect(listed.body).toHaveLength(1);
  });

  it('rejects one with no date', async () => {
    const person = await newPerson('No', 'Date');
    const response = await call('POST', `/people/${person.id}/milestones`, await staff(), {
      type: 'baptism',
    });
    expect(response.status).toBe(400);
  });
});

describe('families', () => {
  it('creates a household with members and reads it back whole', async () => {
    const token = await staff();
    const parent = await newPerson('Pat', 'Household');
    const child = await newPerson('Kid', 'Household');

    const created = await call('POST', `/churches/${church}/families`, token, {
      name: 'The Households',
      members: [
        { personId: parent.id, relationship: 'parent' },
        { personId: child.id, relationship: 'child' },
      ],
    });
    expect(created.status).toBe(201);

    const fetched = await call('GET', `/families/${created.body.id}`, token);
    expect(fetched.body.members).toHaveLength(2);
    // Embedded, so a household renders in one call.
    expect(fetched.body.members[0].person).toMatchObject({ lastName: 'Household' });
  });

  it('adds and removes a member', async () => {
    const token = await staff();
    const person = await newPerson('Joins', 'Later');
    const family = await call('POST', `/churches/${church}/families`, token, { name: 'Growing' });

    const added = await call('POST', `/families/${family.body.id}/members`, token, {
      personId: person.id,
      relationship: 'other',
    });
    expect(added.status).toBe(201);

    const removed = await call('DELETE', `/families/${family.body.id}/members/${person.id}`, token);
    expect(removed.status).toBe(204);
  });

  it('409s adding the same person twice', async () => {
    const token = await staff();
    const person = await newPerson('Only', 'Once');
    const family = await call('POST', `/churches/${church}/families`, token, { name: 'Once' });
    await call('POST', `/families/${family.body.id}/members`, token, {
      personId: person.id,
      relationship: 'other',
    });
    const again = await call('POST', `/families/${family.body.id}/members`, token, {
      personId: person.id,
      relationship: 'other',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('CONFLICT');
  });

  it('omits members from the list', async () => {
    const token = await staff();
    await call('POST', `/churches/${church}/families`, token, { name: 'Listed' });
    const listed = await call('GET', `/churches/${church}/families`, token);
    expect(listed.body.data[0].members).toBeUndefined();
  });

  it('refuses a member trying to write', async () => {
    const response = await call('POST', `/churches/${church}/families`, await member(), {
      name: 'Nope',
    });
    expect(response.status).toBe(403);
  });
});
