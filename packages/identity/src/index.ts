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
export {
  ACCESS_TOKEN_TTL_SECONDS,
  ENROLLMENT_TICKET_TTL_SECONDS,
  MFA_CHALLENGE_TTL_SECONDS,
  InvalidAccessTokenError,
  issueEnrollmentTicket,
  issueMfaChallenge,
  verifyEnrollmentTicket,
  verifyMfaChallenge,
  type MfaChallengeClaims,
  issueAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
  type KeyRing,
  type SigningKey,
} from './jwt.js';
export {
  REFRESH_TOKEN_TTL_DAYS,
  decideRefresh,
  generateRefreshSecret,
  hashRefreshSecret,
  refreshExpiry,
  type RefreshDecision,
  type StoredRefreshToken,
} from './refresh.js';
export {
  SessionService,
  type RefreshOutcome,
  type SessionResult,
  type SessionServiceOptions,
  type TokenPair,
} from './session.js';
export {
  TOTP,
  counterFor,
  fromBase32,
  generateCode,
  generateTotpSecret,
  otpauthUri,
  toBase32,
  verifyCode,
  type TotpVerification,
} from './totp.js';
export { SecretDecryptionError, openSecret, sealSecret, type SealedSecret } from './secret-box.js';
export {
  MFA_REQUIRED_ROLES,
  MfaService,
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  hashRecoveryCode,
  mfaRequiredFor,
  normalizeRecoveryCode,
  type ConfirmResult,
  type EnrollmentChallenge,
  type MfaServiceOptions,
  type MfaVerifyResult,
} from './mfa.js';
