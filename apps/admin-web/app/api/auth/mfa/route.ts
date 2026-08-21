import { NextResponse } from 'next/server';
import type { LoginResult } from '@church/contracts';
import { callPublic } from '../../../../lib/api';
import { readChallenge, setSession } from '../../../../lib/session';

export async function POST(request: Request): Promise<NextResponse> {
  const { code } = (await request.json()) as { code?: string };
  if (!code) return NextResponse.json({ error: 'Enter your code' }, { status: 400 });

  // The challenge comes from the cookie, never from the request body: a challenge the page
  // could post is a challenge an attacker could also post.
  const challenge = await readChallenge();
  if (!challenge) {
    return NextResponse.json({ error: 'That sign-in expired. Start again.' }, { status: 440 });
  }

  const response = await callPublic('/auth/mfa', 'POST', { challenge, code });
  const result = response.body as LoginResult;
  if (response.status !== 200 || result.status !== 'success') {
    return NextResponse.json({ error: 'That code was not accepted.' }, { status: 401 });
  }

  await setSession(result.tokens);
  return NextResponse.json({ next: '/' });
}
