// Church and campus services against a real database, through the real tenancy layer.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { ForbiddenError, type Subject } from '@church/policy';
import { TenantDatabase, type TenantTransaction, runWithTenant } from '@church/tenancy';
import { CampusService, ChurchService, LastCampusError, NotFoundError } from '../../src/index.js';

let pool: Pool;
let admin: PoolClient;
let db: TenantDatabase;

const church = '22222222-3333-4444-8555-666666666666';
const churches = new ChurchService();
const campuses = new CampusService();

const u1 = '00000000-0000-4000-8000-00000000000a';
const u2 = '00000000-0000-4000-8000-00000000000b';
const u3 = '00000000-0000-4000-8000-00000000000c';

const staff: Subject = { userId: u1, churchId: church, roles: ['STAFF'] };
const churchAdmin: Subject = { userId: u2, churchId: church, roles: ['CHURCH_ADMIN'] };
const member: Subject = { userId: u3, churchId: church, roles: ['MEMBER'] };

const asTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> =>
  runWithTenant({ churchId: church, userId: u2, roles: ['CHURCH_ADMIN'] }, () =>
    db.transaction(fn),
  );

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, max: 4 });
  admin = await pool.connect();
  await ensureAppRole(admin);
  await applyMigrations(admin, collectMigrations([CORE_MIGRATIONS_DIR]), { appRole: APP_ROLE });
  db = new TenantDatabase(pool, { appRole: APP_ROLE });
});

afterAll(async () => {
  await admin.query('DELETE FROM church WHERE id = $1', [church]);
  admin.release();
  await pool.end();
});

beforeEach(async () => {
  await admin.query('DELETE FROM church WHERE id = $1', [church]);
  await admin.query(
    `INSERT INTO church (id, name, country, timezone) VALUES ($1, 'St Anywhere', 'GB', 'Europe/London')`,
    [church],
  );
  await admin.query(`INSERT INTO campus (church_id, name, is_primary) VALUES ($1, 'Main', true)`, [
    church,
  ]);
});

describe('reading the church', () => {
  it('returns the caller own church', async () => {
    const result = await asTenant((tx) => churches.get(tx, staff));
    expect(result).toMatchObject({ id: church, name: 'St Anywhere', country: 'GB' });
  });

  it('refuses a caller without church:read', async () => {
    const noRoles: Subject = { userId: u1, churchId: church, roles: [] };
    await expect(asTenant((tx) => churches.get(tx, noRoles))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('updating the church', () => {
  it('applies the changes and normalises the country code', async () => {
    const updated = await asTenant((tx) =>
      churches.update(tx, churchAdmin, { name: 'St Somewhere', country: 'us' }),
    );
    expect(updated).toMatchObject({ name: 'St Somewhere', country: 'US' });
  });

  it('leaves status and plan alone', async () => {
    // ChurchUpdate omits both. A church lifting its own suspension or promoting its own
    // plan would be a billing bypass, and neither is this service's to change.
    await admin.query(`UPDATE church SET status = 'suspended', plan = 'FREE' WHERE id = $1`, [
      church,
    ]);
    await asTenant((tx) => churches.update(tx, churchAdmin, { name: 'Renamed' }));
    const { rows } = await admin.query<{ status: string; plan: string }>(
      'SELECT status, plan FROM church WHERE id = $1',
      [church],
    );
    expect(rows[0]).toEqual({ status: 'suspended', plan: 'FREE' });
  });

  it('refuses a member', async () => {
    await expect(
      asTenant((tx) => churches.update(tx, member, { name: 'Nope' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('writes an audit entry with before and after', async () => {
    await asTenant((tx) => churches.update(tx, churchAdmin, { name: 'Audited' }));
    const { rows } = await admin.query<{ action: string; changed_fields: string[] }>(
      `SELECT action, changed_fields FROM audit_entry WHERE church_id = $1 ORDER BY seq DESC`,
      [church],
    );
    expect(rows[0]?.action).toBe('church.updated');
    expect(rows[0]?.changed_fields).toEqual(['name']);
  });

  it('does nothing, and records nothing, for an empty patch', async () => {
    await asTenant((tx) => churches.update(tx, churchAdmin, {}));
    const { rowCount } = await admin.query('SELECT 1 FROM audit_entry WHERE church_id = $1', [
      church,
    ]);
    expect(rowCount).toBe(0);
  });
});

describe('campuses', () => {
  it('creates one and reads it back', async () => {
    const created = await asTenant((tx) => campuses.create(tx, churchAdmin, { name: 'North' }));
    expect(created).toMatchObject({ name: 'North', churchId: church, isPrimary: false });

    const fetched = await asTenant((tx) => campuses.get(tx, staff, created.id));
    expect(fetched.id).toBe(created.id);
  });

  it('never lets a caller name the church it belongs to', async () => {
    // CampusCreate has no churchId, and the repository supplies it from the tenant context.
    // Passing another church's id is rejected rather than silently overwritten.
    const created = await asTenant((tx) =>
      campuses.create(tx, churchAdmin, {
        name: 'Smuggled',
        churchId: '99999999-9999-4999-8999-999999999999',
      } as never),
    );
    expect(created.churchId).toBe(church);
  });

  it('keeps exactly one primary campus', async () => {
    const north = await asTenant((tx) =>
      campuses.create(tx, churchAdmin, { name: 'North', isPrimary: true }),
    );
    const { rows } = await admin.query<{ id: string; is_primary: boolean }>(
      'SELECT id, is_primary FROM campus WHERE church_id = $1',
      [church],
    );
    expect(rows.filter((row) => row.is_primary).map((row) => row.id)).toEqual([north.id]);
  });

  it('reports a missing campus the same way as another church campus', async () => {
    // RLS has already hidden the other church's row, so both cases are "not here" — and
    // saying anything different would confirm that an id exists somewhere.
    const other = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
    await admin.query(`INSERT INTO church (id, name, country) VALUES ($1, 'Elsewhere', 'US')`, [
      other,
    ]);
    const theirs = await admin.query<{ id: string }>(
      `INSERT INTO campus (church_id, name) VALUES ($1, 'Theirs') RETURNING id`,
      [other],
    );
    try {
      const missing = asTenant((tx) =>
        campuses.get(tx, staff, '00000000-0000-4000-8000-000000000000'),
      );
      const foreign = asTenant((tx) => campuses.get(tx, staff, theirs.rows[0]!.id));
      await expect(missing).rejects.toBeInstanceOf(NotFoundError);
      await expect(foreign).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await admin.query('DELETE FROM church WHERE id = $1', [other]);
    }
  });

  it('refuses to remove the last campus', async () => {
    // Every person, event and attendance record can name a campus. A church with none
    // leaves all of them pointing at nothing, in a state with no screen to fix it from.
    const { rows } = await admin.query<{ id: string }>(
      'SELECT id FROM campus WHERE church_id = $1',
      [church],
    );
    await expect(
      asTenant((tx) => campuses.remove(tx, churchAdmin, rows[0]!.id)),
    ).rejects.toBeInstanceOf(LastCampusError);
  });

  it('removes one when another remains', async () => {
    const north = await asTenant((tx) => campuses.create(tx, churchAdmin, { name: 'North' }));
    await asTenant((tx) => campuses.remove(tx, churchAdmin, north.id));
    const { rowCount } = await admin.query('SELECT 1 FROM campus WHERE id = $1', [north.id]);
    expect(rowCount).toBe(0);
  });

  it('refuses a member', async () => {
    await expect(
      asTenant((tx) => campuses.create(tx, member, { name: 'Nope' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('paging campuses', () => {
  beforeEach(async () => {
    await admin.query('DELETE FROM campus WHERE church_id = $1', [church]);
    for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) {
      await admin.query('INSERT INTO campus (church_id, name) VALUES ($1, $2)', [church, name]);
    }
  });

  it('walks every campus exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await asTenant((tx) =>
        campuses.list(tx, staff, { limit: 2, ...(cursor ? { cursor } : {}) }),
      );
      seen.push(...page.data.map((campus) => campus.name));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
  });

  it('offers no cursor on the last page', async () => {
    const page = await asTenant((tx) => campuses.list(tx, staff, { limit: 50 }));
    expect(page.data).toHaveLength(5);
    expect(page.nextCursor).toBeUndefined();
  });

  it('does not skip a row inserted before an earlier page', async () => {
    // The failure an offset would produce: insert a row that sorts first, then read page
    // two. With OFFSET 2 the reader silently never sees 'Bravo'.
    const first = await asTenant((tx) => campuses.list(tx, staff, { limit: 2 }));
    await admin.query('INSERT INTO campus (church_id, name) VALUES ($1, $2)', [church, 'Aardvark']);
    const second = await asTenant((tx) =>
      campuses.list(tx, staff, { limit: 2, cursor: first.nextCursor! }),
    );
    expect(second.data.map((campus) => campus.name)).toEqual(['Charlie', 'Delta']);
  });

  it('pages correctly when two campuses share a name', async () => {
    // Sorted by (name, id), because a church that opens "North" in two towns is not doing
    // anything wrong — and a cursor over a non-unique key repeats or skips a row.
    await admin.query('DELETE FROM campus WHERE church_id = $1', [church]);
    for (let i = 0; i < 4; i += 1) {
      await admin.query('INSERT INTO campus (church_id, name) VALUES ($1, $2)', [church, 'North']);
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await asTenant((tx) =>
        campuses.list(tx, staff, { limit: 2, ...(cursor ? { cursor } : {}) }),
      );
      ids.push(...page.data.map((campus) => campus.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('caps the page size', async () => {
    const page = await asTenant((tx) => campuses.list(tx, staff, { limit: 10_000 }));
    expect(page.data.length).toBeLessThanOrEqual(100);
  });

  it('starts from the beginning for a junk cursor', async () => {
    const page = await asTenant((tx) => campuses.list(tx, staff, { limit: 2, cursor: 'nonsense' }));
    expect(page.data.map((campus) => campus.name)).toEqual(['Alpha', 'Bravo']);
  });
});
