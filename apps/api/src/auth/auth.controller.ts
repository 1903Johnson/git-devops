import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type {
  CurrentUser,
  LoginRequest,
  LoginResult,
  MfaEnrollmentConfirmRequest,
  MfaEnrollmentConfirmed,
  MfaEnrollmentRequest,
  MfaEnrollmentStart,
  MfaRequest,
  RefreshRequest,
  TokenPair,
} from '@church/contracts';
import {
  ENROLLMENT_TICKET_TTL_SECONDS,
  MFA_CHALLENGE_TTL_SECONDS,
  type SessionResult,
} from '@church/identity';
import { currentTenant } from '@church/tenancy';
import { Authenticated } from '../common/authenticated.decorator.js';
import { Public } from '../common/public.decorator.js';
import { AuthService } from './auth.service.js';

/**
 * The way in. Every route here is `@Public()` except the two that act on an existing
 * session — a caller with no token has to be able to reach the endpoint that gives them
 * one.
 *
 * The controller does no security reasoning of its own. Password verification, lockout,
 * token rotation, theft detection and TOTP all live in `@church/identity`; this maps their
 * outcomes onto HTTP and takes care not to say more than it should while doing it.
 */
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    if (!body?.email || !body?.password)
      throw new BadRequestException('email and password are required');
    const result = await this.auth.sessions.login(body.email, body.password, body.deviceLabel);
    const presented = this.presentSession(result, reply);
    await this.auditLogin(presented);
    return presented;
  }

  @Public()
  @Post('auth/mfa')
  @HttpCode(HttpStatus.OK)
  async completeMfa(@Body() body: MfaRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    if (!body?.challenge || !body?.code)
      throw new BadRequestException('challenge and code are required');
    const result = await this.auth.sessions.completeMfa(body.challenge, body.code);
    const presented = this.presentSession(result, reply);
    await this.auditLogin(presented);
    return presented;
  }

  /**
   * Both enrollment routes are `@Public()` and authorised by the ticket in the body. That
   * is the point of the ticket: the caller has been refused a session and must not be
   * handed anything a bearer token would open.
   */
  @Public()
  @Post('auth/mfa/enroll')
  @HttpCode(HttpStatus.OK)
  async beginMfaEnrollment(@Body() body: MfaEnrollmentRequest): Promise<MfaEnrollmentStart> {
    if (!body?.enrollmentTicket) throw new BadRequestException('enrollmentTicket is required');
    const started = await this.auth.sessions.beginEnrollment(body.enrollmentTicket);
    if (!started) throw new UnauthorizedException('Invalid or expired enrollment ticket');
    return { secret: started.secret, otpauthUri: started.otpauthUri };
  }

  @Public()
  @Post('auth/mfa/enroll/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmMfaEnrollment(
    @Body() body: MfaEnrollmentConfirmRequest,
  ): Promise<MfaEnrollmentConfirmed> {
    if (!body?.enrollmentTicket || !body?.code) {
      throw new BadRequestException('enrollmentTicket and code are required');
    }
    const result = await this.auth.sessions.completeEnrollment(
      body.enrollmentTicket,
      body.code,
      body.deviceLabel,
    );
    if (result.status !== 'success') throw new UnauthorizedException('Enrollment failed');

    await this.auth.recordLogin(result.tokens.accessToken);
    return {
      status: 'success',
      tokens: result.tokens,
      recoveryCodes: [...result.recoveryCodes],
    };
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: RefreshRequest): Promise<TokenPair> {
    if (!body?.refreshToken) throw new BadRequestException('refreshToken is required');
    const outcome = await this.auth.sessions.refresh(body.refreshToken);
    if (outcome.status !== 'success') {
      // `reuse_detected` has already revoked the family inside the service. It answers the
      // same 401 as an ordinary invalid token: telling a thief that their theft was noticed
      // only tells them to move faster next time, and the real user's devices are already
      // logged out.
      throw new UnauthorizedException('Invalid or expired credentials');
    }
    return outcome.tokens;
  }

  @Public()
  @Post('auth/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() body: RefreshRequest): Promise<void> {
    if (!body?.refreshToken) throw new BadRequestException('refreshToken is required');
    // Always 204. Someone trying to log out should never be told their token was already
    // dead, and probing here should reveal nothing about which tokens exist.
    await this.auth.sessions.logout(body.refreshToken);
  }

  @Authenticated()
  @Post('auth/logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(): Promise<{ sessionsEnded: number }> {
    const { churchId, userId } = currentTenant();
    if (!userId) throw new UnauthorizedException('No authenticated user');
    const sessionsEnded = await this.auth.sessions.logoutAllDevices(churchId, userId);
    await this.auth.recordLogoutAll(sessionsEnded);
    return { sessionsEnded };
  }

  @Authenticated()
  @Get('me')
  async me(): Promise<CurrentUser> {
    const { userId } = currentTenant();
    if (!userId) throw new UnauthorizedException('No authenticated user');
    const user = await this.auth.currentUser(userId);
    // A valid token for a user who no longer exists. Not 401 — the token is genuine — but
    // there is no profile to return.
    if (!user) throw new NotFoundException('No such user');
    return user;
  }

  /**
   * One place to turn a `SessionResult` into a response, so login and MFA completion
   * cannot drift apart in what they disclose.
   */
  /**
   * Records a sign-in after the response shape is settled, so an audit failure cannot turn
   * a successful login into an error the user sees. The entry and the token are not atomic
   * here — they cannot be, since the tokens are issued before the tenant is known — which
   * is exactly why this is the one audit call in the codebase that is not inside the
   * transaction doing the work.
   */
  private async auditLogin(result: LoginResult): Promise<void> {
    if (result.status !== 'success') return;
    await this.auth.recordLogin(result.tokens.accessToken);
  }

  private presentSession(result: SessionResult, reply: FastifyReply): LoginResult {
    switch (result.status) {
      case 'success':
        return { status: 'success', tokens: result.tokens };
      case 'mfa_required':
        return {
          status: 'mfa_required',
          challenge: result.challenge,
          expiresInSeconds: MFA_CHALLENGE_TTL_SECONDS,
        };
      case 'mfa_enrollment_required':
        return {
          status: 'mfa_enrollment_required',
          enrollmentTicket: result.enrollmentTicket,
          expiresInSeconds: ENROLLMENT_TICKET_TTL_SECONDS,
        };
      case 'locked': {
        // Round up: a Retry-After of 0 invites an immediate retry that will also fail.
        const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        void reply.header('Retry-After', String(seconds));
        throw new LockedOutException(seconds);
      }
      case 'invalid':
      case 'disabled':
        // Deliberately identical. Separating them would let anyone test whether an address
        // has an account here; the difference is in the log, where it is useful and not
        // reachable by a stranger.
        throw new UnauthorizedException('Invalid credentials');
    }
  }
}

/**
 * 429, which the error filter already maps to RATE_LIMITED.
 *
 * A lockout is rate limiting, not a malformed request: the caller should back off and
 * retry, which is exactly what 429 plus `Retry-After` tells every HTTP client in existence.
 */
export class LockedOutException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super('Too many failed attempts. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
  }
}
