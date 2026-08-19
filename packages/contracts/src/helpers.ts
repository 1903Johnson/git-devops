import type { components } from './generated/schema.js';

export type Church = components['schemas']['Church'];
export type ChurchUpdate = components['schemas']['ChurchUpdate'];
export type Campus = components['schemas']['Campus'];
export type CampusCreate = components['schemas']['CampusCreate'];
export type CampusUpdate = components['schemas']['CampusUpdate'];
export type Address = components['schemas']['Address'];
export type Person = components['schemas']['Person'];
export type PersonCreate = components['schemas']['PersonCreate'];
export type PersonUpdate = components['schemas']['PersonUpdate'];
export type MembershipStatus = components['schemas']['MembershipStatus'];
export type MembershipStatusChange = components['schemas']['MembershipStatusChange'];
export type MilestoneType = components['schemas']['MilestoneType'];
export type Milestone = components['schemas']['Milestone'];
export type MilestoneCreate = components['schemas']['MilestoneCreate'];
export type Family = components['schemas']['Family'];
export type FamilyCreate = components['schemas']['FamilyCreate'];
export type FamilyRelationship = components['schemas']['FamilyRelationship'];
export type FamilyMember = components['schemas']['FamilyMember'];
export type FamilyMemberCreate = components['schemas']['FamilyMemberCreate'];
export type LoginRequest = components['schemas']['LoginRequest'];
export type LoginResult = components['schemas']['LoginResult'];
export type LoginSuccess = components['schemas']['LoginSuccess'];
export type MfaChallenge = components['schemas']['MfaChallenge'];
export type MfaRequest = components['schemas']['MfaRequest'];
export type RefreshRequest = components['schemas']['RefreshRequest'];
export type TokenPair = components['schemas']['TokenPair'];
export type CurrentUser = components['schemas']['CurrentUser'];
export type AuditEntry = components['schemas']['AuditEntry'];
export type PlanTier = components['schemas']['PlanTier'];
export type ModuleStatus = components['schemas']['ModuleStatus'];
export type ChurchModule = components['schemas']['ChurchModule'];
export type ModuleEnableRequest = components['schemas']['ModuleEnableRequest'];
export type PageInfo = components['schemas']['PageInfo'];

/** A page of results, matching the envelope every list endpoint returns. */
export interface Page<T> {
  data: T[];
  page: PageInfo;
}

/** Default and maximum `limit`, mirroring the spec so callers do not guess. */
export const PAGE_SIZE = { default: 25, max: 100 } as const;
