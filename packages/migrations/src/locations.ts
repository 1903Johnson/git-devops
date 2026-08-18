import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Core schema. Owned by Claude — shared tables are a contract other workstreams build on. */
export const CORE_MIGRATIONS_DIR = resolve(here, '../sql');

const repoRoot = resolve(here, '../../..');

/**
 * One migration directory per optional module (docs/02 §1). Discovered rather than listed,
 * so adding a module needs no edit to a central file — the same reason the module registry
 * reads manifests by convention.
 */
export function moduleMigrationDirs(root = repoRoot): string[] {
  const modulesDir = join(root, 'modules');
  if (!existsSync(modulesDir)) return [];
  return readdirSync(modulesDir)
    .map((entry) => join(modulesDir, entry, 'migrations'))
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
}
