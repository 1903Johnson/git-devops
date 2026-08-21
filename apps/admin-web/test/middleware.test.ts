// Routing for a signed-out visitor.
//
// The middleware denies by default: a page added tomorrow is protected without anyone
// remembering to protect it. These tests pin that direction, because the failure mode of
// getting it backwards is silent — a new page is simply public, and nothing says so.

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../lib/session';

function request(path: string, cookies: Record<string, string> = {}): NextRequest {
  const req = new NextRequest(new URL(path, 'https://admin.example.org'));
  for (const [name, value] of Object.entries(cookies)) req.cookies.set(name, value);
  return req;
}

const redirectedTo = (response: Response): string | null =>
  response.headers.get('location') && new URL(response.headers.get('location')!).pathname;

describe('a visitor with no session', () => {
  it('is sent to the login screen', () => {
    expect(redirectedTo(middleware(request('/')))).toBe('/login');
  });

  it('is sent there from a page nobody has written yet', () => {
    // The point of denying by default: this passes for routes that do not exist, so it
    // keeps passing for the ones added later.
    expect(redirectedTo(middleware(request('/people/some-id')))).toBe('/login');
    expect(redirectedTo(middleware(request('/giving/reports')))).toBe('/login');
  });

  it('can still reach the login screen and its steps', () => {
    for (const path of ['/login', '/login/mfa', '/login/enrol']) {
      expect(redirectedTo(middleware(request(path)))).toBeNull();
    }
  });
});

describe('a visitor with a session', () => {
  it('is let through', () => {
    expect(redirectedTo(middleware(request('/', { [ACCESS_COOKIE]: 'token' })))).toBeNull();
  });

  it('is let through on a refresh token alone', () => {
    // An expired access token with a live refresh token is the ordinary state fifteen
    // minutes into any session. Redirecting here would sign everyone out on the quarter
    // hour, and it would look like a token bug rather than a routing one.
    expect(redirectedTo(middleware(request('/', { [REFRESH_COOKIE]: 'token' })))).toBeNull();
  });
});
