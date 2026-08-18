export {
  SCRYPT_PARAMS,
  dummyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';
export { checkPasswordBreached, type BreachCheckOptions, type BreachResult } from './breach.js';
export {
  PASSWORD_POLICY,
  validatePassword,
  type PolicyFailure,
  type PolicyOptions,
  type PolicyResult,
} from './policy.js';
export {
  LOCKOUT_POLICY,
  isLocked,
  lockRemainingMs,
  registerFailure,
  registerSuccess,
  type LockoutState,
} from './lockout.js';
export {
  IdentityService,
  type IdentityServiceOptions,
  type LoginResult,
  type RegistrationResult,
  type UserRow,
} from './service.js';
