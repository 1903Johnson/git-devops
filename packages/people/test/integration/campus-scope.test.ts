// Campus scoping for a CAMPUS_ADMIN.
//
// Campus is a scoping filter, never an isolation boundary (docs/01 §2.3) — RLS does not
// enforce it and cannot, because both campuses live in one tenant. That makes it entirely
// the policy layer's job, which is exactly why it needs probing directly: nothing else
// will notice if it stops happening.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { ForbiddenError, type Subject } from '@church/policy';
import { TenantDatabase, type TenantTransaction, runWithTenant } from '@church/tenancy';
import { PersonService } from '../../src/index.js';

let pool: Pool;
let admin: PoolClient;
let db: TenantDatabase;

const church = '5c5c5c5c-0000-4000-8000-000000000001';
const north = '5c5c5c5c-0000-4000-8000-0000000000a1';
const south = '5c5c5c5c-0000-4000-8000-0000000000a2';
const actor = '5c5c5c5c-0000-4000-8000-0000000000b1';

const people = new PersonService();

/** Confined to North. Holds STAFF's permissions, but only over one campus. */
const northAdmin: Subject = {
  userId: actor,
  churchId: church,
  roles: ['CAMPUS_ADMIN'],
  campusId: north,
};
/** Church-wide, for contrast: the same calls must stay unrestricted. */
const churchAdmin: Subject = { userId: actor, churchId: church, roles: ['CHURCH_ADMIN'] };

const asTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> =>
  runWithTenant({ churchId: church, userId: actor, roles: ['CAMPUS_ADMIN'] }, () =>
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
  await admin.query(`INSERT INTO church (id, name, country) VALUES ($1, 'Two Campuses', 'GB')`, [
    church,
  ]);
  for (const [id, name] of [
    [north, 'North'],
    [south, 'South'],
  ]) {
    await admin.query(`INSERT INTO campus (church_id, id, name) VALUES ($1, $2, $3)`, [
      church,
      id,
      name,
    ]);
  }
  await admin.query(`INSERT INTO app_user (church_id, id, email) VALUES ($1, $2, $3)`, [
    church,
    actor,
    `campus-admin-${Math.random().toString(36).slice(2)}@example.org`,
  ]);
  await admin.query(
    `INSERT INTO person (church_id, campus_id, first_name, last_name)
     VALUES ($1, $2, 'Nora', 'Northerner'), ($1, $3, 'Sam', 'Southerner')`,
    [church, north, south],
  );
});

describe('a campus admin reading people', () => {
  it('sees only their own campus in a listing', async () => {
    // The whole point of the role. A listing that ignores it hands over every child
    // record in the church to an administrator trusted with one site.
    const page = await asTenant((tx) => people.list(tx, northAdmin, { limit: 100 }));
    expect(page.data.map((p) => p.lastName).sort()).toEqual(['Northerner']);
  });

  it('cannot widen the listing by naming another campus', async () => {
    await expect(
      asTenant((tx) => people.list(tx, northAdmin, { limit: 100, campusId: south })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('still lets a church-wide admin see everyone', async () => {
    const page = await asTenant((tx) => people.list(tx, churchAdmin, { limit: 100 }));
    expect(page.data.map((p) => p.lastName).sort()).toEqual(['Northerner', 'Southerner']);
  });
});

describe('a campus admin writing people', () => {
  it('cannot create a person onto another campus', async () => {
    await expect(
      asTenant((tx) =>
        people.create(tx, northAdmin, {
          firstName: 'Planted',
          lastName: 'Elsewhere',
          campusId: south,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('can create a person onto their own campus', async () => {
    const created = await asTenant((tx) =>
      people.create(tx, northAdmin, { firstName: 'Local', lastName: 'Hire', campusId: north }),
    );
    expect(created.campusId).toBe(north);
  });

  it('cannot move one of their people to another campus', async () => {
    const mine = await asTenant((tx) =>
      people.create(tx, northAdmin, { firstName: 'Stays', lastName: 'Put', campusId: north }),
    );
    await expect(
      asTenant((tx) => people.update(tx, northAdmin, mine.id, { campusId: south })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
