// The authorization decision.
//
// Pure: it takes a subject, a permission, and a resource description, and returns a
// decision. No database access, no ambient state. The facts it needs — which groups this
// user leads, which campus a record belongs to — are supplied by the caller, because a
// policy engine that queries is a policy engine you cannot reason about or test
// exhaustively.
//
// Every decision carries the rule that produced it. That is not decoration: the audit log
// (CORE-021) records *why* access was granted, and "denied" with no reason is unactionable
// when a pastor calls to say they cannot see something they should.

import { type Permission } from './permissions.js';
import { CAMPUS_SCOPED_ROLES, permissionsFor, type Role } from './roles.js';

export interface Subject {
  readonly userId: string;
  readonly churchId: string;
  readonly roles: readonly Role[];
  /** Set for campus-scoped roles. Their reach stops at this campus. */
  readonly campusId?: string;
  /** The person record belonging to this user, for self-access. */
  readonly personId?: string;
  /** Groups this user leads. Supplied by the caller; the engine does not look them up. */
  readonly ledGroupIds?: readonly string[];
}

export interface Resource {
  readonly type: string;
  readonly churchId: string;
  readonly campusId?: string;
  /** The person this resource is about, for self-access checks. */
  readonly personId?: string;
  readonly groupId?: string;
  /** Restricted resources need an explicit permission, never a broad one (docs/02 §2.4.5). */
  readonly sensitivity?: 'standard' | 'restricted';
}

export type DenyRule =
  | 'cross_tenant'
  | 'missing_permission'
  | 'campus_scope'
  | 'not_group_leader'
  | 'restricted_sensitivity';

export type AllowRule = 'self_access' | 'role_permission';

export type PolicyDecision =
  | { readonly allowed: true; readonly rule: AllowRule }
  | { readonly allowed: false; readonly rule: DenyRule; readonly detail?: string };

export class ForbiddenError extends Error {
  constructor(
    readonly permission: Permission,
    readonly decision: Extract<PolicyDecision, { allowed: false }>,
  ) {
    super(`Denied ${permission}: ${decision.rule}`);
    this.name = 'ForbiddenError';
  }
}

const SELF_PERMISSIONS: Record<string, string> = {
  'person:read': 'person:read_self',
  'person:manage': 'person:manage_self',
};

/**
 * Decides whether `subject` may perform `permission`, optionally on `resource`.
 *
 * Deny by default: every path that is not an explicit allow returns a denial. Order
 * matters — tenancy is checked before permissions, so a cross-tenant attempt is reported
 * as such rather than as a missing role, and never reveals whether the permission exists.
 */
export function can(subject: Subject, permission: Permission, resource?: Resource): PolicyDecision {
  // 1. Tenancy. RLS is the backstop; this is the same boundary asserted a layer earlier,
  //    where it can be reported rather than silently returning nothing.
  if (resource && resource.churchId !== subject.churchId) {
    return { allowed: false, rule: 'cross_tenant' };
  }

  const granted = permissionsFor(subject.roles);

  // 2. Self-access. A member with no broad permission may still read and edit their own
  //    record — the single most common authenticated request in the product.
  const selfPermission = SELF_PERMISSIONS[permission];
  if (
    selfPermission &&
    resource?.personId &&
    subject.personId &&
    resource.personId === subject.personId &&
    granted.has(selfPermission as Permission)
  ) {
    return { allowed: true, rule: 'self_access' };
  }

  // 3. The role must actually carry the permission.
  if (!granted.has(permission)) {
    return { allowed: false, rule: 'missing_permission', detail: permission };
  }

  // 4. Campus scoping. A campus admin holds church-wide permissions but may only exercise
  //    them on their own campus; campus_id is a scoping filter, never an isolation
  //    boundary (docs/01 §2.3), which is why this is enforced here and not by RLS.
  const campusScoped = subject.roles.some((role) => CAMPUS_SCOPED_ROLES.includes(role));
  const churchWide = subject.roles.some(
    (role) => !CAMPUS_SCOPED_ROLES.includes(role) && role !== 'MEMBER' && role !== 'VOLUNTEER',
  );
  if (campusScoped && !churchWide && subject.campusId && resource?.campusId) {
    if (resource.campusId !== subject.campusId) {
      return { allowed: false, rule: 'campus_scope', detail: resource.campusId };
    }
  }

  // 5. Group leadership. `group:manage` from the GROUP_LEADER role reaches only the groups
  //    they lead; staff and above hold it church-wide.
  if (permission === 'group:manage' && resource?.groupId) {
    const leadsThisGroup = subject.ledGroupIds?.includes(resource.groupId) ?? false;
    const beyondLeader = subject.roles.some((role) =>
      (['STAFF', 'PASTOR', 'CAMPUS_ADMIN', 'CHURCH_ADMIN'] as readonly Role[]).includes(role),
    );
    if (!beyondLeader && !leadsThisGroup) {
      return { allowed: false, rule: 'not_group_leader', detail: resource.groupId };
    }
  }

  // 6. Restricted data needs a permission that names it. A broad `pastoral_care:read` must
  //    not reach a case marked restricted; that requires `pastoral_care:read_restricted`.
  if (resource?.sensitivity === 'restricted' && !permission.endsWith('_restricted')) {
    const restricted = `${permission}_restricted` as Permission;
    if (!granted.has(restricted)) {
      return { allowed: false, rule: 'restricted_sensitivity', detail: restricted };
    }
  }

  return { allowed: true, rule: 'role_permission' };
}

/** Throws unless allowed. The form most call sites want. */
export function assertCan(subject: Subject, permission: Permission, resource?: Resource): void {
  const decision = can(subject, permission, resource);
  if (!decision.allowed) throw new ForbiddenError(permission, decision);
}
