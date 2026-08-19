// app_user carries credentials, so its tenant boundary matters more than most.
//
// Note the asymmetry this file exercises: normal access is tenant-scoped and RLS-enforced,
// but authentication reads across tenants by necessity. Both halves are tested, because
// the second one is a deliberate hole and deliberate holes are how leaks start.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  APP_ROLE,
  asTenant,
  assertTenantIsolation,
  attempt,
  ensureAppRole,
  withRollback,
} from '@church/testing';
import { TenantDatabase, runWithTenant } from '@church/tenancy';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { IdentityService } from '../src/index.js';

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
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM church WHERE name LIKE $1', ['identity-iso-%']);
  } finally {
    client.release();
    await pool.end();
  }
});

describe('app_user isolation', () => {
  it('passes the standard tenant-isolation battery', async () => {
    await withRollback(async (client: PoolClient) => {
      await assertTenantIsolation(client, {
        table: 'app_user',
        insert: async (c, churchId) => {
          await c.query(
            `INSERT INTO church (id, name, country) VALUES ($1, 'identity-iso-seed', 'US')`,
            [churchId],
          );
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO app_user (church_id, email, password_hash)
             VALUES ($1, $2, 'scrypt$N=16384,r=8,p=1$c2FsdA==$aGFzaA==') RETURNING id`,
            [churchId, `iso-${Math.random().toString(36).slice(2)}@example.org`],
          );
          if (!rows[0]) throw new Error('insert returned no row');
          return rows[0].id;
        },
      });
    });
  });

  it('hides another church users, including their password hashes', async () => {
    await withRollback(async (client: PoolClient) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('identity-iso-a', 'US'), ('identity-iso-b', 'US')
         RETURNING id`,
      );
      const [a, b] = [rows[0]!.id, rows[1]!.id];
      await client.query(
        `INSERT INTO app_user (church_id, email, password_hash) VALUES ($1, $2, 'secret-hash')`,
        [b, 'victim@example.org'],
      );

      await asTenant(client, a, async () => {
        const visible = await client.query('SELECT password_hash FROM app_user');
        expect(visible.rowCount).toBe(0);
      });
    });
  });
});

describe('refresh_token isolation', () => {
  it('passes the standard tenant-isolation battery', async () => {
    await withRollback(async (client: PoolClient) => {
      await assertTenantIsolation(client, {
        table: 'refresh_token',
        insert: async (c, churchId) => {
          await c.query(
            `INSERT INTO church (id, name, country) VALUES ($1, 'identity-iso-rt', 'US')`,
            [churchId],
          );
          const user = await c.query<{ id: string }>(
            `INSERT INTO app_user (church_id, email) VALUES ($1, $2) RETURNING id`,
            [churchId, `rt-${Math.random().toString(36).slice(2)}@example.org`],
          );
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO refresh_token (church_id, user_id, family_id, token_hash, expires_at)
             VALUES ($1, $2, gen_random_uuid(), $3, now() + interval '30 days') RETURNING id`,
            [churchId, user.rows[0]!.id, `hash-${Math.random().toString(36).slice(2)}`],
          );
          if (!rows[0]) throw new Error('insert returned no row');
          return rows[0].id;
        },
      });
    });
  });
});

describe('MFA table isolation', () => {
  const seedUser = async (c: PoolClient, churchId: string, prefix: string) => {
    await c.query(`INSERT INTO church (id, name, country) VALUES ($1, $2, 'US')`, [
      churchId,
      `identity-iso-${prefix}`,
    ]);
    const user = await c.query<{ id: string }>(
      `INSERT INTO app_user (church_id, email) VALUES ($1, $2) RETURNING id`,
      [churchId, `${prefix}-${Math.random().toString(36).slice(2)}@example.org`],
    );
    return user.rows[0]!.id;
  };

  it('isolates mfa_credential, which holds the encrypted secrets', async () => {
    await withRollback(async (client: PoolClient) => {
      await assertTenantIsolation(client, {
        table: 'mfa_credential',
        insert: async (c, churchId) => {
          const userId = await seedUser(c, churchId, 'mfacred');
          // Passed as parameters rather than inlined: a backslash-x-zero-zero escape
          // inside a template literal is a real NUL byte in the JS string, which
          // derails the Postgres wire protocol rather than producing a bytea literal.
          const filler = Buffer.from([0]);
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO mfa_credential (church_id, user_id, secret_ciphertext, secret_iv, secret_tag)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [churchId, userId, filler, filler, filler],
          );
          if (!rows[0]) throw new Error('insert returned no row');
          return rows[0].id;
        },
      });
    });
  });

  it('isolates mfa_recovery_code', async () => {
    await withRollback(async (client: PoolClient) => {
      await assertTenantIsolation(client, {
        table: 'mfa_recovery_code',
        insert: async (c, churchId) => {
          const userId = await seedUser(c, churchId, 'mfarec');
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO mfa_recovery_code (church_id, user_id, code_hash)
             VALUES ($1, $2, $3) RETURNING id`,
            [churchId, userId, `hash-${Math.random().toString(36).slice(2)}`],
          );
          if (!rows[0]) throw new Error('insert returned no row');
          return rows[0].id;
        },
      });
    });
  });
});

describe('authentication crosses tenants by design', () => {
  it('finds a user by email with no tenant context, and only through the audited path', async () => {
    const service = new IdentityService({
      pool,
      appRole: APP_ROLE,
      policy: { checkBreaches: false },
    });
    const client = await pool.connect();
    let churchId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('identity-iso-login', 'US') RETURNING id`,
      );
      churchId = rows[0]!.id;
    } finally {
      client.release();
    }

    const address = `login-${Math.random().toString(36).slice(2)}@example.org`;
    await service.register(churchId, address, 'correct horse battery staple');

    // Works with no ambient tenant — that is the point.
    expect((await service.verifyCredentials(address, 'correct horse battery staple')).status).toBe(
      'success',
    );

    // And the ordinary tenant-scoped path still cannot see across the boundary: the same
    // lookup inside another church's context finds nothing.
    const db = new TenantDatabase(pool, { appRole: APP_ROLE });
    const otherChurch = '00000000-0000-4000-8000-000000000000';
    const found = await runWithTenant({ churchId: otherChurch }, () =>
      db.transaction(async (tx) => {
        const result = await tx.query('SELECT id FROM app_user WHERE lower(email) = lower($1)', [
          address,
        ]);
        return result.rowCount;
      }),
    );
    expect(found).toBe(0);
  });
});

describe('user_role isolation', () => {
  // Roles decide what a token may do. A leak here is not a data leak, it is a privilege
  // leak: another church's CHURCH_ADMIN row landing in this church's token.
  it('passes the standard tenant-isolation battery', async () => {
    await withRollback(async (client: PoolClient) => {
      await assertTenantIsolation(client, {
        table: 'user_role',
        insert: async (c, churchId) => {
          await c.query(`INSERT INTO church (id, name, country) VALUES ($1, 'iso-role', 'US')`, [
            churchId,
          ]);
          const user = await c.query<{ id: string }>(
            `INSERT INTO app_user (church_id, email) VALUES ($1, $2) RETURNING id`,
            [churchId, `role-${Math.random().toString(36).slice(2)}@example.org`],
          );
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO user_role (church_id, user_id, role) VALUES ($1, $2, 'STAFF') RETURNING id`,
            [churchId, user.rows[0]!.id],
          );
          if (!rows[0]) throw new Error('insert returned no row');
          return rows[0].id;
        },
      });
    });
  });

  it("refuses to grant a role to another church's user", async () => {
    // The composite foreign key, not RLS, is what stops this: FK checks run as the table
    // owner and ignore the tenant policy entirely.
    await withRollback(async (client: PoolClient) => {
      const churches = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('role-a', 'US'), ('role-b', 'US') RETURNING id`,
      );
      const [attacker, victim] = [churches.rows[0]!.id, churches.rows[1]!.id];
      const theirUser = await client.query<{ id: string }>(
        `INSERT INTO app_user (church_id, email) VALUES ($1, $2) RETURNING id`,
        [victim, `victim-${Math.random().toString(36).slice(2)}@example.org`],
      );

      const { code } = await attempt(
        client,
        `INSERT INTO user_role (church_id, user_id, role) VALUES ($1, $2, 'CHURCH_ADMIN')`,
        [attacker, theirUser.rows[0]!.id],
      );
      expect(code).toBe('23503');
    });
  });

  it('requires a campus-scoped role to name its campus', async () => {
    // Without one the policy engine skips its narrowing check and the role reaches the
    // whole church — the unsafe direction, so the state is made unreachable.
    await withRollback(async (client: PoolClient) => {
      const church = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('role-campus', 'US') RETURNING id`,
      );
      const churchId = church.rows[0]!.id;
      const user = await client.query<{ id: string }>(
        `INSERT INTO app_user (church_id, email) VALUES ($1, $2) RETURNING id`,
        [churchId, `campus-${Math.random().toString(36).slice(2)}@example.org`],
      );
      const { code } = await attempt(
        client,
        `INSERT INTO user_role (church_id, user_id, role) VALUES ($1, $2, 'CAMPUS_ADMIN')`,
        [churchId, user.rows[0]!.id],
      );
      expect(code).toBe('23514');
    });
  });

  it('allows only one campus-scoped role per user', async () => {
    // The token and the policy Subject each carry a single campus, so two campuses cannot
    // be represented — and the way that fails today is the campus being omitted, which
    // widens the user's reach instead of narrowing it.
    await withRollback(async (client: PoolClient) => {
      const church = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('role-two-campus', 'US') RETURNING id`,
      );
      const churchId = church.rows[0]!.id;
      const user = await client.query<{ id: string }>(
        `INSERT INTO app_user (church_id, email) VALUES ($1, $2) RETURNING id`,
        [churchId, `two-${Math.random().toString(36).slice(2)}@example.org`],
      );
      const campuses = await client.query<{ id: string }>(
        `INSERT INTO campus (church_id, name) VALUES ($1, 'North'), ($1, 'South') RETURNING id`,
        [churchId],
      );
      const userId = user.rows[0]!.id;
      await client.query(
        `INSERT INTO user_role (church_id, user_id, role, campus_id) VALUES ($1, $2, 'CAMPUS_ADMIN', $3)`,
        [churchId, userId, campuses.rows[0]!.id],
      );
      const { code } = await attempt(
        client,
        `INSERT INTO user_role (church_id, user_id, role, campus_id) VALUES ($1, $2, 'CAMPUS_ADMIN', $3)`,
        [churchId, userId, campuses.rows[1]!.id],
      );
      expect(code).toBe('23505');
    });
  });
});
