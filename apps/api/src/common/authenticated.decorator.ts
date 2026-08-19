import { SetMetadata } from '@nestjs/common';

export const AUTHENTICATED_ONLY = 'auth:any-user';

/**
 * Marks a route as needing a signed-in user and no particular permission.
 *
 * The narrow gap between `@Public()` and `@RequiresPermission()`. `PolicyGuard` refuses a
 * route that declares neither, which is the right default — an undeclared route is an
 * unfinished one — but a few routes genuinely have nothing to check beyond identity:
 * reading your own profile, ending your own session. Those need a way to say so out loud
 * rather than by being handed a permission that does not mean anything.
 *
 * It is not a weaker `@Public()`: the request is still authenticated, still carries a
 * tenant, and still runs under RLS.
 */
export const Authenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHENTICATED_ONLY, true);
