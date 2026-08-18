// Self-test for the isolation assertion itself.
//
// A test helper that only ever passes is indistinguishable from one that does nothing,
// so this checks both directions: a correctly-policied table passes, and each specific
// way of getting the policy wrong is caught by the matching check.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import {
  APP_ROLE,
  assertTenantIsolation,
  checkTenantIsolation,
  closeAdminPool,
  createTenantFixtureTable,
  ensureAppRole,
  firstRow,
  getAdminPool,
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

const insert = async (client: PoolClient, table: string, churchId: string): Promise<string> => {
  const result = await client.query<{ id: string }>(
    `INSERT INTO ${table} (church_id, label) VALUES ($1, 'row') RETURNING id`,
    [churchId],
  );
  return firstRow(result, 'inserted row').id;
};

const spec = (table: string) => ({
  table,
  insert: (client: PoolClient, churchId: string) => insert(client, table, churchId),
});

describe('assertTenantIsolation', () => {
  it('passes a correctly isolated table', async () => {
    await withRollback(async (client) => {
      await createTenantFixtureTable(client, 'good_table');
      await expect(assertTenantIsolation(client, spec('good_table'))).resolves.toBeUndefined();
    });
  });

  it('catches a table with no policy at all', async () => {
    await withRollback(async (client) => {
      await client.query(`
        CREATE TABLE no_policy (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                                church_id uuid NOT NULL, label text);
        GRANT SELECT, INSERT, UPDATE, DELETE ON no_policy TO ${APP_ROLE};
      `);
      const failures = await checkTenantIsolation(client, spec('no_policy'));
      const checks = failures.map((f) => f.check);
      expect(checks).toContain('rls_enabled');
      expect(checks).toContain('select_scope');
      expect(checks).toContain('select_by_id');
      expect(checks).toContain('update_across_tenant');
      expect(checks).toContain('delete_across_tenant');
    });
  });

  it('catches RLS that is enabled but not FORCE, when the owner is the acting role', async () => {
    await withRollback(async (client) => {
      // The table is owned by APP_ROLE here, which is what a migration run as the
      // application user produces. Without FORCE, the owner sails straight past the
      // policy — the failure mode this check exists for.
      await client.query(`
        CREATE TABLE unforced (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                               church_id uuid NOT NULL, label text);
        ALTER TABLE unforced OWNER TO ${APP_ROLE};
        ALTER TABLE unforced ENABLE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON unforced
          USING (church_id = current_setting('app.current_church_id', true)::uuid)
          WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);
        GRANT SELECT, INSERT, UPDATE, DELETE ON unforced TO ${APP_ROLE};
      `);
      const failures = await checkTenantIsolation(client, spec('unforced'));
      const checks = failures.map((f) => f.check);
      expect(checks).toContain('rls_forced');
      // and the bypass is real, not theoretical
      expect(checks).toContain('select_scope');
    });
  });

  it('catches a read-only policy that forgets WITH CHECK', async () => {
    await withRollback(async (client) => {
      await client.query(`
        CREATE TABLE no_with_check (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                                    church_id uuid NOT NULL, label text);
        ALTER TABLE no_with_check ENABLE ROW LEVEL SECURITY;
        ALTER TABLE no_with_check FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_read ON no_with_check FOR SELECT
          USING (church_id = current_setting('app.current_church_id', true)::uuid);
        CREATE POLICY tenant_write ON no_with_check FOR INSERT WITH CHECK (true);
        GRANT SELECT, INSERT, UPDATE, DELETE ON no_with_check TO ${APP_ROLE};
      `);
      const failures = await checkTenantIsolation(client, spec('no_with_check'));
      expect(failures.map((f) => f.check)).toContain('insert_across_tenant');
    });
  });

  it('reports every hole in one run, not just the first', async () => {
    await withRollback(async (client) => {
      await client.query(`
        CREATE TABLE wide_open (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                                church_id uuid NOT NULL, label text);
        GRANT SELECT, INSERT, UPDATE, DELETE ON wide_open TO ${APP_ROLE};
      `);
      const failures = await checkTenantIsolation(client, spec('wide_open'));
      expect(failures.length).toBeGreaterThan(3);
      await expect(assertTenantIsolation(client, spec('wide_open'))).rejects.toThrow(
        /tenant isolation failed for "wide_open"/,
      );
    });
  });
});
