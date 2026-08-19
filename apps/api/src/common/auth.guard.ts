import {
  CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InvalidAccessTokenError, verifyAccessToken } from '@church/identity';
import { ROLES, type Role, type Subject } from '@church/policy';
import { API_CONFIG } from './tokens.js';
import type { ApiConfig } from '../config.js';
import { IS_PUBLIC } from './public.decorator.js';
import { contextOf } from './request-context.js';

/**
 * Verifies the bearer token and builds the `Subject` every later stage reasons about.
 *
 * Registered globally: routes are authenticated unless they carry `@Public()`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const header = request.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }

    let claims;
    try {
      claims = await verifyAccessToken(header.slice('Bearer '.length), this.config.keys);
    } catch (error) {
      if (error instanceof InvalidAccessTokenError) {
        throw new UnauthorizedException('invalid access token');
      }
      throw error;
    }

    contextOf(request).subject = toSubject(claims);
    return true;
  }
}

/**
 * Token claims to policy subject.
 *
 * Roles are filtered against the registry rather than cast. A token is signed data, not
 * trusted data: it may have been issued by an older deploy that knew a role this one has
 * removed. Dropping an unrecognised role can only reduce what the request may do, which is
 * the direction an unknown value should always fail in.
 *
 * `personId` is deliberately absent. It is not in the token, and self-access
 * (`person:read_self`) therefore denies today — `can()` short-circuits when the subject has
 * no person. That is the safe half of the failure, but it is a real gap: CORE-017 must
 * resolve `app_user.person_id` here before self-service reads can work. There is a test
 * pinning the current behaviour so the change is visible when it happens.
 */
export function toSubject(claims: {
  sub: string;
  church_id: string;
  roles: readonly string[];
  campus_id?: string;
}): Subject {
  const roles = claims.roles.filter((role): role is Role =>
    (ROLES as readonly string[]).includes(role),
  );
  return {
    userId: claims.sub,
    churchId: claims.church_id,
    roles,
    ...(claims.campus_id ? { campusId: claims.campus_id } : {}),
  };
}
