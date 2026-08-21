// Session cookies, in one file.
//
// The browser never holds a token. Every credential this app receives goes straight into
// an httpOnly cookie and is read back only on the server — so a script injected into any
// page of this app cannot read the refresh token, and therefore cannot mint itself a
// durable session out of a momentary XSS. That is the whole reason the proxy in
// app/api/auth exists rather than the browser calling the API directly.
//
// The flags live here and nowhere else. Spread across call sites, `httpOnly` eventually
// gets omitted from one of them by someone debugging, and nothing fails visibly.

import { cookies } from 'next/headers';

export const ACCESS_COOKIE = 'church_access';
export const REFRESH_COOKIE = 'church_refresh';
/** Carries the half-authenticated state between the login screen and the second step. */
export const CHALLENGE_COOKIE = 'church_mfa_challenge';
export const ENROLLMENT_COOKIE = 'church_mfa_enrollment';

/** Access tokens live 15 minutes; the cookie outlives one so a refresh can be attempted. */
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;
/** A challenge is worth five minutes and an enrollment ticket fifteen (see jwt.ts). */
const CHALLENGE_MAX_AGE = 5 * 60;
const ENROLLMENT_MAX_AGE = 15 * 60;

interface CookieFlags {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge?: number;
}

function flags(maxAge?: number): CookieFlags {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // Off in development only, because localhost is not https and the cookie would
    // otherwise be dropped silently — which looks exactly like a broken login.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

export interface TokenPairLike {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export async function setSession(tokens: TokenPairLike): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, tokens.accessToken, flags());
  jar.set(REFRESH_COOKIE, tokens.refreshToken, flags(REFRESH_MAX_AGE));
  // A completed sign-in ends the half-authenticated state, whichever way it got here.
  jar.delete(CHALLENGE_COOKIE);
  jar.delete(ENROLLMENT_COOKIE);
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, CHALLENGE_COOKIE, ENROLLMENT_COOKIE]) {
    jar.delete(name);
  }
}

export async function readAccessToken(): Promise<string | undefined> {
  return (await cookies()).get(ACCESS_COOKIE)?.value;
}

export async function readRefreshToken(): Promise<string | undefined> {
  return (await cookies()).get(REFRESH_COOKIE)?.value;
}

export async function setChallenge(challenge: string): Promise<void> {
  (await cookies()).set(CHALLENGE_COOKIE, challenge, flags(CHALLENGE_MAX_AGE));
}

export async function readChallenge(): Promise<string | undefined> {
  return (await cookies()).get(CHALLENGE_COOKIE)?.value;
}

export async function setEnrollmentTicket(ticket: string): Promise<void> {
  (await cookies()).set(ENROLLMENT_COOKIE, ticket, flags(ENROLLMENT_MAX_AGE));
}

export async function readEnrollmentTicket(): Promise<string | undefined> {
  return (await cookies()).get(ENROLLMENT_COOKIE)?.value;
}
