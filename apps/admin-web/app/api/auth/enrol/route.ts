// Enrollment, for a privileged account that cannot sign in without a second factor.
//
// GET starts it and returns the secret to display. POST confirms it and opens the session
// login withheld — the ticket proved the password and the code proves the device, so
// there is nothing further to establish by making them sign in again.

import { NextResponse } from 'next/server';
import type { MfaEnrollmentConfirmed, MfaEnrollmentStart } from '@church/contracts';
import { callPublic } from '../../../../lib/api';
import { readEnrollmentTicket, setSession } from '../../../../lib/session';

const expired = () =>
  NextResponse.json({ error: 'That sign-in expired. Start again.' }, { status: 440 });

export async function GET(): Promise<NextResponse> {
  const enrollmentTicket = await readEnrollmentTicket();
  if (!enrollmentTicket) return expired();

  const response = await callPublic('/auth/mfa/enroll', 'POST', { enrollmentTicket });
  if (response.status !== 200) return expired();

  // The secret and its URI do reach the browser, which they must — the user has to get one
  // into an authenticator app. Neither is a session and neither opens anything alone.
  const started = response.body as MfaEnrollmentStart;
  return NextResponse.json({ secret: started.secret, otpauthUri: started.otpauthUri });
}

export async function POST(request: Request): Promise<NextResponse> {
  const { code } = (await request.json()) as { code?: string };
  if (!code) return NextResponse.json({ error: 'Enter the code from your app' }, { status: 400 });

  const enrollmentTicket = await readEnrollmentTicket();
  if (!enrollmentTicket) return expired();

  const response = await callPublic('/auth/mfa/enroll/confirm', 'POST', {
    enrollmentTicket,
    code,
    deviceLabel: 'Admin web',
  });
  if (response.status !== 200) {
    return NextResponse.json({ error: 'That code was not accepted.' }, { status: 401 });
  }

  const confirmed = response.body as MfaEnrollmentConfirmed;
  await setSession(confirmed.tokens);
  // Recovery codes are shown exactly once and cannot be retrieved afterwards, so they go
  // back to the page that displays them — and that page makes the user acknowledge them
  // before it moves on.
  return NextResponse.json({ recoveryCodes: confirmed.recoveryCodes });
}
