// Roles, and what each one may do.
//
// The mapping lives in code rather than the database on purpose: it is reviewable in a
// diff, testable, and versioned with the release. Per-church custom roles are a later
// feature and will layer on top — a church granting itself `billing:manage` through a UI
// is a different, deliberate decision, not an accident of storage.

import { CORE_PERMISSIONS, type Permission } from './permissions.js';

export const ROLES = [
  'MEMBER',
  'VOLUNTEER',
  'GROUP_LEADER',
  'STAFF',
  'PASTOR',
  'CAMPUS_ADMIN',
  'CHURCH_ADMIN',
] as const;

export type Role = (typeof ROLES)[number];

const P = CORE_PERMISSIONS;

/**
 * Every member can read and edit their own record; nothing here grants access to anyone
 * else's. Broader read comes from the directory feature, which is its own permission.
 */
const MEMBER: Permission[] = [P.person_read_self, P.person_manage_self, P.event_read, P.group_read];

const VOLUNTEER: Permission[] = [...MEMBER, P.attendance_record];

/** Scoped further at the resource level: only groups they actually lead. */
const GROUP_LEADER: Permission[] = [...VOLUNTEER, P.group_manage, P.attendance_read];

const STAFF: Permission[] = [
  ...GROUP_LEADER,
  P.person_read,
  P.person_manage,
  P.event_manage,
  P.campus_read,
  P.church_read,
];

const PASTOR: Permission[] = [...STAFF];

/** Church-wide permissions, but confined to one campus by the engine's campus rule. */
const CAMPUS_ADMIN: Permission[] = [...STAFF, P.campus_manage, P.user_manage];

const CHURCH_ADMIN: Permission[] = [
  ...CAMPUS_ADMIN,
  P.church_manage,
  P.audit_read,
  P.module_manage,
  P.billing_manage,
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  MEMBER: Object.freeze([...new Set(MEMBER)]),
  VOLUNTEER: Object.freeze([...new Set(VOLUNTEER)]),
  GROUP_LEADER: Object.freeze([...new Set(GROUP_LEADER)]),
  STAFF: Object.freeze([...new Set(STAFF)]),
  PASTOR: Object.freeze([...new Set(PASTOR)]),
  CAMPUS_ADMIN: Object.freeze([...new Set(CAMPUS_ADMIN)]),
  CHURCH_ADMIN: Object.freeze([...new Set(CHURCH_ADMIN)]),
});

/** Roles confined to a single campus. Their permissions do not reach the rest of the church. */
export const CAMPUS_SCOPED_ROLES: readonly Role[] = ['CAMPUS_ADMIN'];

/** Permissions a role holds directly, before any resource-level narrowing. */
export function permissionsFor(roles: readonly Role[]): Set<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
  }
  return granted;
}
