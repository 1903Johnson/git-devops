// People hold the most sensitive records this platform stores: children, their birthdays,
// their households. The migrations prove the tables isolate; this proves the services
// cannot be talked past them.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import type { Subject } from '@church/policy';
import { TenantDatabase, type TenantTransaction, runWithTenant } from '@church/tenancy';
import {
  FamilyNotFoundError,
  FamilyService,
  PersonNotFoundError,
  PersonService,
} from '../../src/index.js';

let pool: Pool;
let admin: PoolClient;
let db: TenantDatabase;

const ours = 'a1a1a1a1-0000-4000-8000-000000000001';
const theirs = 'b2b2b2b2-0000-4000-8000-000000000002';
const actor = '00000000-0000-4000-8000-0000000000b1';
let theirPerson = '';
let theirFamily = '';

const people = new PersonService();
const families = new FamilyService();
const subjectFor = (churchId: string): Subject => ({ userId: actor, churchId, roles: ['STAFF'] });

const inTenant = <T>(churchId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> =>
  runWithTenant({ churchId, userId: actor, roles: ['STAFF'] }, () => db.transaction(fn));

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
  for (const id of [ours, theirs]) {
    await admin.query(`INSERT INTO church (id, name, country) VALUES ($1, $2, 'GB')`, [id, id]);
    await admin.query(`INSERT INTO app_user (church_id, id, email) VALUES ($1, $2, $3)`, [
      id,
      id === ours ? actor : '00000000-0000-4000-8000-0000000000b2',
      `user-${id.slice(0, 8)}@example.org`,
    ]);
  }
  const person = await admin.query<{ id: string }>(
    `INSERT INTO person (church_id, first_name, last_name, date_of_birth)
     VALUES ($1, 'Their', 'Child', '2016-05-05') RETURNING id`,
    [theirs],
  );
  theirPerson = person.rows[0]!.id;
  const family = await admin.query<{ id: string }>(
    `INSERT INTO family (church_id, name) VALUES ($1, 'Their Household') RETURNING id`,
    [theirs],
  );
  theirFamily = family.rows[0]!.id;
  await admin.query(
    `INSERT INTO family_member (church_id, family_id, person_id, relationship)
     VALUES ($1, $2, $3, 'child')`,
    [theirs, theirFamily, theirPerson],
  );
});

describe('a person from another church is unreachable', () => {
  it('cannot be fetched by id', async () => {
    await expect(
      inTenant(ours, (tx) => people.get(tx, subjectFor(ours), theirPerson)),
    ).rejects.toBeInstanceOf(PersonNotFoundError);
  });

  it('cannot be updated by id', async () => {
    await expect(
      inTenant(ours, (tx) =>
        people.update(tx, subjectFor(ours), theirPerson, { firstName: 'Taken' }),
      ),
    ).rejects.toBeInstanceOf(PersonNotFoundError);

    const { rows } = await admin.query<{ first_name: string }>(
      'SELECT first_name FROM person WHERE id = $1',
      [theirPerson],
    );
    expect(rows[0]?.first_name).toBe('Their');
  });

  it('cannot be archived by id', async () => {
    await expect(
      inTenant(ours, (tx) => people.archive(tx, subjectFor(ours), theirPerson)),
    ).rejects.toBeInstanceOf(PersonNotFoundError);

    const { rows } = await admin.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM person WHERE id = $1',
      [theirPerson],
    );
    expect(rows[0]?.archived_at).toBeNull();
  });

  it('cannot have their standing changed', async () => {
    await expect(
      inTenant(ours, (tx) => people.changeStatus(tx, subjectFor(ours), theirPerson, 'member')),
    ).rejects.toBeInstanceOf(PersonNotFoundError);

    const { rowCount } = await admin.query(
      'SELECT 1 FROM membership_status_history WHERE person_id = $1',
      [theirPerson],
    );
    expect(rowCount).toBe(0);
  });

  it('cannot have a milestone recorded against them', async () => {
    // Writing a baptism into another church's records would be both a data leak and a
    // falsified sacramental record.
    await expect(
      inTenant(ours, (tx) =>
        people.recordMilestone(tx, subjectFor(ours), theirPerson, {
          type: 'baptism',
          occurredOn: '2020-01-01',
        }),
      ),
    ).rejects.toBeInstanceOf(PersonNotFoundError);

    const { rowCount } = await admin.query('SELECT 1 FROM milestone WHERE person_id = $1', [
      theirPerson,
    ]);
    expect(rowCount).toBe(0);
  });

  it('does not appear in a listing, with or without archived', async () => {
    const listed = await inTenant(ours, (tx) =>
      people.list(tx, subjectFor(ours), { limit: 100, includeArchived: true }),
    );
    expect(listed.data).toEqual([]);
  });

  it('leaks nothing through their membership history', async () => {
    await expect(
      inTenant(ours, (tx) => people.history(tx, subjectFor(ours), theirPerson)),
    ).rejects.toBeInstanceOf(PersonNotFoundError);
  });
});

describe('a household from another church is unreachable', () => {
  it('cannot be fetched, and its members do not leak', async () => {
    await expect(
      inTenant(ours, (tx) => families.get(tx, subjectFor(ours), theirFamily)),
    ).rejects.toBeInstanceOf(FamilyNotFoundError);
  });

  it('cannot be renamed', async () => {
    await expect(
      inTenant(ours, (tx) => families.rename(tx, subjectFor(ours), theirFamily, 'Ours Now')),
    ).rejects.toBeInstanceOf(FamilyNotFoundError);
  });

  it('cannot have a member added to it', async () => {
    const ourPerson = await inTenant(ours, (tx) =>
      people.create(tx, subjectFor(ours), { firstName: 'Our', lastName: 'Person' }),
    );
    await expect(
      inTenant(ours, (tx) =>
        families.addMember(tx, subjectFor(ours), theirFamily, {
          personId: ourPerson.id,
          relationship: 'other',
        }),
      ),
    ).rejects.toBeInstanceOf(FamilyNotFoundError);
  });

  it('cannot have a member removed from it', async () => {
    await expect(
      inTenant(ours, (tx) => families.removeMember(tx, subjectFor(ours), theirFamily, theirPerson)),
    ).rejects.toBeInstanceOf(FamilyNotFoundError);

    const { rowCount } = await admin.query('SELECT 1 FROM family_member WHERE family_id = $1', [
      theirFamily,
    ]);
    expect(rowCount).toBe(1);
  });

  it('does not surface through familiesOf, even given their person id', async () => {
    // The query joins on person_id rather than reading a family id, so it is worth checking
    // separately: a join can reach rows a direct lookup would not.
    expect(
      await inTenant(ours, (tx) => families.familiesOf(tx, subjectFor(ours), theirPerson)),
    ).toEqual([]);
  });

  it('cannot be reached with a cursor minted in that church', async () => {
    await inTenant(theirs, (tx) =>
      families.create(tx, subjectFor(theirs), { name: 'Another Of Theirs' }),
    );
    const theirPage = await inTenant(theirs, (tx) =>
      families.list(tx, subjectFor(theirs), { limit: 1 }),
    );
    const ourPage = await inTenant(ours, (tx) =>
      families.list(tx, subjectFor(ours), {
        limit: 50,
        ...(theirPage.nextCursor ? { cursor: theirPage.nextCursor } : {}),
      }),
    );
    expect(ourPage.data).toEqual([]);
  });
});

describe('writes stay inside the tenant', () => {
  it('creates a person in the caller church even if another is named', async () => {
    const person = await inTenant(ours, (tx) =>
      people.create(tx, subjectFor(ours), {
        firstName: 'Ours',
        lastName: 'Really',
        churchId: theirs,
      } as never),
    );
    expect(person.churchId).toBe(ours);
  });

  it('refuses to put another church person into our household', async () => {
    // The composite foreign key from CORE-017a, not RLS, is what stops this: FK checks run
    // as the table owner and ignore the tenant policy entirely.
    const family = await inTenant(ours, (tx) =>
      families.create(tx, subjectFor(ours), { name: 'Ours' }),
    );
    await expect(
      inTenant(ours, (tx) =>
        families.addMember(tx, subjectFor(ours), family.id, {
          personId: theirPerson,
          relationship: 'child',
        }),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
