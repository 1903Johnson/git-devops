import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Permission, assertCan } from '@church/policy';
import { AUTHENTICATED_ONLY } from './authenticated.decorator.js';
import { IS_PUBLIC } from './public.decorator.js';
import { REQUIRED_PERMISSION } from './requires-permission.decorator.js';
import { contextOf } from './request-context.js';

/**
 * Enforces the permission a route declares with `@RequiresPermission()`.
 *
 * Deny-by-default in both directions: no subject is a 401, and a protected route that
 * declares no permission is refused rather than allowed. The second half is the one that
 * matters — the common way an authorization system fails is not a wrong rule, it is a route
 * nobody remembered to put a rule on.
 */
@Injectable()
export class PolicyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<object>();
    const { subject } = contextOf(request);
    if (!subject) throw new UnauthorizedException('no authenticated subject');

    // Authenticated with nothing further to check — reading your own profile, ending your
    // own session. The subject test above has already run, so this is not a bypass.
    const anyUser = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (anyUser) return true;

    const permission = this.reflector.getAllAndOverride<Permission>(REQUIRED_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) {
      throw new UndeclaredRouteError(context.getClass().name, context.getHandler().name);
    }

    // Resource-level checks (campus scope, self-access, sensitivity) need the row itself,
    // which only the handler has. This guard proves the subject may perform the operation
    // at all; a handler touching a specific resource calls assertCan again with it.
    assertCan(subject, permission);
    return true;
  }
}

export class UndeclaredRouteError extends Error {
  constructor(controller: string, handler: string) {
    super(`${controller}.${handler} declares neither @RequiresPermission() nor @Public()`);
    this.name = 'UndeclaredRouteError';
  }
}
