// One church must never read another's audit log. It is the record of who did what to
// whom — arguably the most sensitive table in the schema, and certainly the one an
// attacker would most want to read or edit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  APP_ROLE,
  asTenant,
  assertTenantIsolation,
  ensureAppRole,
  withRollback,
} from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';

let pool: Pool;

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, max: 2 });
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

describe('audit_entry isolation', () => {
  it('passes the standard tenant-isolation battery', async () => {
    await withRollback(async (client: PoolClient) => {
      await assertTenantIsolation(client, {
        table: 'audit_entry',
        insert: async (c, churchId) => {
          await c.query(`INSERT INTO church (id, name, country) VALUES ($1, 'audit-iso', 'US')`, [
            churchId,
          ]);
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO audit_entry (church_id, action, resource_type)
             VALUES ($1, 'thing.happened', 'thing') RETURNING id`,
            [churchId],
          );
          if (!rows[0]) throw new Error('insert returned no row');
          return rows[0].id;
        },
      });
    });
  });

  it('hides another church history entirely', async () => {
    await withRollback(async (client: PoolClient) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('audit-a', 'US'), ('audit-b', 'US') RETURNING id`,
      );
      const [a, b] = [rows[0]!.id, rows[1]!.id];
      await client.query(
        `INSERT INTO audit_entry (church_id, action, resource_type, reason)
         VALUES ($1, 'medical_note.read', 'medical_note', 'their private business')`,
        [b],
      );

      await asTenant(client, a, async () => {
        const seen = await client.query('SELECT reason FROM audit_entry');
        expect(seen.rowCount).toBe(0);
      });
    });
  });

  it('gives the application role no way to erase a line, in any tenant', async () => {
    // The battery proves cross-tenant writes fail. This proves same-tenant deletion fails
    // too, which is the difference between a log and a draft.
    await withRollback(async (client: PoolClient) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('audit-c', 'US') RETURNING id`,
      );
      const churchId = rows[0]!.id;
      await client.query(
        `INSERT INTO audit_entry (church_id, action, resource_type) VALUES ($1, 'a.b', 'thing')`,
        [churchId],
      );

      await asTenant(client, churchId, async () => {
        await client.query('SAVEPOINT probe');
        await expect(client.query('DELETE FROM audit_entry')).rejects.toMatchObject({
          code: '42501',
        });
        await client.query('ROLLBACK TO SAVEPOINT probe');
        await expect(client.query(`UPDATE audit_entry SET reason = 'x'`)).rejects.toMatchObject({
          code: '42501',
        });
        await client.query('ROLLBACK TO SAVEPOINT probe');
      });
    });
  });
});
