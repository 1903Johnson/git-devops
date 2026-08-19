import { UnauthorizedException } from '@nestjs/common';
import type { Role, Subject } from '@church/policy';
import { currentTenant } from '@church/tenancy';

/**
 * The authenticated caller, rebuilt from the tenant context inside a handler.
 *
 * `AuthGuard` built this Subject and `TenantInterceptor` carried it into the context, so
 * this is a read rather than a second derivation — but it is worth having in one place,
 * because a controller reaching into `currentTenant()` and assembling its own Subject is
 * how the two drift apart.
 */
export function subjectOf(): Subject {
  const context = currentTenant('subjectOf');
  if (!context.userId) throw new UnauthorizedException('No authenticated user');
  return {
    userId: context.userId,
    churchId: context.churchId,
    roles: (context.roles ?? []) as Role[],
    ...(context.campusId ? { campusId: context.campusId } : {}),
  };
}
