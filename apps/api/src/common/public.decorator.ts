import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';

/**
 * Opts a route out of authentication.
 *
 * Authentication is on by default — `AuthGuard` is registered globally — so a new
 * controller is protected the moment it is written, and exposing something publicly is a
 * visible, greppable act rather than an omission.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
