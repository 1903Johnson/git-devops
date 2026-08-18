import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { APP_ROLE, createTenantFixtureTable, ensureAppRole, newChurchId } from '@church/testing';
import {
  MissingTenantContextError,
  RlsExemptConnectionError,
  TenantDatabase,
  runWithTenant,
} from '../src/index.js';

let pool: Pool;

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, max: 4 });

  const client = await pool.connect();
  try {
    await ensureAppRole(client);
    // Committed, unlike the harness fixtures: TenantDatabase.transaction() opens its own
    // transaction, so the table has to already exist outside of one.
    await client.query('DROP TABLE IF EXISTS tenancy_probe');
    await createTenantFixtureTable(client, 'tenancy_probe');
  } finally {
    client.release();
  }
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('DROP TABLE IF EXISTS tenancy_probe');
  } finally {
    client.release();
    await pool.end();
  }
});

const db = () => new TenantDatabase(pool, { appRole: APP_ROLE });

describe('TenantDatabase', () => {
  it('refuses to run without a tenant context', async () => {
    await expect(db().transaction(async () => 1)).rejects.toThrow(MissingTenantContextError);
  });

  it('sets the tenant GUC on the transaction connection', async () => {
    const church = newChurchId();
    const seen = await runWithTenant({ churchId: church }, () =>
      db().transaction(async (tx) => {
        const { rows } = await tx.query<{ v: string }>(
          "SELECT current_setting('app.current_church_id', true) AS v",
        );
        return rows[0]?.v;
      }),
    );
    expect(seen).toBe(church);
  });

  it('runs as the unprivileged role, not the connection superuser', async () => {
    const seen = await runWithTenant({ churchId: newChurchId() }, () =>
      db().transaction(async (tx) => {
        const { rows } = await tx.query<{ role: string; su: boolean }>(
          "SELECT current_user AS role, current_setting('is_superuser')::boolean AS su",
        );
        return rows[0];
      }),
    );
    expect(seen?.role).toBe(APP_ROLE);
    expect(seen?.su).toBe(false);
  });

  it('scopes reads to the acting tenant across separate transactions', async () => {
    const a = newChurchId();
    const b = newChurchId();
    const insert = (church: string) =>
      runWithTenant({ churchId: church }, () =>
        db().transaction(async (tx) => {
          await tx.query('INSERT INTO tenancy_probe (church_id, label) VALUES ($1, $2)', [
            church,
            'row',
          ]);
        }),
      );
    await insert(a);
    await insert(b);

    const visible = await runWithTenant({ churchId: a }, () =>
      db().transaction(async (tx) => {
        const { rows } = await tx.query<{ church_id: string }>(
          'SELECT church_id FROM tenancy_probe',
        );
        return rows;
      }),
    );
    expect(visible.every((r) => r.church_id === a)).toBe(true);
    expect(visible.length).toBeGreaterThan(0);
  });

  it('rolls back on error', async () => {
    const church = newChurchId();
    await expect(
      runWithTenant({ churchId: church }, () =>
        db().transaction(async (tx) => {
          await tx.query('INSERT INTO tenancy_probe (church_id, label) VALUES ($1, $2)', [
            church,
            'doomed',
          ]);
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');

    const after = await runWithTenant({ churchId: church }, () =>
      db().transaction(async (tx) => (await tx.query('SELECT id FROM tenancy_probe')).rowCount),
    );
    expect(after).toBe(0);
  });

  it('does not leak the role or GUC to the next user of the pooled connection', async () => {
    // SET LOCAL unwinds at COMMIT, but a regression here would be invisible in normal use
    // and catastrophic in production: the next request on this connection would inherit
    // the previous request's church.
    await runWithTenant({ churchId: newChurchId() }, () => db().transaction(async () => undefined));

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ role: string; v: string | null }>(
        "SELECT current_user AS role, current_setting('app.current_church_id', true) AS v",
      );
      expect(rows[0]?.role).toBe('postgres');
      expect(rows[0]?.v === null || rows[0]?.v === '').toBe(true);
    } finally {
      client.release();
    }
  });
});

describe('assertNotRlsExempt', () => {
  it('rejects a superuser connection', async () => {
    await expect(new TenantDatabase(pool).assertNotRlsExempt()).rejects.toThrow(
      RlsExemptConnectionError,
    );
  });

  it('accepts the unprivileged application role', async () => {
    await expect(db().assertNotRlsExempt()).resolves.toBeUndefined();
  });
});

describe('constructor validation', () => {
  it('rejects an appRole that is not a plain identifier', () => {
    expect(() => new TenantDatabase(pool, { appRole: 'app; DROP TABLE x' })).toThrow(TypeError);
  });
});
