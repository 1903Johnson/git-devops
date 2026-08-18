// Applies migrations, then refuses to succeed unless every table is properly policied.
//
// CI already calls this via `pnpm -r --if-present run migrate:test`, before the
// integration and isolation suites run.

import { Pool } from 'pg';
import { CORE_MIGRATIONS_DIR, moduleMigrationDirs } from './locations.js';
import { assertPolicyCoverage } from './policy-check.js';
import { applyMigrations, collectMigrations } from './runner.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. CI provides it; locally see docs/local-development.md.');
  process.exit(1);
}

// Defaults to the role the test harness creates, so `migrate:test` works against a CI
// database with no extra setup. Production passes its own unprivileged role.
const appRole = process.env.APP_DB_ROLE ?? 'app_test';

const pool = new Pool({ connectionString, max: 2 });
const client = await pool.connect();

try {
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appRole}') THEN
        CREATE ROLE ${appRole} NOLOGIN;
      END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END $$;
  `);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);

  const migrations = collectMigrations([CORE_MIGRATIONS_DIR, ...moduleMigrationDirs()]);
  const { applied, skipped } = await applyMigrations(client, migrations, { appRole });

  console.log(`migrations: ${applied.length} applied, ${skipped.length} already present`);
  for (const name of applied) console.log(`  + ${name}`);

  await assertPolicyCoverage(client);
  console.log('tenant policy coverage: clean');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
