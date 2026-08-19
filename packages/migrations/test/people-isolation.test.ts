// Isolation and referential integrity for the people schema (0005_people.sql).
//
// The isolation battery below is the routine half. The interesting half is
// `tenant-carrying foreign keys`: RLS alone does not stop one church writing a row that
// points at another church's person, because Postgres runs FK checks as the referenced
// table's owner and those checks ignore row-level security. That gap is invisible in a
// normal isolation suite — every SELECT still returns the right rows — so it is tested
// directly here.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  APP_ROLE,
  asTenant,
  assertTenantIsolation,
  attempt,
  ensureAppRole,
  firstRow,
  withRollback,
} from '@church/testing';
import { applyMigrations, collectMigrations } from '../src/index.js';
import { CORE_MIGRATIONS_DIR } from '../src/locations.js';

let pool: Pool;

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, max: 4 });
  const client = await pool.connect();
  try {
    await ensureAppRole(client);
    await applyMigrations(client, collectMigrations([CORE_MIGRATIONS_DIR]), { appRole: APP_ROLE });
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.end();
});

/** Seeds a church and one person in it, returning both ids. */
async function seedPerson(
  client: PoolClient,
  churchId: string,
  churchName: string,
): Promise<string> {
  await client.query(
    `INSERT INTO church (id, name, country) VALUES ($1, $2, 'US') ON CONFLICT (id) DO NOTHING`,
    [churchId, churchName],
  );
  const result = await client.query<{ id: string }>(
    `INSERT INTO person (church_id, first_name, last_name) VALUES ($1, 'Test', 'Person')
     RETURNING id`,
    [churchId],
  );
  return firstRow(result, 'person insert').id;
}

describe('people schema isolation', () => {
  it('isolates person', async () => {
    await withRollback(async (client) => {
      await assertTenantIsolation(client, {
        table: 'person',
        insert: (c, churchId) => seedPerson(c, churchId, 'people-iso-person'),
      });
    });
  });

  it('isolates family', async () => {
    await withRollback(async (client) => {
      await assertTenantIsolation(client, {
        table: 'family',
        insert: async (c, churchId) => {
          await c.query(`INSERT INTO church (id, name, country) VALUES ($1, 'fam', 'US')`, [
            churchId,
          ]);
          const result = await c.query<{ id: string }>(
            `INSERT INTO family (church_id, name) VALUES ($1, 'Household') RETURNING id`,
            [churchId],
          );
          return firstRow(result, 'family insert').id;
        },
      });
    });
  });

  it('isolates family_member', async () => {
    await withRollback(async (client) => {
      await assertTenantIsolation(client, {
        table: 'family_member',
        insert: async (c, churchId) => {
          const personId = await seedPerson(c, churchId, 'people-iso-fm');
          const family = await c.query<{ id: string }>(
            `INSERT INTO family (church_id, name) VALUES ($1, 'Household') RETURNING id`,
            [churchId],
          );
          const result = await c.query<{ id: string }>(
            `INSERT INTO family_member (church_id, family_id, person_id, relationship)
             VALUES ($1, $2, $3, 'child') RETURNING id`,
            [churchId, firstRow(family, 'family insert').id, personId],
          );
          return firstRow(result, 'family_member insert').id;
        },
      });
    });
  });

  it('isolates membership_status_history', async () => {
    await withRollback(async (client) => {
      await assertTenantIsolation(client, {
        table: 'membership_status_history',
        insert: async (c, churchId) => {
          const personId = await seedPerson(c, churchId, 'people-iso-msh');
          const result = await c.query<{ id: string }>(
            `INSERT INTO membership_status_history (church_id, person_id, status)
             VALUES ($1, $2, 'member') RETURNING id`,
            [churchId, personId],
          );
          return firstRow(result, 'status history insert').id;
        },
      });
    });
  });

  it('isolates milestone', async () => {
    await withRollback(async (client) => {
      await assertTenantIsolation(client, {
        table: 'milestone',
        insert: async (c, churchId) => {
          const personId = await seedPerson(c, churchId, 'people-iso-milestone');
          const result = await c.query<{ id: string }>(
            `INSERT INTO milestone (church_id, person_id, type, occurred_on)
             VALUES ($1, $2, 'baptism', '2024-03-31') RETURNING id`,
            [churchId, personId],
          );
          return firstRow(result, 'milestone insert').id;
        },
      });
    });
  });
});

describe('tenant-carrying foreign keys', () => {
  /** Two churches, a person and a campus in the second, a family in the first. */
  async function twoChurches(client: PoolClient) {
    const churches = await client.query<{ id: string }>(
      `INSERT INTO church (name, country) VALUES ('fk-attacker', 'US'), ('fk-victim', 'US')
       RETURNING id`,
    );
    const attacker = churches.rows[0]!.id;
    const victim = churches.rows[1]!.id;
    const victimPerson = await client.query<{ id: string }>(
      `INSERT INTO person (church_id, first_name, last_name) VALUES ($1, 'Vic', 'Tim')
       RETURNING id`,
      [victim],
    );
    const victimCampus = await client.query<{ id: string }>(
      `INSERT INTO campus (church_id, name) VALUES ($1, 'Theirs') RETURNING id`,
      [victim],
    );
    const family = await client.query<{ id: string }>(
      `INSERT INTO family (church_id, name) VALUES ($1, 'Ours') RETURNING id`,
      [attacker],
    );
    return {
      attacker,
      victimPersonId: firstRow(victimPerson, 'victim person').id,
      victimCampusId: firstRow(victimCampus, 'victim campus').id,
      familyId: firstRow(family, 'family').id,
    };
  }

  it('refuses to attach another church person to a family, milestone, or status history', async () => {
    // Without composite keys all three of these inserts succeed: the FK check runs as the
    // table owner and never consults the tenant policy. Nothing leaks on read, but the
    // insert succeeding tells the caller that a UUID exists in some other church, and the
    // row it leaves behind is a reference the owning church can delete out from under.
    await withRollback(async (client) => {
      const { attacker, victimPersonId, victimCampusId, familyId } = await twoChurches(client);

      await asTenant(client, attacker, async () => {
        const asFamilyMember = await attempt(
          client,
          `INSERT INTO family_member (church_id, family_id, person_id, relationship)
                 VALUES ($1, $2, $3, 'child')`,
          [attacker, familyId, victimPersonId],
        );
        expect(asFamilyMember.code).toBe('23503');

        const asMilestone = await attempt(
          client,
          `INSERT INTO milestone (church_id, person_id, type, occurred_on)
                 VALUES ($1, $2, 'baptism', '2024-01-01')`,
          [attacker, victimPersonId],
        );
        expect(asMilestone.code).toBe('23503');

        const asStatus = await attempt(
          client,
          `INSERT INTO membership_status_history (church_id, person_id, status)
                 VALUES ($1, $2, 'member')`,
          [attacker, victimPersonId],
        );
        expect(asStatus.code).toBe('23503');

        const asCampus = await attempt(
          client,
          `INSERT INTO person (church_id, campus_id, first_name, last_name)
                 VALUES ($1, $2, 'New', 'Person')`,
          [attacker, victimCampusId],
        );
        expect(asCampus.code).toBe('23503');
      });
    });
  });

  it('still allows the ordinary same-church case', async () => {
    // A constraint that rejects everything is not isolation, it is an outage.
    await withRollback(async (client) => {
      const { attacker, familyId } = await twoChurches(client);
      const own = await client.query<{ id: string }>(
        `INSERT INTO person (church_id, first_name, last_name) VALUES ($1, 'Own', 'Member')
         RETURNING id`,
        [attacker],
      );
      const ownId = firstRow(own, 'own person').id;

      await asTenant(client, attacker, async () => {
        const inserted = await client.query(
          `INSERT INTO family_member (church_id, family_id, person_id, relationship)
           VALUES ($1, $2, $3, 'child')`,
          [attacker, familyId, ownId],
        );
        expect(inserted.rowCount).toBe(1);
      });
    });
  });

  it('nulls campus_id when a campus closes, without disturbing church_id', async () => {
    // The composite key spans (church_id, campus_id), and church_id is NOT NULL. A plain
    // ON DELETE SET NULL would try to null both and fail at delete time; the column-list
    // form is what makes closing a campus survivable.
    await withRollback(async (client) => {
      const churchResult = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('fk-campus-close', 'US') RETURNING id`,
      );
      const churchId = firstRow(churchResult, 'church').id;
      const campus = await client.query<{ id: string }>(
        `INSERT INTO campus (church_id, name) VALUES ($1, 'North') RETURNING id`,
        [churchId],
      );
      const person = await client.query<{ id: string }>(
        `INSERT INTO person (church_id, campus_id, first_name, last_name)
         VALUES ($1, $2, 'Reg', 'Attender') RETURNING id`,
        [churchId, firstRow(campus, 'campus').id],
      );
      const personId = firstRow(person, 'person').id;

      await client.query('DELETE FROM campus WHERE id = $1', [firstRow(campus, 'campus').id]);

      const after = await client.query<{ campus_id: string | null; church_id: string }>(
        'SELECT campus_id, church_id FROM person WHERE id = $1',
        [personId],
      );
      expect(firstRow(after, 'person after campus delete').campus_id).toBeNull();
      expect(firstRow(after, 'person after campus delete').church_id).toBe(churchId);
    });
  });
});

describe('people schema shape', () => {
  it('lets a family share one email address', async () => {
    // Not an oversight: a child's contact address is usually a parent's, and a unique index
    // on person.email would reject the most ordinary household in the congregation.
    await withRollback(async (client) => {
      const churchResult = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('people-shared-email', 'US') RETURNING id`,
      );
      const churchId = firstRow(churchResult, 'church').id;
      const shared = 'household@example.org';
      for (const name of ['Parent', 'Child']) {
        await client.query(
          `INSERT INTO person (church_id, first_name, last_name, email) VALUES ($1, $2, 'Smith', $3)`,
          [churchId, name, shared],
        );
      }
      const { rowCount } = await client.query('SELECT 1 FROM person WHERE email = $1', [shared]);
      expect(rowCount).toBe(2);
    });
  });

  it('lets one person belong to two families', async () => {
    // Remarriage and adult children. Modelling family as a column on person would force the
    // church to pick one household, which is a pastoral problem rather than a schema nicety.
    await withRollback(async (client) => {
      const churchResult = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('people-two-families', 'US') RETURNING id`,
      );
      const churchId = firstRow(churchResult, 'church').id;
      const personId = await seedPerson(client, churchId, 'people-two-families');
      const families = await client.query<{ id: string }>(
        `INSERT INTO family (church_id, name) VALUES ($1, 'Mother''s'), ($1, 'Father''s')
         RETURNING id`,
        [churchId],
      );
      for (const family of families.rows) {
        await client.query(
          `INSERT INTO family_member (church_id, family_id, person_id, relationship)
           VALUES ($1, $2, $3, 'child')`,
          [churchId, family.id, personId],
        );
      }
      const { rowCount } = await client.query('SELECT 1 FROM family_member WHERE person_id = $1', [
        personId,
      ]);
      expect(rowCount).toBe(2);
    });
  });

  it('rejects a status outside the documented set', async () => {
    await withRollback(async (client) => {
      const churchResult = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('people-bad-status', 'US') RETURNING id`,
      );
      const churchId = firstRow(churchResult, 'church').id;
      const { code } = await attempt(
        client,
        `INSERT INTO person (church_id, first_name, last_name, status)
               VALUES ($1, 'Bad', 'Status', 'deceased')`,
        [churchId],
      );
      expect(code).toBe('23514');
    });
  });
});
