// Tenant isolation for anything reached through TenantRepository.
//
// This is the mandatory category from docs/03 §6, applied to the base class itself: if
// the repository leaks, every table built on it leaks.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  APP_ROLE,
  assertTenantIsolation,
  createTenantFixtureTable,
  ensureAppRole,
  newChurchId,
  withRollback,
} from '@church/testing';
import {
  CrossTenantWriteError,
  TenantDatabase,
  TenantRepository,
  runWithTenant,
} from '../src/index.js';

interface ProbeRow {
  id: string;
  church_id: string;
  label: string | null;
}

class ProbeRepository extends TenantRepository<ProbeRow> {
  protected readonly table = 'repo_probe';
}

let pool: Pool;
const repo = new ProbeRepository();
const db = () => new TenantDatabase(pool, { appRole: APP_ROLE });

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, max: 4 });
  const client = await pool.connect();
  try {
    await ensureAppRole(client);
    await client.query('DROP TABLE IF EXISTS repo_probe');
    await createTenantFixtureTable(client, 'repo_probe');
  } finally {
    client.release();
  }
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('DROP TABLE IF EXISTS repo_probe');
  } finally {
    client.release();
    await pool.end();
  }
});

describe('repository tenant isolation', () => {
  it('isolates the repository-backed table', async () => {
    await withRollback(async (client: PoolClient) => {
      await assertTenantIsolation(client, {
        table: 'repo_probe',
        insert: async (c, churchId) => {
          const { rows } = await c.query<{ id: string }>(
            'INSERT INTO repo_probe (church_id, label) VALUES ($1, $2) RETURNING id',
            [churchId, 'seed'],
          );
          if (!rows[0]) throw new Error('insert returned no row');
          return rows[0].id;
        },
      });
    });
  });

  it('cannot read another church row through findById, even with the right id', async () => {
    const a = newChurchId();
    const b = newChurchId();

    const idB = await runWithTenant({ churchId: b }, () =>
      db().transaction(async (tx) => (await repo.insert(tx, { label: 'b-row' })).id),
    );

    const seen = await runWithTenant({ churchId: a }, () =>
      db().transaction((tx) => repo.findById(tx, idB)),
    );
    expect(seen).toBeUndefined();
  });

  it('injects church_id on insert without the caller supplying it', async () => {
    const church = newChurchId();
    const row = await runWithTenant({ churchId: church }, () =>
      db().transaction((tx) => repo.insert(tx, { label: 'injected' })),
    );
    expect(row.church_id).toBe(church);
  });

  it('refuses an insert that names a different church', async () => {
    const church = newChurchId();
    await expect(
      runWithTenant({ churchId: church }, () =>
        db().transaction((tx) => repo.insert(tx, { church_id: newChurchId(), label: 'x' })),
      ),
    ).rejects.toThrow(CrossTenantWriteError);
  });

  it('refuses an update that reassigns a row to another church', async () => {
    const church = newChurchId();
    const row = await runWithTenant({ churchId: church }, () =>
      db().transaction((tx) => repo.insert(tx, { label: 'stays' })),
    );
    await expect(
      runWithTenant({ churchId: church }, () =>
        db().transaction((tx) => repo.update(tx, row.id, { church_id: newChurchId() })),
      ),
    ).rejects.toThrow(CrossTenantWriteError);
  });

  it('cannot update or delete another church row', async () => {
    const a = newChurchId();
    const b = newChurchId();
    const rowB = await runWithTenant({ churchId: b }, () =>
      db().transaction((tx) => repo.insert(tx, { label: 'b-owned' })),
    );

    const updated = await runWithTenant({ churchId: a }, () =>
      db().transaction((tx) => repo.update(tx, rowB.id, { label: 'hijacked' })),
    );
    expect(updated).toBeUndefined();

    const deleted = await runWithTenant({ churchId: a }, () =>
      db().transaction((tx) => repo.deleteById(tx, rowB.id)),
    );
    expect(deleted).toBe(0);

    const stillThere = await runWithTenant({ churchId: b }, () =>
      db().transaction((tx) => repo.findById(tx, rowB.id)),
    );
    expect(stillThere?.label).toBe('b-owned');
  });

  it('rejects an injected column name', async () => {
    const church = newChurchId();
    await expect(
      runWithTenant({ churchId: church }, () =>
        db().transaction((tx) => repo.insert(tx, { 'label) VALUES (1); --': 'x' })),
      ),
    ).rejects.toThrow(TypeError);
  });
});
