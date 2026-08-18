export {
  MigrationChecksumError,
  applyMigrations,
  collectMigrations,
  ensureMigrationTable,
  type ApplyOptions,
  type Migration,
  type MigrationResult,
} from './runner.js';
export {
  PLATFORM_TABLES,
  TENANT_ROOT_TABLES,
  assertPolicyCoverage,
  findPolicyGaps,
  type PolicyGap,
} from './policy-check.js';
export { CORE_MIGRATIONS_DIR, moduleMigrationDirs } from './locations.js';
