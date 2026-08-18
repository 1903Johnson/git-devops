import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { APP_ROLE, ensureAppRole, withRollback } from '@church/testing';
import {
  MigrationChecksumError,
  applyMigrations,
  collectMigrations,
  findPolicyGaps,
} from '../src/index.js';
import { CORE_MIGRATIONS_DIR } from '../src/locations.js';

let pool: Pool;

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, max: 4 });
  const client = await pool.connect();
  try {
    await ensureAppRole(client);
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.end();
});

const migration = (name: string, sql: string) => ({ name, source: 'test', sql });

describe('collectMigrations', () => {
  it('reads the core directory in name order', () => {
    const found = collectMigrations([CORE_MIGRATIONS_DIR]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((m) => m.name)).toEqual([...found.map((m) => m.name)].sort());
  });

  it('ignores a directory that does not exist', () => {
    expect(collectMigrations(['/nonexistent/migrations'])).toEqual([]);
  });

  it('rejects the same migration name in two directories', () => {
    // Module migrations live in their own directories; two modules both shipping
    // 0001_init.sql would apply one and silently skip the other.
    const dirs = [CORE_MIGRATIONS_DIR, CORE_MIGRATIONS_DIR];
    expect(() => collectMigrations(dirs)).toThrow(/Duplicate migration name/);
  });
});

describe('applyMigrations', () => {
  it('applies pending migrations and skips ones already recorded', async () => {
    await withRollback(async (client: PoolClient) => {
      const one = migration('9001_probe.sql', 'CREATE TABLE runner_probe (id int PRIMARY KEY)');
      const first = await applyMigrations(client, [one], { nested: true });
      expect(first.applied).toEqual(['9001_probe.sql']);

      const second = await applyMigrations(client, [one], { nested: true });
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(['9001_probe.sql']);
    });
  });

  it('refuses to run a migration that changed after being applied', async () => {
    await withRollback(async (client: PoolClient) => {
      await applyMigrations(
        client,
        [migration('9002_probe.sql', 'CREATE TABLE checksum_probe (id int)')],
        { nested: true },
      );
      await expect(
        applyMigrations(
          client,
          [migration('9002_probe.sql', 'CREATE TABLE checksum_probe (id int, extra text)')],
          { nested: true },
        ),
      ).rejects.toThrow(MigrationChecksumError);
    });
  });

  it('rolls a failing migration back without recording it', async () => {
    await withRollback(async (client: PoolClient) => {
      await expect(
        applyMigrations(client, [migration('9003_bad.sql', 'CREATE TABLE ( totally invalid')], {
          nested: true,
        }),
      ).rejects.toThrow(/9003_bad\.sql/);

      const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [
        '9003_bad.sql',
      ]);
      expect(rowCount).toBe(0);
    });
  });

  it('substitutes the app role placeholder', async () => {
    await withRollback(async (client: PoolClient) => {
      await applyMigrations(
        client,
        [
          migration(
            '9004_grant.sql',
            'CREATE TABLE grant_probe (id int); GRANT SELECT ON grant_probe TO @app_role@;',
          ),
        ],
        { appRole: APP_ROLE, nested: true },
      );
      const { rowCount } = await client.query(
        `SELECT 1 FROM information_schema.role_table_grants
          WHERE table_name = 'grant_probe' AND grantee = $1`,
        [APP_ROLE],
      );
      expect(rowCount).toBeGreaterThan(0);
    });
  });

  it('rejects an app role that is not a plain identifier', async () => {
    await withRollback(async (client: PoolClient) => {
      await expect(
        applyMigrations(client, [], { appRole: 'evil; DROP TABLE church', nested: true }),
      ).rejects.toThrow(TypeError);
    });
  });
});

describe('findPolicyGaps', () => {
  const cases: Array<{ name: string; ddl: string; expect: RegExp }> = [
    {
      name: 'a tenant table with no RLS at all',
      ddl: 'CREATE TABLE gap_none (id uuid PRIMARY KEY, church_id uuid NOT NULL)',
      expect: /row level security is not enabled/,
    },
    {
      name: 'RLS enabled but not forced',
      ddl: `CREATE TABLE gap_unforced (id uuid PRIMARY KEY, church_id uuid NOT NULL);
            ALTER TABLE gap_unforced ENABLE ROW LEVEL SECURITY;
            CREATE POLICY p ON gap_unforced
              USING (church_id = current_setting('app.current_church_id', true)::uuid)
              WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);`,
      expect: /not FORCE/,
    },
    {
      name: 'RLS on with no policy',
      ddl: `CREATE TABLE gap_nopolicy (id uuid PRIMARY KEY, church_id uuid NOT NULL);
            ALTER TABLE gap_nopolicy ENABLE ROW LEVEL SECURITY;
            ALTER TABLE gap_nopolicy FORCE ROW LEVEL SECURITY;`,
      expect: /no policy is defined/,
    },
    {
      name: 'a policy with no WITH CHECK',
      ddl: `CREATE TABLE gap_nocheck (id uuid PRIMARY KEY, church_id uuid NOT NULL);
            ALTER TABLE gap_nocheck ENABLE ROW LEVEL SECURITY;
            ALTER TABLE gap_nocheck FORCE ROW LEVEL SECURITY;
            CREATE POLICY p ON gap_nocheck FOR SELECT
              USING (church_id = current_setting('app.current_church_id', true)::uuid);`,
      expect: /WITH CHECK/,
    },
    {
      name: 'a policy of USING (true), which passes every structural check',
      ddl: `CREATE TABLE gap_wideopen (id uuid PRIMARY KEY, church_id uuid NOT NULL);
            ALTER TABLE gap_wideopen ENABLE ROW LEVEL SECURITY;
            ALTER TABLE gap_wideopen FORCE ROW LEVEL SECURITY;
            CREATE POLICY p ON gap_wideopen USING (true) WITH CHECK (true);`,
      expect: /does not reference current_setting/,
    },
    {
      name: 'a table with no church_id and no declared exemption',
      ddl: 'CREATE TABLE gap_untenanted (id uuid PRIMARY KEY, name text)',
      expect: /no church_id column and is not a declared tenant-root/,
    },
  ];

  for (const testCase of cases) {
    it(`catches ${testCase.name}`, async () => {
      await withRollback(async (client: PoolClient) => {
        await client.query(testCase.ddl);
        const gaps = await findPolicyGaps(client);
        const problems = gaps.map((g) => g.problem).join('\n');
        expect(problems).toMatch(testCase.expect);
      });
    });
  }

  it('passes the real core schema', async () => {
    const client = await pool.connect();
    try {
      const gaps = await findPolicyGaps(client);
      expect(gaps).toEqual([]);
    } finally {
      client.release();
    }
  });
});
