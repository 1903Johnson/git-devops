import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import {
  APP_ROLE,
  asTenant,
  attempt,
  closeAdminPool,
  createTenantFixtureTable,
  ensureAppRole,
  firstRow,
  getAdminPool,
  getRlsFlags,
  newChurchId,
  withRollback,
} from '../src/index.js';

beforeAll(async () => {
  const client = await getAdminPool().connect();
  try {
    await ensureAppRole(client);
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await closeAdminPool();
});

const insertRow = async (client: PoolClient, table: string, churchId: string): Promise<string> => {
  const result = await client.query<{ id: string }>(
    `INSERT INTO ${table} (church_id, label) VALUES ($1, 'x') RETURNING id`,
    [churchId],
  );
  return firstRow(result, 'inserted row').id;
};

describe('harness plumbing', () => {
  it('rolls back everything the callback did', async () => {
    await withRollback(async (client) => {
      await createTenantFixtureTable(client, 'rollback_probe');
      const { rowCount } = await client.query(
        "SELECT 1 FROM pg_class WHERE relname = 'rollback_probe'",
      );
      expect(rowCount).toBe(1);
    });

    await withRollback(async (client) => {
      const { rowCount } = await client.query(
        "SELECT 1 FROM pg_class WHERE relname = 'rollback_probe'",
      );
      expect(rowCount).toBe(0);
    });
  });

  it('drops superuser privileges inside a tenant context', async () => {
    await withRollback(async (client) => {
      const before = await client.query<{ role: string }>('SELECT current_user AS role');
      expect(firstRow(before, 'current_user').role).toBe('postgres');

      await asTenant(client, newChurchId(), async () => {
        const inside = await client.query<{ role: string; su: boolean }>(
          'SELECT current_user AS role, current_setting($1)::boolean AS su',
          ['is_superuser'],
        );
        const insideRow = firstRow(inside, 'tenant role');
        expect(insideRow.role).toBe(APP_ROLE);
        // The whole point: without this, RLS would not apply and every isolation
        // assertion in the codebase would pass vacuously.
        expect(insideRow.su).toBe(false);
      });

      const after = await client.query<{ role: string }>('SELECT current_user AS role');
      expect(firstRow(after, 'restored role').role).toBe('postgres');
    });
  });

  it('keeps writes made inside a tenant context', async () => {
    await withRollback(async (client) => {
      await createTenantFixtureTable(client, 'write_probe');
      const church = newChurchId();
      await asTenant(client, church, async () => {
        await client.query(`INSERT INTO write_probe (church_id, label) VALUES ($1, 'kept')`, [
          church,
        ]);
      });
      const { rowCount } = await client.query('SELECT 1 FROM write_probe');
      expect(rowCount).toBe(1);
    });
  });

  it('survives a rejected statement without poisoning the transaction', async () => {
    await withRollback(async (client) => {
      const bad = await attempt(client, 'SELECT * FROM table_that_does_not_exist');
      expect(bad.ok).toBe(false);
      const good = await client.query('SELECT 1 AS ok');
      expect(firstRow(good, 'sanity select').ok).toBe(1);
    });
  });

  it('reports both RLS flags', async () => {
    await withRollback(async (client) => {
      await createTenantFixtureTable(client, 'flag_probe');
      expect(await getRlsFlags(client, 'flag_probe')).toEqual({ enabled: true, forced: true });
    });
  });
});

describe('fixture table', () => {
  it('scopes reads and writes to the acting tenant', async () => {
    await withRollback(async (client) => {
      await createTenantFixtureTable(client, 'scope_probe');
      const a = newChurchId();
      const b = newChurchId();
      await insertRow(client, 'scope_probe', a);
      await insertRow(client, 'scope_probe', b);

      await asTenant(client, a, async () => {
        const scoped = await client.query<{ church_id: string }>(
          'SELECT church_id FROM scope_probe',
        );
        expect(scoped.rows).toHaveLength(1);
        expect(firstRow(scoped, 'scoped row').church_id).toBe(a);
      });
    });
  });
});
