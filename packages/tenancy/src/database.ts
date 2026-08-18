// Tenant-scoped database access.
//
// The one rule this module exists to enforce: every statement that touches tenant data
// runs on a connection where `app.current_church_id` is set, as a role that RLS applies
// to. Both are per-connection, per-transaction facts, which is why all access is funneled
// through `transaction()` rather than exposed as a bare pool.

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { currentTenant, type TenantContext } from './context.js';

export const TENANT_SETTING = 'app.current_church_id';

/** Postgres identifier, conservatively. Interpolated into SET LOCAL ROLE, which takes no parameters. */
const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

export interface TenantDatabaseOptions {
  /**
   * Role to assume for tenant work. Omit in production, where the connection user should
   * already be the unprivileged application role. Set it in tests, which connect as a
   * superuser that RLS would otherwise ignore entirely.
   */
  readonly appRole?: string;
}

export class RlsExemptConnectionError extends Error {
  constructor(role: string, reason: string) {
    super(
      `Database role "${role}" ${reason}, so row-level security would not apply to it. ` +
        'Tenant isolation depends on RLS; connect as an unprivileged role instead.',
    );
    this.name = 'RlsExemptConnectionError';
  }
}

/** A transaction with the tenant context established. Handed to repositories and services. */
export interface TenantTransaction {
  readonly context: TenantContext;
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export class TenantDatabase {
  readonly #pool: Pool;
  readonly #appRole: string | undefined;

  constructor(pool: Pool, options: TenantDatabaseOptions = {}) {
    if (options.appRole !== undefined && !IDENTIFIER_RE.test(options.appRole)) {
      throw new TypeError(`appRole must be a plain lowercase identifier, got "${options.appRole}"`);
    }
    this.#pool = pool;
    this.#appRole = options.appRole;
  }

  /**
   * Boot-time guard. A superuser, or a role with BYPASSRLS, sails past every policy in the
   * system — the application would run, tests would pass, and isolation would not exist.
   * Call this during startup so that misconfiguration fails loudly at boot instead of
   * silently at runtime.
   */
  async assertNotRlsExempt(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      // Inside a transaction, because SET LOCAL outside one is a silent no-op: the check
      // would keep inspecting the connection user and pass a role it never assumed.
      await client.query('BEGIN');
      if (this.#appRole) await client.query(`SET LOCAL ROLE ${this.#appRole}`);
      const { rows } = await client.query<{
        role: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT current_user AS role, rolsuper, rolbypassrls
           FROM pg_roles WHERE rolname = current_user`,
      );
      const row = rows[0];
      if (!row) throw new Error('could not resolve current_user in pg_roles');
      if (row.rolsuper) throw new RlsExemptConnectionError(row.role, 'is a superuser');
      if (row.rolbypassrls) throw new RlsExemptConnectionError(row.role, 'has BYPASSRLS');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  /**
   * Runs `fn` inside a transaction bound to the ambient tenant.
   *
   * The connection is checked out for the whole transaction on purpose: `SET LOCAL` is
   * scoped to one connection and unwinds at COMMIT. Setting the GUC and then running
   * queries through a pool — where each query may land on a different connection — is the
   * classic way to end up with an isolation layer that is silently inactive.
   */
  async transaction<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    const context = currentTenant('TenantDatabase.transaction');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      if (this.#appRole) await client.query(`SET LOCAL ROLE ${this.#appRole}`);
      await client.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, context.churchId]);
      const result = await fn(wrap(client, context));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Escape hatch for work that legitimately spans tenants: migrations, platform-admin
   * reporting, the module purge job. Named to be conspicuous in review and in grep —
   * every call site should be justifiable out loud.
   */
  async unsafeCrossTenantTransaction<T>(
    reason: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!reason.trim()) throw new TypeError('unsafeCrossTenantTransaction requires a reason');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function wrap(client: PoolClient, context: TenantContext): TenantTransaction {
  return {
    context,
    query: (sql, params) => client.query(sql, params ? [...params] : undefined),
  };
}
