// Sign-in, server-side.
//
// The browser posts here rather than to the platform API, so tokens land in httpOnly
// cookies without ever passing through JavaScript. What goes back to the client is the
// branch to take — never a credential.

import { NextResponse } from 'next/server';
import type { LoginResult } from '@church/contracts';
import { callPublic } from '../../../../lib/api';
import { setChallenge, setEnrollmentTicket, setSession } from '../../../../lib/session';

export async function POST(request: Request): Promise<NextResponse> {
  const { email, password } = (await request.json()) as { email?: string; password?: string };
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
  }

  const response = await callPublic('/auth/login', 'POST', {
    email,
    password,
    deviceLabel: 'Admin web',
  });

  if (response.status === 423) {
    const body = response.body as { retryAfterSeconds?: number };
    return NextResponse.json(
      { error: 'Too many attempts. Try again shortly.', retryAfterSeconds: body.retryAfterSeconds },
      { status: 423 },
    );
  }
  if (response.status !== 200) {
    // The API deliberately answers identically for a wrong password, an unknown address
    // and a disabled account. Restating the reason here would be the place that leaks the
    // difference back.
    return NextResponse.json({ error: 'Those details were not recognised.' }, { status: 401 });
  }

  const result = response.body as LoginResult;

  switch (result.status) {
    case 'success':
      await setSession(result.tokens);
      return NextResponse.json({ next: '/' });

    case 'mfa_required':
      await setChallenge(result.challenge);
      return NextResponse.json({ next: '/login/mfa' });

    case 'mfa_enrollment_required':
      // A privileged account that has never set up a second factor (REV-004). It is not
      // being refused — it is being sent to the only route its ticket opens.
      await setEnrollmentTicket(result.enrollmentTicket);
      return NextResponse.json({ next: '/login/enrol' });

    default:
      return NextResponse.json({ error: 'Unexpected response from the server.' }, { status: 502 });
  }
}
