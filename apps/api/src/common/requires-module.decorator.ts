import { SetMetadata } from '@nestjs/common';

export const REQUIRED_MODULE = 'module:key';

/**
 * Marks a route as belonging to an optional module. `ModuleGuard` returns 404
 * `MODULE_NOT_ENABLED` unless the tenant has that module enabled.
 *
 * Applied to the controller so it covers every route in it. A module route that forgets
 * this decorator is reachable by any tenant, enabled or not — which is why the boundary
 * check greps for module controllers without one.
 */
export const RequiresModule = (moduleKey: string): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_MODULE, moduleKey);
