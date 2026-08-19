import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { type ModuleManifest, loadModules, syncModuleDefinitions } from '../../src/index.js';

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;
let pool: Pool;
let client: PoolClient;
let manifests: ModuleManifest[];

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, max: 2 });
  client = await pool.connect();
  await ensureAppRole(client);
  await applyMigrations(client, collectMigrations([CORE_MIGRATIONS_DIR]), { appRole: APP_ROLE });
  manifests = (await loadModules(FIXTURES)).map((module) => module.manifest);
});

afterAll(async () => {
  await client.query(
    `DELETE FROM module_definition WHERE key LIKE '%_module' OR key LIKE 'needs_%'`,
  );
  client.release();
  await pool.end();
});

beforeEach(async () => {
  await client.query('DELETE FROM church_module');
  await client.query('DELETE FROM module_definition');
});

describe('syncing manifests into the catalogue', () => {
  it('inserts on first run and updates on the next', async () => {
    const first = await syncModuleDefinitions(client, manifests);
    expect(first.inserted.sort()).toEqual(['good_module', 'needs_good']);
    expect(first.updated).toEqual([]);

    const second = await syncModuleDefinitions(client, manifests);
    expect(second.inserted).toEqual([]);
    expect(second.updated.sort()).toEqual(['good_module', 'needs_good']);
  });

  it('is a projection of the manifest, not a merge', async () => {
    // The manifest is the source of truth. If the table could diverge from it there would
    // be two answers to "what does this module hold?" and no rule for which one wins.
    await syncModuleDefinitions(client, manifests);
    await client.query(`UPDATE module_definition SET version = '0.0.0-drift', name = 'Tampered'`);
    await syncModuleDefinitions(client, manifests);

    const { rows } = await client.query<{ version: string; name: string }>(
      `SELECT version, name FROM module_definition WHERE key = 'good_module'`,
    );
    expect(rows[0]).toEqual({ version: '1.0.0', name: 'Good Module' });
  });

  it('carries the purge policy and data classes across as written', async () => {
    // CORE-024's purge job reads these. A lossy projection here would mean deleting the
    // wrong things, or missing a legal hold.
    await syncModuleDefinitions(client, manifests);
    const { rows } = await client.query<{
      purge_policy: Record<string, unknown>;
      data_classes: unknown[];
    }>(`SELECT purge_policy, data_classes FROM module_definition WHERE key = 'needs_good'`);
    expect(rows[0]?.purge_policy).toEqual({
      onDisable: 'retain',
      retentionAfterDisable: 'P30D',
      purgeStrategy: 'anonymize',
      auditPurge: true,
    });
    expect(rows[0]?.data_classes).toEqual([
      { name: 'record', sensitivity: 'restricted', retention: 'P1Y', fieldEncrypted: true },
    ]);
  });

  it('reports a definition whose module has gone, and leaves the row alone', async () => {
    // Never deleted. A church may still hold that module's data, and church_module
    // references the row — dropping it would either fail or orphan tenant data. Removing a
    // module from a deployment has to be a deliberate purge, not a side effect of a deploy.
    await syncModuleDefinitions(client, manifests);
    const withoutOne = manifests.filter((manifest) => manifest.key !== 'needs_good');
    const result = await syncModuleDefinitions(client, withoutOne);

    expect(result.orphaned).toEqual(['needs_good']);
    const { rowCount } = await client.query(
      `SELECT 1 FROM module_definition WHERE key = 'needs_good'`,
    );
    expect(rowCount).toBe(1);
  });

  it('refuses to drop a definition a church still references', async () => {
    await syncModuleDefinitions(client, manifests);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO church (name, country) VALUES ('sync-guard', 'US') RETURNING id`,
    );
    await client.query(
      `INSERT INTO church_module (church_id, module_key, status) VALUES ($1, 'good_module', 'disabled')`,
      [rows[0]!.id],
    );
    await expect(
      client.query(`DELETE FROM module_definition WHERE key = 'good_module'`),
    ).rejects.toMatchObject({ code: '23503' });
    await client.query('DELETE FROM church WHERE id = $1', [rows[0]!.id]);
  });
});
