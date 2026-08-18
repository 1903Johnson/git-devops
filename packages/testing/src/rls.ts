// The tenant-isolation assertion. docs/03 §6 makes this a mandatory CI category:
// for every tenant-scoped table and endpoint, a test proves Church A cannot reach
// Church B's rows — including by guessing an id.

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { APP_ROLE, asTenant, attempt, firstRow } from './db.js';

export interface TenantTableSpec {
  /** Table name, unqualified. */
  table: string;
  /**
   * Inserts one row for the given church and returns its id. Written by the caller
   * because only they know the table's required columns.
   */
  insert: (client: PoolClient, churchId: string) => Promise<string>;
}

/** Fresh church ids per assertion, so a leak between tests cannot be mistaken for a pass. */
export const newChurchId = (): string => randomUUID();

/**
 * Creates a tenant-scoped fixture table with the isolation policy this platform expects.
 * Used by the harness's own tests; real tables come from migrations, which must produce
 * the same shape — see the assertions in `assertTenantIsolation`.
 */
export async function createTenantFixtureTable(
  client: PoolClient,
  table: string,
  extraColumns = 'label text',
): Promise<void> {
  await client.query(`
    CREATE TABLE ${table} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      church_id uuid NOT NULL,
      ${extraColumns}
    );
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON ${table}
      USING (church_id = current_setting('app.current_church_id', true)::uuid)
      WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);
    GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${APP_ROLE};
  `);
}

/** Reads the two RLS flags PostgreSQL keeps per table. */
export async function getRlsFlags(
  client: PoolClient,
  table: string,
): Promise<{ enabled: boolean; forced: boolean }> {
  const result = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1',
    [table],
  );
  if (result.rows.length === 0) throw new Error(`table "${table}" does not exist`);
  const row = firstRow(result, `pg_class row for ${table}`);
  return { enabled: row.relrowsecurity, forced: row.relforcerowsecurity };
}

export interface IsolationFailure {
  check: string;
  detail: string;
}

/**
 * Proves a table isolates tenants. Returns the list of failures; empty means isolated.
 * Returning rather than throwing lets a caller assert on the whole set at once, so one
 * run reports every hole instead of only the first.
 *
 * Must be called inside `withRollback`, on a client with no tenant context set.
 */
export async function checkTenantIsolation(
  client: PoolClient,
  spec: TenantTableSpec,
): Promise<IsolationFailure[]> {
  const failures: IsolationFailure[] = [];
  const fail = (check: string, detail: string) => failures.push({ check, detail });

  const { table } = spec;
  const churchA = newChurchId();
  const churchB = newChurchId();

  // Structural checks first: a policy that is defined but not enabled protects nothing,
  // and one that is enabled but not FORCE'd is bypassed by the table's owner — which is
  // whatever role ran the migration, in production as much as in tests.
  const flags = await getRlsFlags(client, table);
  if (!flags.enabled) fail('rls_enabled', `${table} does not have row level security enabled`);
  if (!flags.forced)
    fail('rls_forced', `${table} does not FORCE row level security, so its owner bypasses it`);

  const idA = await spec.insert(client, churchA);
  const idB = await spec.insert(client, churchB);

  await asTenant(client, churchA, async () => {
    // 1. Reads are scoped to the tenant.
    const visible = await client.query<{ church_id: string }>(`SELECT church_id FROM ${table}`);
    const foreign = visible.rows.filter((r) => r.church_id !== churchA);
    if (foreign.length > 0)
      fail('select_scope', `SELECT returned ${foreign.length} row(s) belonging to another church`);

    // 2. Guessing the other tenant's id does not help.
    const guessed = await client.query(`SELECT id FROM ${table} WHERE id = $1`, [idB]);
    if ((guessed.rowCount ?? 0) > 0)
      fail('select_by_id', `Church B's row was readable by id from Church A's context`);

    // 3. Writes cannot reach across the boundary. A blocked UPDATE/DELETE reports zero
    //    rows rather than erroring — silence here is the bug, so count the rows.
    const updated = await attempt(
      client,
      `UPDATE ${table} SET church_id = church_id WHERE id = $1`,
      [idB],
    );
    if (updated.ok && updated.rowCount > 0)
      fail('update_across_tenant', `UPDATE modified ${updated.rowCount} of Church B's row(s)`);

    const deleted = await attempt(client, `DELETE FROM ${table} WHERE id = $1`, [idB]);
    if (deleted.ok && deleted.rowCount > 0)
      fail('delete_across_tenant', `DELETE removed ${deleted.rowCount} of Church B's row(s)`);

    // 4. WITH CHECK: a tenant cannot plant a row inside another tenant.
    //    Deliberately no RETURNING clause. With RETURNING, the SELECT policy rejects the
    //    statement before WITH CHECK is ever the deciding factor, so a table missing
    //    WITH CHECK entirely would look protected. What matters is whether a row lands,
    //    which is verified below from outside the tenant context.
    await attempt(client, `INSERT INTO ${table} (church_id) VALUES ($1)`, [churchB]);
  });

  // Count Church B's rows as admin: exactly the one seeded above, or Church A planted one.
  const plantedRows = await client.query(`SELECT id FROM ${table} WHERE church_id = $1`, [churchB]);
  if ((plantedRows.rowCount ?? 0) > 1)
    fail(
      'insert_across_tenant',
      `INSERT from Church A's context wrote a row owned by Church B (WITH CHECK missing?)`,
    );

  // 5. With no tenant context at all, the table must be empty rather than wide open —
  //    this catches a policy whose USING clause silently evaluates to true on NULL.
  await asTenant(client, '00000000-0000-0000-0000-000000000000', async () => {
    const { rowCount } = await client.query(`SELECT id FROM ${table} WHERE id IN ($1, $2)`, [
      idA,
      idB,
    ]);
    if ((rowCount ?? 0) > 0)
      fail('unknown_tenant', `${rowCount} row(s) visible to a church id that owns nothing`);
  });

  return failures;
}

/** Throws with every failure listed, or returns quietly. */
export async function assertTenantIsolation(
  client: PoolClient,
  spec: TenantTableSpec,
): Promise<void> {
  const failures = await checkTenantIsolation(client, spec);
  if (failures.length > 0) {
    throw new Error(
      `tenant isolation failed for "${spec.table}":\n` +
        failures.map((f) => `  [${f.check}] ${f.detail}`).join('\n'),
    );
  }
}
