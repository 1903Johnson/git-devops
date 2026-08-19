import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@church/policy';

export const REQUIRED_PERMISSION = 'policy:permission';

/**
 * Declares the permission a route needs. `PolicyGuard` reads it and calls `assertCan`.
 *
 * A route with neither this nor `@Public()` is refused at request time rather than allowed:
 * an undeclared route is an unfinished one, and the safe reading of "the author forgot" is
 * not "let everyone in".
 */
export const RequiresPermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION, permission);
