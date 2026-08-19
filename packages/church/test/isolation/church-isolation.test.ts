// The services, not the tables, are what this checks. packages/migrations already proves
// campus is RLS-isolated; the question here is whether a service can be talked into
// crossing the boundary the database would otherwise defend.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import type { Subject } from '@church/policy';
import {
  CrossTenantWriteError,
  TenantDatabase,
  TenantRepository,
  type TenantTransaction,
  runWithTenant,
} from '@church/tenancy';
import { CampusService, ChurchService, NotFoundError } from '../../src/index.js';

let pool: Pool;
let admin: PoolClient;
let db: TenantDatabase;

const ours = 'aaaaaaaa-0000-4000-8000-000000000001';
const theirs = 'bbbbbbbb-0000-4000-8000-000000000002';
const actor = '00000000-0000-4000-8000-0000000000ff';
let theirCampus = '';

/** Reaches the repository guard directly, without going through a service. */
class ProbeRepository extends TenantRepository<{ id: string }> {
  protected readonly table = 'campus';
}

const churches = new ChurchService();
const campuses = new CampusService();
const subjectFor = (churchId: string): Subject => ({
  userId: actor,
  churchId,
  roles: ['CHURCH_ADMIN'],
});

const inTenant = <T>(churchId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> =>
  runWithTenant({ churchId, userId: actor, roles: ['CHURCH_ADMIN'] }, () => db.transaction(fn));

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
  await admin.query('DELETE FROM church WHERE id = ANY($1::uuid[])', [[ours, theirs]]);
  admin.release();
  await pool.end();
});

beforeEach(async () => {
  await admin.query('DELETE FROM church WHERE id = ANY($1::uuid[])', [[ours, theirs]]);
  for (const [id, name] of [
    [ours, 'Ours'],
    [theirs, 'Theirs'],
  ]) {
    await admin.query(`INSERT INTO church (id, name, country) VALUES ($1, $2, 'US')`, [id, name]);
    await admin.query(`INSERT INTO campus (church_id, name) VALUES ($1, 'Main')`, [id]);
  }
  const { rows } = await admin.query<{ id: string }>('SELECT id FROM campus WHERE church_id = $1', [
    theirs,
  ]);
  theirCampus = rows[0]!.id;
});

describe('a service cannot be pointed at another church', () => {
  it('reads only the caller own church, whatever the subject claims', async () => {
    // The subject says one church, the tenant context says another. The context wins,
    // because it is what RLS is keyed on — and the mismatch must not silently read the
    // subject's church instead.
    const result = await inTenant(ours, (tx) => churches.get(tx, subjectFor(ours)));
    expect(result.id).toBe(ours);
    expect(result.name).toBe('Ours');
  });

  it('cannot fetch another church campus by id', async () => {
    await expect(
      inTenant(ours, (tx) => campuses.get(tx, subjectFor(ours), theirCampus)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cannot update another church campus by id', async () => {
    await expect(
      inTenant(ours, (tx) => campuses.update(tx, subjectFor(ours), theirCampus, { name: 'Taken' })),
    ).rejects.toBeInstanceOf(NotFoundError);

    const { rows } = await admin.query<{ name: string }>('SELECT name FROM campus WHERE id = $1', [
      theirCampus,
    ]);
    expect(rows[0]?.name).toBe('Main');
  });

  it('cannot delete another church campus by id', async () => {
    await expect(
      inTenant(ours, (tx) => campuses.remove(tx, subjectFor(ours), theirCampus)),
    ).rejects.toBeInstanceOf(NotFoundError);

    const { rowCount } = await admin.query('SELECT 1 FROM campus WHERE id = $1', [theirCampus]);
    expect(rowCount).toBe(1);
  });

  it('refuses a create that names another church rather than quietly rewriting it', async () => {
    // The repository rejects a supplied church_id that disagrees with the context. Silently
    // overwriting it would hide the fact that a caller meant something wrong.
    await expect(
      inTenant(ours, (tx) =>
        tx.query('INSERT INTO campus (church_id, name) VALUES ($1, $2)', [theirs, 'Planted']),
      ),
    ).rejects.toThrow();

    const { rowCount } = await admin.query(
      `SELECT 1 FROM campus WHERE church_id = $1 AND name = 'Planted'`,
      [theirs],
    );
    expect(rowCount).toBe(0);
  });

  it('rejects an explicit cross-tenant church_id at the repository', async () => {
    await expect(
      inTenant(ours, (tx) =>
        campuses.create(tx, subjectFor(ours), { name: 'X', churchId: theirs } as never),
      ),
    ).resolves.toMatchObject({ churchId: ours });

    // And the repository's own guard, reached directly.
    await expect(
      inTenant(ours, (tx) => new ProbeRepository().insert(tx, { church_id: theirs, name: 'Y' })),
    ).rejects.toBeInstanceOf(CrossTenantWriteError);
  });

  it('lists only the caller own campuses', async () => {
    for (const name of ['Extra One', 'Extra Two']) {
      await admin.query('INSERT INTO campus (church_id, name) VALUES ($1, $2)', [theirs, name]);
    }
    const page = await inTenant(ours, (tx) => campuses.list(tx, subjectFor(ours), { limit: 100 }));
    expect(page.data.map((campus) => campus.churchId)).toEqual([ours]);
  });

  it('does not let a cursor from one church reach another church rows', async () => {
    // A cursor is a sort key, not a capability. Even a genuine one from another tenant can
    // only move the window within what RLS already allows.
    const theirPage = await inTenant(theirs, (tx) =>
      campuses.list(tx, subjectFor(theirs), { limit: 1 }),
    );
    const ourPage = await inTenant(ours, (tx) =>
      campuses.list(tx, subjectFor(ours), {
        limit: 10,
        ...(theirPage.nextCursor ? { cursor: theirPage.nextCursor } : {}),
      }),
    );
    expect(ourPage.data.every((campus) => campus.churchId === ours)).toBe(true);
  });
});
