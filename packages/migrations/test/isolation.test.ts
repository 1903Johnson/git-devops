// Isolation for the core schema, exercised through the real migration output rather than
// a fixture table. If 0001_platform_core.sql is wrong, this is what says so.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  APP_ROLE,
  asTenant,
  assertTenantIsolation,
  ensureAppRole,
  newChurchId,
  withRollback,
} from '@church/testing';
import { TenantDatabase, runWithTenant } from '@church/tenancy';
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
    // Idempotent: applies the core schema if this database has not seen it yet, so the
    // suite stands alone rather than depending on migrate:test having run first.
    await applyMigrations(client, collectMigrations([CORE_MIGRATIONS_DIR]), {
      appRole: APP_ROLE,
    });
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.end();
});

const db = () => new TenantDatabase(pool, { appRole: APP_ROLE });

/** Churches are created outside any tenant context — the tenant does not exist yet. */
async function seedChurch(client: PoolClient, name: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO church (name, country) VALUES ($1, 'US') RETURNING id`,
    [name],
  );
  if (!rows[0]) throw new Error('church insert returned no row');
  return rows[0].id;
}

describe('core schema isolation', () => {
  it('isolates campus', async () => {
    await withRollback(async (client) => {
      await assertTenantIsolation(client, {
        table: 'campus',
        insert: async (c, churchId) => {
          await c.query(`INSERT INTO church (id, name, country) VALUES ($1, 'Seed', 'US')`, [
            churchId,
          ]);
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO campus (church_id, name) VALUES ($1, 'Main') RETURNING id`,
            [churchId],
          );
          if (!rows[0]) throw new Error('campus insert returned no row');
          return rows[0].id;
        },
      });
    });
  });

  it('stops a church reading another church row', async () => {
    await withRollback(async (client) => {
      const a = await seedChurch(client, 'Church A');
      const b = await seedChurch(client, 'Church B');

      await asTenant(client, a, async () => {
        const mine = await client.query<{ id: string }>('SELECT id FROM church');
        expect(mine.rows.map((r) => r.id)).toEqual([a]);

        const theirs = await client.query('SELECT id FROM church WHERE id = $1', [b]);
        expect(theirs.rowCount).toBe(0);
      });
    });
  });

  it('stops a church renaming another church', async () => {
    await withRollback(async (client) => {
      const a = await seedChurch(client, 'Church A');
      const b = await seedChurch(client, 'Church B');

      await asTenant(client, a, async () => {
        const { rowCount } = await client.query('UPDATE church SET name = $1 WHERE id = $2', [
          'Hijacked',
          b,
        ]);
        expect(rowCount).toBe(0);
      });

      const { rows } = await client.query<{ name: string }>(
        'SELECT name FROM church WHERE id = $1',
        [b],
      );
      expect(rows[0]?.name).toBe('Church B');
    });
  });

  it('scopes campus reads through the tenancy layer end to end', async () => {
    // The full stack: runWithTenant -> TenantDatabase -> RLS on a migrated table.
    const churchA = newChurchId();
    const churchB = newChurchId();
    const admin = await pool.connect();
    try {
      for (const id of [churchA, churchB]) {
        await admin.query(`INSERT INTO church (id, name, country) VALUES ($1, $2, 'US')`, [
          id,
          `Church ${id.slice(0, 8)}`,
        ]);
      }

      for (const id of [churchA, churchB]) {
        await runWithTenant({ churchId: id }, () =>
          db().transaction(async (tx) => {
            await tx.query(`INSERT INTO campus (church_id, name) VALUES ($1, 'Main')`, [id]);
          }),
        );
      }

      const seen = await runWithTenant({ churchId: churchA }, () =>
        db().transaction(async (tx) => {
          const { rows } = await tx.query<{ church_id: string }>('SELECT church_id FROM campus');
          return rows;
        }),
      );
      expect(seen.length).toBe(1);
      expect(seen[0]?.church_id).toBe(churchA);
    } finally {
      await admin.query('DELETE FROM church WHERE id = ANY($1::uuid[])', [[churchA, churchB]]);
      admin.release();
    }
  });
});

describe('updated_at is maintained, not merely declared', () => {
  // Until 0010 every table declared `updated_at NOT NULL DEFAULT now()` and nothing ever
  // moved it: the repository writes exactly the columns it is handed, so the value recorded
  // when a row was *created* and stayed there. Person.updatedAt and Family.updatedAt are in
  // the contract, where a client would use them for caching — and cache stale data forever.
  it('advances on update, for any writer', async () => {
    await withRollback(async (client) => {
      const churchId = await seedChurch(client, 'updated-at');
      const { rows } = await client.query<{ id: string; updated_at: Date }>(
        `INSERT INTO campus (church_id, name) VALUES ($1, 'Before') RETURNING id, updated_at`,
        [churchId],
      );
      const before = rows[0]!;

      // A hand-written UPDATE, deliberately: the trigger exists so the rule holds for
      // writers that have never heard of the repository.
      const after = await client.query<{ updated_at: Date }>(
        `UPDATE campus SET name = 'After' WHERE id = $1 RETURNING updated_at`,
        [before.id],
      );
      expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    });
  });

  it('covers every table that declares the column', async () => {
    // Discovery, not a list, so a table added later cannot quietly miss out.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ table_name: string }>(
        `SELECT c.relname AS table_name
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN information_schema.columns col
             ON col.table_name = c.relname AND col.column_name = 'updated_at'
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND col.table_schema = 'public'
            AND NOT EXISTS (
              SELECT 1 FROM pg_trigger t
               WHERE t.tgrelid = c.oid AND t.tgname = c.relname || '_set_updated_at'
            )`,
      );
      expect(rows.map((row) => row.table_name)).toEqual([]);
    });
  });
});
