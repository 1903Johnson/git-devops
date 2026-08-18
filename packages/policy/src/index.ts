export {
  CORE_PERMISSIONS,
  isRegisteredPermission,
  registerPermissions,
  registeredPermissions,
  resetRegisteredPermissions,
  type CorePermission,
  type Permission,
} from './permissions.js';
export {
  CAMPUS_SCOPED_ROLES,
  ROLES,
  ROLE_PERMISSIONS,
  permissionsFor,
  type Role,
} from './roles.js';
export {
  ForbiddenError,
  assertCan,
  can,
  type AllowRule,
  type DenyRule,
  type PolicyDecision,
  type Resource,
  type Subject,
} from './engine.js';
