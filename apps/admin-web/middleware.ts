// Deny by default, matching the API's own posture.
//
// Everything requires a session except an explicit list of entry points. Written this way
// round on purpose: a middleware that enumerates *protected* routes silently exposes every
// page added after it, and the page that gets added after it is always the interesting one.
//
// This is a convenience, not a control. It only checks that a cookie is present — it does
// not verify the token, and it cannot: the signing keys live on the API. Every route
// underneath still authenticates for real, server-side. The point here is to send a signed
// -out user to the login screen instead of showing them a broken page.

import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './lib/session';

/** Reachable without a session. Everything else is not. */
const PUBLIC_PATHS = ['/login'];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  // Either cookie is enough to be worth trying: an expired access token with a live refresh
  // token is an ordinary state, and callAuthed() will handle it. Redirecting on the access
  // cookie alone would sign people out every fifteen minutes.
  const hasSession = request.cookies.has(ACCESS_COOKIE) || request.cookies.has(REFRESH_COOKIE);
  if (hasSession) return NextResponse.next();

  const login = new URL('/login', request.url);
  return NextResponse.redirect(login);
}

export const config = {
  // Static assets and the app's own auth routes are excluded: the auth routes are how a
  // signed-out user gets a session in the first place, so guarding them would be a loop.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth).*)'],
};
