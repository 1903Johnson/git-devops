// The permission catalogue.
//
// Permissions are `resource:action` strings. Core owns the ones below; optional modules
// register their own through their manifest (docs/02 §2), which is why the registry is
// open rather than a closed union — a closed set would mean core knew every module's
// permissions, exactly the dependency the architecture forbids.

export type Permission = `${string}:${string}`;

/** Core permissions. Module permissions are namespaced by module key, e.g. `giving:manage`. */
export const CORE_PERMISSIONS = {
  church_read: 'church:read',
  church_manage: 'church:manage',
  campus_read: 'campus:read',
  campus_manage: 'campus:manage',
  person_read: 'person:read',
  person_manage: 'person:manage',
  person_read_self: 'person:read_self',
  person_manage_self: 'person:manage_self',
  group_read: 'group:read',
  group_manage: 'group:manage',
  event_read: 'event:read',
  event_manage: 'event:manage',
  attendance_read: 'attendance:read',
  attendance_record: 'attendance:record',
  user_manage: 'user:manage',
  audit_read: 'audit:read',
  module_manage: 'module:manage',
  billing_manage: 'billing:manage',
} as const satisfies Record<string, Permission>;

export type CorePermission = (typeof CORE_PERMISSIONS)[keyof typeof CORE_PERMISSIONS];

const registered = new Set<Permission>(Object.values(CORE_PERMISSIONS));

/**
 * Registers a module's permissions at boot, from its manifest.
 *
 * Registration is not authorisation — it exists so that a typo in a `@RequiresPermission`
 * fails loudly at startup instead of silently denying every request at runtime, which is
 * the same bug wearing a disguise.
 */
export function registerPermissions(permissions: readonly Permission[]): void {
  for (const permission of permissions) {
    if (!/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(permission)) {
      throw new TypeError(`invalid permission "${permission}"; expected resource:action`);
    }
    registered.add(permission);
  }
}

export const isRegisteredPermission = (permission: Permission): boolean =>
  registered.has(permission);

export const registeredPermissions = (): Permission[] => [...registered].sort();

/** Test helper: forget module registrations so suites do not leak into each other. */
export function resetRegisteredPermissions(): void {
  registered.clear();
  for (const permission of Object.values(CORE_PERMISSIONS)) registered.add(permission);
}
