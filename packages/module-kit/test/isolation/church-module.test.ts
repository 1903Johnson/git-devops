// church_module says which features a church has bought and turned on. That is commercially
// sensitive and, for a safeguarding module, operationally sensitive: knowing a church has
// children's check-in enabled is knowing children are on the premises on Sundays.

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
import { ModuleStateReader, loadModules, syncModuleDefinitions } from '../../src/index.js';

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;
let pool: Pool;

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  try {
    await ensureAppRole(client);
    await applyMigrations(client, collectMigrations([CORE_MIGRATIONS_DIR]), { appRole: APP_ROLE });
    await syncModuleDefinitions(
      client,
      (await loadModules(FIXTURES)).map((m) => m.manifest),
    );
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.end();
});

describe('church_module isolation', () => {
  it('passes the standard tenant-isolation battery', async () => {
    await withRollback(async (client: PoolClient) => {
      await assertTenantIsolation(client, {
        table: 'church_module',
        insert: async (c, churchId) => {
          await c.query(`INSERT INTO church (id, name, country) VALUES ($1, 'cm-iso', 'US')`, [
            churchId,
          ]);
          await c.query(
            `INSERT INTO church_module (church_id, module_key, status) VALUES ($1, 'good_module', 'disabled')`,
            [churchId],
          );
          // Composite key, so the battery's id-based probes need the pair. Returning the
          // module key is enough: it is unique within the tenant.
          return 'good_module';
        },
        idColumn: 'module_key',
      });
    });
  });

  it('hides which modules another church has enabled', async () => {
    await withRollback(async (client: PoolClient) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('cm-a', 'US'), ('cm-b', 'US') RETURNING id`,
      );
      const [a, b] = [rows[0]!.id, rows[1]!.id];
      await client.query(
        `INSERT INTO church_module (church_id, module_key, status, enabled_at)
         VALUES ($1, 'good_module', 'enabled', now())`,
        [b],
      );

      await asTenant(client, a, async () => {
        const seen = await client.query('SELECT module_key FROM church_module');
        expect(seen.rowCount).toBe(0);
        // And the reader agrees — the API's own path, not just raw SQL.
        expect(await new ModuleStateReader(client).isEnabled('good_module')).toBe(false);
        expect(await new ModuleStateReader(client).enabledKeys()).toEqual([]);
      });
    });
  });

  it('cannot enable a module for another church', async () => {
    await withRollback(async (client: PoolClient) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('cm-c', 'US'), ('cm-d', 'US') RETURNING id`,
      );
      const [a, b] = [rows[0]!.id, rows[1]!.id];

      await asTenant(client, a, async () => {
        await client.query('SAVEPOINT probe');
        await expect(
          client.query(
            `INSERT INTO church_module (church_id, module_key, status, enabled_at)
             VALUES ($1, 'good_module', 'enabled', now())`,
            [b],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK TO SAVEPOINT probe');
      });
    });
  });

  it('leaves the catalogue readable by everyone', async () => {
    // module_definition is deliberately not tenant-scoped: it is the same for every church
    // and holds no customer data. If RLS crept onto it, every module would vanish for
    // everybody — a failure that looks like the registry being empty.
    await withRollback(async (client: PoolClient) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('cm-e', 'US') RETURNING id`,
      );
      await asTenant(client, rows[0]!.id, async () => {
        const catalogue = await client.query('SELECT key FROM module_definition');
        expect(catalogue.rowCount).toBeGreaterThan(0);
      });
    });
  });
});
