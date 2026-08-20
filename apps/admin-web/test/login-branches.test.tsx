// Which way the browser goes after a sign-in attempt.
//
// The route handler decides the branch and the form obeys it — deliberately, so that the
// client never has to inspect a credential to work out what happened. These tests pin that
// contract from the browser's side: given each of the three outcomes the server can
// return, the user ends up in the right place.
//
// The three outcomes are not hypothetical. After REV-004 a STAFF, PASTOR, CAMPUS_ADMIN or
// CHURCH_ADMIN account that has never enrolled *cannot* reach a session by any other path,
// so a shell that handled only the first two would be unusable by exactly the people it is
// for.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '../app/login/login-form';

const pushed: string[] = [];
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (path: string) => {
      pushed.push(path);
    },
  }),
}));

function answerWith(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

async function signIn() {
  const user = userEvent.setup();
  render(<LoginForm />);
  await user.type(screen.getByLabelText('Email'), 'pastor@example.org');
  await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

afterEach(() => {
  cleanup();
  pushed.length = 0;
  vi.unstubAllGlobals();
});

describe('after a sign-in attempt', () => {
  it('goes to the app when the password was enough', async () => {
    answerWith(200, { next: '/' });
    await signIn();
    await waitFor(() => expect(pushed).toEqual(['/']));
  });

  it('goes to the code step when a second factor is owed', async () => {
    answerWith(200, { next: '/login/mfa' });
    await signIn();
    await waitFor(() => expect(pushed).toEqual(['/login/mfa']));
  });

  it('goes to enrollment when the role requires a factor the account has never set up', async () => {
    answerWith(200, { next: '/login/enrol' });
    await signIn();
    await waitFor(() => expect(pushed).toEqual(['/login/enrol']));
  });

  it('shows the failure and stays put when the details are wrong', async () => {
    answerWith(401, { error: 'Those details were not recognised.' });
    await signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent('not recognised');
    expect(pushed).toEqual([]);
  });

  it('reports a server it could not reach, rather than failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );
    await signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
  });
});
