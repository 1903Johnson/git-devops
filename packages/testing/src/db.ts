// Connection plumbing for tests that need a real PostgreSQL.
//
// Real, not mocked, deliberately: the behaviour these tests exist to verify is
// Row-Level Security, which lives in the database. A mocked repository would
// happily "pass" an isolation test against a tenancy bug.

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/** Session GUC the RLS policies read. Must match the application's tenant context. */
export const TENANT_SETTING = 'app.current_church_id';

/**
 * Non-superuser role that tests act as.
 *
 * This exists because of a trap that silently voids isolation testing: PostgreSQL
 * does not apply RLS policies to superusers, and a table's owner bypasses them too
 * unless the table is FORCE'd. CI connects as `postgres` — a superuser and the owner
 * of everything it creates — so a test written against that connection passes whether
 * or not the policy works. Every helper here switches to this role before touching
 * tenant data.
 */
export const APP_ROLE = 'app_test';

let pool: Pool | undefined;

/** Admin pool, used for DDL and bootstrapping. Never use it to assert tenant behaviour. */
export function getAdminPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. CI provides it via the postgres service container; ' +
          'locally, start the stack from docs/local-development.md.',
      );
    }
    pool = new Pool({ connectionString, max: 4 });
  }
  return pool;
}

export async function closeAdminPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Creates the non-superuser test role if it does not exist, and grants it schema usage. */
export async function ensureAppRole(client: PoolClient): Promise<void> {
  // The existence check and the CREATE are not atomic, and CI runs this package's suite in
  // parallel with @church/tenancy's against one database — both racing to create the role.
  //
  // Both exception classes are needed: a concurrent CREATE ROLE surfaces as
  // unique_violation on pg_authid_rolname_index, not the duplicate_object you would expect
  // (verified by racing eight connections at it; catching duplicate_object alone still
  // failed). Catching both is what makes this idempotent rather than
  // idempotent-until-it-matters.
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN;
      END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END $$;
  `);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
}

/**
 * Runs `fn` inside a transaction that is always rolled back, so tests leave no residue
 * and can run in any order. DDL is transactional in PostgreSQL, so fixture tables
 * created inside the callback disappear with the rollback too.
 */
export async function withRollback<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAdminPool().connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/**
 * Acts as `churchId` for the duration of `fn`: drops superuser privileges by switching
 * to APP_ROLE and sets the tenant GUC. Both are LOCAL, so they unwind with the
 * surrounding transaction.
 *
 * `set_config(..., true)` is used rather than `SET LOCAL` because the value is
 * parameterised — a church id interpolated into SQL is an injection waiting to happen.
 *
 * Writes made inside `fn` survive: the context is unwound by resetting the role and the
 * GUC, never by rolling back, because tests routinely write as one tenant and then read
 * as another inside the same transaction.
 */
export async function asTenant<T>(
  client: PoolClient,
  churchId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await client.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, churchId]);
  try {
    return await fn();
  } finally {
    await client.query('RESET ROLE').catch(() => undefined);
    await client
      .query('SELECT set_config($1, $2, true)', [TENANT_SETTING, ''])
      .catch(() => undefined);
  }
}

/**
 * Runs a statement expected to be rejected, and reports whether it was.
 *
 * A rejected statement aborts the whole transaction in PostgreSQL, so the attempt is
 * fenced inside a savepoint — without this, the first deliberate RLS violation in a test
 * would poison every assertion after it.
 */
export async function attempt(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<{ ok: boolean; rowCount: number; error?: string }> {
  await client.query('SAVEPOINT attempt');
  try {
    const result = await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT attempt');
    return { ok: true, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT attempt');
    return { ok: false, rowCount: 0, error: (error as Error).message };
  }
}

/**
 * First row of a result, or a clear error. `noUncheckedIndexedAccess` makes `rows[0]`
 * possibly-undefined everywhere, and a named failure beats a non-null assertion.
 */
export function firstRow<T extends QueryResultRow>(result: QueryResult<T>, context: string): T {
  const row = result.rows[0];
  if (!row) throw new Error(`expected at least one row: ${context}`);
  return row;
}
