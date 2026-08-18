// Migration runner.
//
// Hand-rolled rather than pulled from a library, for two reasons specific to this
// platform: migrations are discovered from many directories (core plus one per optional
// module, per docs/02 §1), and every applied migration is checked for tenant-policy
// coverage before the run is allowed to succeed. A generic runner would need wrapping for
// both anyway.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PoolClient } from 'pg';

/** Identifier substituted for `@app_role@` in migration SQL. See README for why. */
const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

export interface Migration {
  /** Unique across every source directory; the filename, e.g. `0001_church_and_campus.sql`. */
  readonly name: string;
  readonly source: string;
  readonly sql: string;
}

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

export class MigrationChecksumError extends Error {
  constructor(name: string) {
    super(
      `Migration "${name}" has changed since it was applied. Applied migrations are ` +
        'immutable — add a new migration instead of editing history.',
    );
    this.name = 'MigrationChecksumError';
  }
}

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

/** Reads `*.sql` from each directory that exists, sorted by filename across all of them. */
export function collectMigrations(directories: readonly string[]): Migration[] {
  const migrations: Migration[] = [];
  for (const dir of directories) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      migrations.push({
        name: basename(file),
        source: dir,
        sql: readFileSync(join(dir, file), 'utf8'),
      });
    }
  }

  const seen = new Map<string, string>();
  for (const migration of migrations) {
    const previous = seen.get(migration.name);
    if (previous) {
      throw new Error(
        `Duplicate migration name "${migration.name}" in ${previous} and ${migration.source}. ` +
          'Names must be unique across all migration directories — prefix module migrations ' +
          'with the module key.',
      );
    }
    seen.set(migration.name, migration.source);
  }

  return migrations.sort((a, b) => a.name.localeCompare(b.name));
}

export async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      source      text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Applies pending migrations in name order, each in its own transaction.
 *
 * Per-migration transactions rather than one big one: a failure leaves the successful
 * prefix applied and recorded, which is what makes a re-run resumable instead of
 * re-executing DDL that already landed.
 */
export interface ApplyOptions {
  readonly appRole?: string;
  /**
   * Use savepoints instead of BEGIN/COMMIT, for a caller that already holds a transaction.
   *
   * Without this the runner's COMMIT would commit the *caller's* transaction — a test
   * wrapping a run in a rollback helper would silently persist its fixtures, and a caller
   * batching migrations with other work would lose atomicity at the first migration. The
   * default suits the normal case, where the runner owns the connection.
   */
  readonly nested?: boolean;
}

export async function applyMigrations(
  client: PoolClient,
  migrations: readonly Migration[],
  options: ApplyOptions = {},
): Promise<MigrationResult> {
  if (options.appRole !== undefined && !IDENTIFIER_RE.test(options.appRole)) {
    throw new TypeError(`appRole must be a plain lowercase identifier, got "${options.appRole}"`);
  }

  await ensureMigrationTable(client);
  const { rows } = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  const alreadyApplied = new Map(rows.map((r) => [r.name, r.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    const sql = options.appRole
      ? migration.sql.replaceAll('@app_role@', options.appRole)
      : migration.sql;
    const digest = checksum(migration.sql);
    const previous = alreadyApplied.get(migration.name);

    if (previous !== undefined) {
      // Compared against the raw file, not the substituted SQL, so the same migration
      // verifies identically whatever role a given environment runs as.
      if (previous !== digest) throw new MigrationChecksumError(migration.name);
      skipped.push(migration.name);
      continue;
    }

    const begin = options.nested ? 'SAVEPOINT migration_step' : 'BEGIN';
    const commit = options.nested ? 'RELEASE SAVEPOINT migration_step' : 'COMMIT';
    const undo = options.nested ? 'ROLLBACK TO SAVEPOINT migration_step' : 'ROLLBACK';

    await client.query(begin);
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum, source) VALUES ($1, $2, $3)',
        [migration.name, digest, migration.source],
      );
      await client.query(commit);
      applied.push(migration.name);
    } catch (error) {
      await client.query(undo).catch(() => undefined);
      throw new Error(`migration "${migration.name}" failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  return { applied, skipped };
}
