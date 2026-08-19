import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '@church/policy';
import { CrossTenantWriteError, MissingTenantContextError } from '@church/tenancy';
import { InvalidAccessTokenError } from '@church/identity';
import { classify } from '../../src/common/error.filter.js';
import { UndeclaredRouteError } from '../../src/common/policy.guard.js';

describe('error classification', () => {
  it('maps a policy denial to 403 without saying which permission failed', () => {
    const result = classify(
      new ForbiddenError('church:manage', { allowed: false, rule: 'missing_permission' }),
    );
    expect(result.status).toBe(403);
    expect(result.code).toBe('FORBIDDEN');
    expect(result.message).not.toContain('church:manage');
    expect(result.internal).toContain('church:manage');
  });

  it('maps an invalid token to 401', () => {
    const result = classify(new InvalidAccessTokenError('expired'));
    expect(result.status).toBe(401);
    expect(result.code).toBe('UNAUTHENTICATED');
  });

  it('treats every tenancy failure as a server error, never a 4xx', () => {
    // These mean the server is wrong. Reported as 400 they would sit in a dashboard as
    // client noise; a cross-tenant write is the most serious thing this app can log.
    for (const error of [
      new CrossTenantWriteError('campus', 'a', 'b'),
      new MissingTenantContextError('query'),
      new UndeclaredRouteError('ThingController', 'list'),
    ]) {
      const result = classify(error);
      expect(result.status).toBe(500);
      expect(result.code).toBe('INTERNAL');
    }
  });

  it('passes through 4xx http exceptions with their message', () => {
    expect(classify(new NotFoundException('no such church'))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'no such church',
    });
    expect(classify(new BadRequestException('bad'))).toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('never lets an internal message escape on a 5xx', () => {
    const leaky = classify(new Error('relation "app_user" does not exist'));
    expect(leaky.message).toBe('Something went wrong');
    expect(leaky.message).not.toContain('app_user');
    expect(leaky.internal).toContain('app_user');

    const leaky5xx = classify(new HttpException('connection string postgres://u:p@h', 503));
    expect(leaky5xx.message).toBe('Something went wrong');
    expect(leaky5xx.message).not.toContain('postgres://');
  });

  it('maps unknown statuses to a defensible code', () => {
    expect(classify(new HttpException('teapot', 418)).code).toBe('BAD_REQUEST');
    expect(classify(new HttpException('gateway', 502)).code).toBe('INTERNAL');
    expect(classify(new HttpException('slow down', 429)).code).toBe('RATE_LIMITED');
  });
});
