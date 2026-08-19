// People, families, history and milestones against a real database.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { ForbiddenError, type Subject } from '@church/policy';
import { TenantDatabase, type TenantTransaction, runWithTenant } from '@church/tenancy';
import {
  AlreadyInFamilyError,
  FamilyNotFoundError,
  FamilyService,
  PersonNotFoundError,
  PersonService,
} from '../../src/index.js';

let pool: Pool;
let admin: PoolClient;
let db: TenantDatabase;

const church = '33333333-4444-4555-8666-777777777777';
const actor = '00000000-0000-4000-8000-0000000000a1';
const people = new PersonService();
const families = new FamilyService();

const staff: Subject = { userId: actor, churchId: church, roles: ['STAFF'] };
const member: Subject = { userId: actor, churchId: church, roles: ['MEMBER'] };

const asTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> =>
  runWithTenant({ churchId: church, userId: actor, roles: ['STAFF'] }, () => db.transaction(fn));

const newPerson = (first: string, last: string, extra: Record<string, unknown> = {}) =>
  asTenant((tx) => people.create(tx, staff, { firstName: first, lastName: last, ...extra }));

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
  await admin.query(`INSERT INTO church (id, name, country) VALUES ($1, 'People Test', 'GB')`, [
    church,
  ]);
  await admin.query(`INSERT INTO app_user (church_id, id, email) VALUES ($1, $2, $3)`, [
    church,
    actor,
    `actor-${Math.random().toString(36).slice(2)}@example.org`,
  ]);
});

describe('creating a person', () => {
  it('stores the details and returns the contract shape', async () => {
    const person = await newPerson('Jo', 'Smith', {
      dateOfBirth: '2015-06-15',
      email: 'household@example.org',
      address: { line1: '1 High Street', city: 'Leeds', country: 'GB' },
    });
    expect(person).toMatchObject({
      firstName: 'Jo',
      lastName: 'Smith',
      status: 'visitor',
      dateOfBirth: '2015-06-15',
    });
    expect(person.address).toMatchObject({ city: 'Leeds' });
    expect(person.archivedAt).toBeNull();
  });

  it('defaults to visitor', async () => {
    expect((await newPerson('New', 'Face')).status).toBe('visitor');
  });

  it('opens the membership history with how they arrived', async () => {
    // A history that starts at the first *change* cannot say how someone arrived, which is
    // half of what a church wants it for.
    const person = await newPerson('Arrived', 'Somehow', { status: 'attendee' });
    const history = await asTenant((tx) => people.history(tx, staff, person.id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'attendee', note: 'record created' });
    expect(history[0]?.changedBy).toBe(actor);
  });

  it('lets a whole family share one email address', async () => {
    // A child's contact address is usually a parent's. Uniqueness here would reject the
    // most ordinary household in the congregation.
    const shared = 'family@example.org';
    await newPerson('Parent', 'Shared', { email: shared });
    await expect(newPerson('Child', 'Shared', { email: shared })).resolves.toMatchObject({
      email: shared,
    });
  });

  it('refuses a caller without person:manage', async () => {
    await expect(
      asTenant((tx) => people.create(tx, member, { firstName: 'No', lastName: 'Chance' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('updating a person', () => {
  it('applies changes and records what moved', async () => {
    const person = await newPerson('Before', 'Change');
    const updated = await asTenant((tx) =>
      people.update(tx, staff, person.id, { firstName: 'After' }),
    );
    expect(updated.firstName).toBe('After');

    const { rows } = await admin.query<{ action: string; changed_fields: string[] }>(
      `SELECT action, changed_fields FROM audit_entry WHERE church_id = $1 ORDER BY seq DESC`,
      [church],
    );
    expect(rows[0]?.action).toBe('person.updated');
    expect(rows[0]?.changed_fields).toEqual(['firstName', 'updatedAt']);
  });

  it('cannot change status, because PersonUpdate has no such field', async () => {
    // Status moves only through changeStatus, which appends to the history in the same
    // transaction. A status field here would let a caller rewrite someone's standing with
    // no record of who did it.
    const person = await newPerson('Still', 'Visitor');
    await asTenant((tx) =>
      people.update(tx, staff, person.id, { firstName: 'Renamed', status: 'member' } as never),
    );
    const after = await asTenant((tx) => people.get(tx, staff, person.id));
    expect(after.status).toBe('visitor');
    expect(after.firstName).toBe('Renamed');
  });

  it('does nothing for an empty patch', async () => {
    const person = await newPerson('No', 'Change');
    const same = await asTenant((tx) => people.update(tx, staff, person.id, {}));
    expect(same.updatedAt).toBe(person.updatedAt);
  });
});

describe('membership history', () => {
  it('records each change and keeps the person row in step', async () => {
    const person = await newPerson('Growing', 'Member');
    await asTenant((tx) => people.changeStatus(tx, staff, person.id, 'attendee'));
    await asTenant((tx) => people.changeStatus(tx, staff, person.id, 'member', 'joined at Easter'));

    const history = await asTenant((tx) => people.history(tx, staff, person.id));
    expect(history.map((entry) => entry.status)).toEqual(['member', 'attendee', 'visitor']);
    expect(history[0]?.note).toBe('joined at Easter');

    // Two sources of truth that can disagree, will — so they are written together.
    const current = await asTenant((tx) => people.get(tx, staff, person.id));
    expect(current.status).toBe('member');
  });

  it('keeps every entry, including a reversal', async () => {
    // "Attended for two years, then joined" and "transferred in last month" are different
    // pastoral facts, and overwriting a status erases the difference.
    const person = await newPerson('Came', 'AndWent');
    await asTenant((tx) => people.changeStatus(tx, staff, person.id, 'member'));
    await asTenant((tx) => people.changeStatus(tx, staff, person.id, 'inactive'));
    await asTenant((tx) => people.changeStatus(tx, staff, person.id, 'member'));
    expect(await asTenant((tx) => people.history(tx, staff, person.id))).toHaveLength(4);
  });
});

describe('archiving', () => {
  it('hides from the directory but keeps the record fetchable', async () => {
    // Giving and attendance reference people. A hard delete would change last year's
    // giving report because someone tidied the directory this year.
    const person = await newPerson('Moved', 'Away');
    await asTenant((tx) => people.archive(tx, staff, person.id));

    const listed = await asTenant((tx) => people.list(tx, staff, { limit: 100 }));
    expect(listed.data.map((p) => p.id)).not.toContain(person.id);

    const fetched = await asTenant((tx) => people.get(tx, staff, person.id));
    expect(fetched.archivedAt).not.toBeNull();

    const withArchived = await asTenant((tx) =>
      people.list(tx, staff, { limit: 100, includeArchived: true }),
    );
    expect(withArchived.data.map((p) => p.id)).toContain(person.id);
  });

  it('is idempotent', async () => {
    const person = await newPerson('Twice', 'Archived');
    await asTenant((tx) => people.archive(tx, staff, person.id));
    await expect(asTenant((tx) => people.archive(tx, staff, person.id))).resolves.toBeUndefined();
  });

  it('404s a person who never existed', async () => {
    await expect(
      asTenant((tx) => people.get(tx, staff, '00000000-0000-4000-8000-000000000000')),
    ).rejects.toBeInstanceOf(PersonNotFoundError);
  });
});

describe('listing', () => {
  beforeEach(async () => {
    for (const [first, last] of [
      ['Ann', 'Alpha'],
      ['Bob', 'Bravo'],
      ['Cat', 'Charlie'],
      ['Dan', 'Delta'],
    ]) {
      await newPerson(first!, last!);
    }
  });

  it('walks everyone exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await asTenant((tx) =>
        people.list(tx, staff, { limit: 2, ...(cursor ? { cursor } : {}) }),
      );
      seen.push(...page.data.map((p) => p.lastName));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('filters by status', async () => {
    const [first] = (await asTenant((tx) => people.list(tx, staff, { limit: 1 }))).data;
    await asTenant((tx) => people.changeStatus(tx, staff, first!.id, 'member'));
    const members = await asTenant((tx) => people.list(tx, staff, { status: 'member' }));
    expect(members.data.map((p) => p.id)).toEqual([first!.id]);
  });

  it('sorts case-insensitively, so lowercase surnames are not exiled', async () => {
    // Ordering by last_name alone puts every lowercase surname after every uppercase one,
    // and "de Souza" ends up on the last page of the directory.
    await newPerson('Ella', 'de Souza');
    const page = await asTenant((tx) => people.list(tx, staff, { limit: 100 }));
    const names = page.data.map((p) => p.lastName);
    expect(names.indexOf('de Souza')).toBeLessThan(names.indexOf('Delta'));
  });
});

describe('families', () => {
  it('creates a household with members in one call', async () => {
    const parent = await newPerson('Pat', 'Household');
    const child = await newPerson('Kid', 'Household');
    const family = await asTenant((tx) =>
      families.create(tx, staff, {
        name: 'The Households',
        members: [
          { personId: parent.id, relationship: 'parent' },
          { personId: child.id, relationship: 'child' },
        ],
      }),
    );
    expect(family.members).toHaveLength(2);
    expect(family.members?.map((m) => m.relationship).sort()).toEqual(['child', 'parent']);
  });

  it('embeds the person so a household renders in one call', async () => {
    const parent = await newPerson('Embedded', 'Person', { dateOfBirth: '1980-03-02' });
    const family = await asTenant((tx) =>
      families.create(tx, staff, {
        name: 'Embedding',
        members: [{ personId: parent.id, relationship: 'parent' }],
      }),
    );
    const fetched = await asTenant((tx) => families.get(tx, staff, family.id));
    expect(fetched.members?.[0]?.person).toMatchObject({
      firstName: 'Embedded',
      // The same mapping as the direct path, so a birthday cannot mean two things.
      dateOfBirth: '1980-03-02',
    });
  });

  it('lets one person belong to two households', async () => {
    // Remarriage, and adult children. Forcing a single family per person would make the
    // platform take a side in a real pastoral situation.
    const child = await newPerson('Shared', 'Child');
    const mother = await asTenant((tx) =>
      families.create(tx, staff, {
        name: "Mother's",
        members: [{ personId: child.id, relationship: 'child' }],
      }),
    );
    const father = await asTenant((tx) =>
      families.create(tx, staff, {
        name: "Father's",
        members: [{ personId: child.id, relationship: 'child' }],
      }),
    );

    const belongs = await asTenant((tx) => families.familiesOf(tx, staff, child.id));
    expect(belongs.map((f) => f.id).sort()).toEqual([mother.id, father.id].sort());
  });

  it('refuses to add the same person twice', async () => {
    const person = await newPerson('Only', 'Once');
    const family = await asTenant((tx) => families.create(tx, staff, { name: 'Once' }));
    await asTenant((tx) =>
      families.addMember(tx, staff, family.id, { personId: person.id, relationship: 'other' }),
    );
    await expect(
      asTenant((tx) =>
        families.addMember(tx, staff, family.id, { personId: person.id, relationship: 'other' }),
      ),
    ).rejects.toBeInstanceOf(AlreadyInFamilyError);
  });

  it('removes a member without touching the person', async () => {
    const person = await newPerson('Still', 'Here');
    const family = await asTenant((tx) =>
      families.create(tx, staff, {
        name: 'Leavers',
        members: [{ personId: person.id, relationship: 'other' }],
      }),
    );
    await asTenant((tx) => families.removeMember(tx, staff, family.id, person.id));

    expect((await asTenant((tx) => families.get(tx, staff, family.id))).members).toHaveLength(0);
    await expect(asTenant((tx) => people.get(tx, staff, person.id))).resolves.toMatchObject({
      firstName: 'Still',
    });
  });

  it('omits members from a list, so a directory does not embed the whole church', async () => {
    const person = await newPerson('In', 'List');
    await asTenant((tx) =>
      families.create(tx, staff, {
        name: 'Listed',
        members: [{ personId: person.id, relationship: 'other' }],
      }),
    );
    const page = await asTenant((tx) => families.list(tx, staff, { limit: 10 }));
    expect(page.data[0]?.members).toBeUndefined();
  });

  it('404s a family that does not exist', async () => {
    await expect(
      asTenant((tx) => families.get(tx, staff, '00000000-0000-4000-8000-000000000000')),
    ).rejects.toBeInstanceOf(FamilyNotFoundError);
  });
});

describe('milestones', () => {
  it('records one and reads it back on the right date', async () => {
    const person = await newPerson('Baptised', 'Person');
    const milestone = await asTenant((tx) =>
      people.recordMilestone(tx, staff, person.id, {
        type: 'baptism',
        occurredOn: '1974-04-14',
        officiant: 'Revd Smith',
      }),
    );
    expect(milestone).toMatchObject({ type: 'baptism', occurredOn: '1974-04-14' });

    const listed = await asTenant((tx) => people.milestones(tx, staff, person.id));
    // A historical date must survive the round trip exactly — a baptism in 1974 has a date
    // and no defensible time of day.
    expect(listed[0]?.occurredOn).toBe('1974-04-14');
  });

  it('keeps several in date order, most recent first', async () => {
    const person = await newPerson('Many', 'Milestones');
    for (const [type, on] of [
      ['baptism', '2000-01-01'],
      ['confirmation', '2010-01-01'],
      ['marriage', '2020-01-01'],
    ] as const) {
      await asTenant((tx) =>
        people.recordMilestone(tx, staff, person.id, { type, occurredOn: on }),
      );
    }
    const listed = await asTenant((tx) => people.milestones(tx, staff, person.id));
    expect(listed.map((m) => m.type)).toEqual(['marriage', 'confirmation', 'baptism']);
  });

  it('refuses a member', async () => {
    const person = await newPerson('Not', 'Yours');
    await expect(
      asTenant((tx) =>
        people.recordMilestone(tx, member, person.id, {
          type: 'baptism',
          occurredOn: '2020-01-01',
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
