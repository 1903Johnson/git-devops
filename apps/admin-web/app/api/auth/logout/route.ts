import { NextResponse } from 'next/server';
import { callPublic } from '../../../../lib/api';
import { clearSession, readRefreshToken } from '../../../../lib/session';

export async function POST(): Promise<NextResponse> {
  const refreshToken = await readRefreshToken();
  // Tell the API first, so the family is revoked server-side. Clearing only the cookies
  // would leave a live refresh token behind for whoever else holds a copy of it.
  if (refreshToken) await callPublic('/auth/logout', 'POST', { refreshToken });
  await clearSession();
  return NextResponse.json({ next: '/login' });
}
