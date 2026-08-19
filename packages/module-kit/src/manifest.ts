/**
 * The optional-module contract. Every module under `modules/` declares itself with a
 * `ModuleManifest`; the registry reads manifests at boot to build `module_definition`,
 * register permissions, mount routes behind `ModuleGuard`, and drive enable/disable/purge.
 *
 * Specification: docs/02-module-system.md
 */

/** Subscription tier required before a church may enable a module. */
export type PlanTier = 'FREE' | 'BASIC' | 'PRO' | 'ENTERPRISE';

/**
 * Drives retention, tenant export, and purge. `restricted` data is visible only to roles
 * holding an explicit module permission, and every read of it is audited.
 */
export type Sensitivity = 'standard' | 'restricted';

/** ISO 8601 duration, e.g. `P90D`, `P2Y`. */
export type IsoDuration = `P${string}`;

export interface DataClass {
  /** Stable identifier, unique within the module. */
  name: string;
  sensitivity: Sensitivity;
  /** How long this class is kept after the record's own lifecycle ends. */
  retention: IsoDuration;
  /**
   * Encrypt at the field level, not just at rest. Required for anything a breach of the
   * database alone must not expose — pastoral notes, medical/allergy notes, tax IDs.
   */
  fieldEncrypted?: boolean;
}

export interface PurgePolicy {
  /** Disabling a module must never destroy tenant data; it only withdraws access. */
  onDisable: 'retain';
  /** Grace period after disable before the purge job runs. */
  retentionAfterDisable: IsoDuration;
  purgeStrategy: 'hard_delete' | 'anonymize';
  /** Purges are themselves audited: counts and classes, never content. */
  auditPurge: true;
  /**
   * Data classes exempt from purge because law requires retention (financial records).
   * Exempt data is moved to core-owned archival tables before the purge runs.
   */
  legalHoldClasses?: string[];
}

export interface NavEntry {
  label: string;
  path: string;
  icon?: string;
  /** Clients render navigation from the API, never from a hardcoded list. */
  requiresPermission: string;
}

export interface ModuleEvents {
  /** Namespaced `<module_key>.<event>`, e.g. `children_checkin.checked_in`. */
  publishes: string[];
  consumes: string[];
}

export interface ModuleManifest {
  /** snake_case, globally unique. Also the `mod_<key>_` table prefix (boundary rule C4). */
  key: string;
  name: string;
  version: string;
  minPlan: PlanTier;
  /**
   * Whether a newly provisioned, entitled church gets this module on. Modules touching
   * minors, money, or confidential records are always `false`: enabling them is a
   * deliberate act by a church admin, never a default.
   */
  defaultEnabled: boolean;
  /** Keys of other modules this one requires. Validated when a tenant enables it. */
  requires: string[];
  permissions: string[];
  dataClasses: DataClass[];
  purgePolicy: PurgePolicy;
  nav: NavEntry[];
  events: ModuleEvents;
}

/** Per-tenant enablement state, stored in `church_module`. */
export type ModuleStatus = 'enabled' | 'disabled' | 'pending_purge' | 'purged';

/** Error code returned when a route belongs to a module this church has not enabled. */
export const MODULE_NOT_ENABLED = 'MODULE_NOT_ENABLED' as const;

/**
 * Identity helper giving manifests type-checking at the definition site.
 *
 * @example
 * export const manifest = defineModule({ key: 'prayer_wall', ... });
 */
export function defineModule(manifest: ModuleManifest): ModuleManifest {
  return manifest;
}
