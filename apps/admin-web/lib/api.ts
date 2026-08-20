// Server-side calls to the platform API.
//
// Only ever imported from server components and route handlers. If this module is reached
// from a client component the token would have to travel to the browser to be useful,
// which is the thing the whole design exists to prevent.

import { API_BASE_URL } from './config';
import { readAccessToken, readRefreshToken, setSession, clearSession } from './session';

export interface ApiResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
}

async function send(
  path: string,
  init: { method: string; body?: unknown; token?: string | undefined },
): Promise<ApiResponse> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: init.method,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    cache: 'no-store',
  });

  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

/** An unauthenticated call: login, MFA, enrollment. No token, no refresh. */
export async function callPublic(
  path: string,
  method: string,
  body?: unknown,
): Promise<ApiResponse> {
  return send(path, { method, ...(body === undefined ? {} : { body }) });
}

/**
 * An authenticated call, refreshing once if the access token has expired.
 *
 * Exactly one attempt, deliberately. REV-001 made a second concurrent presentation of a
 * refresh token revoke the entire family — correctly, since that is what a stolen token
 * looks like — so a retry loop here would log the user out of every device they own while
 * appearing to be resilience.
 */
export async function callAuthed(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<ApiResponse> {
  const token = await readAccessToken();
  const first = await send(path, { method, token, ...(body === undefined ? {} : { body }) });
  if (first.status !== 401) return first;

  const refreshToken = await readRefreshToken();
  if (!refreshToken) {
    await clearSession();
    return first;
  }

  const refreshed = await callPublic('/auth/refresh', 'POST', { refreshToken });
  if (refreshed.status !== 200) {
    // The family is gone — either it expired, or reuse was detected and everything was
    // revoked. Either way this browser has nothing valid left to present.
    await clearSession();
    return first;
  }

  const tokens = refreshed.body as { accessToken: string; refreshToken: string };
  await setSession(tokens);
  return send(path, {
    method,
    token: tokens.accessToken,
    ...(body === undefined ? {} : { body }),
  });
}
