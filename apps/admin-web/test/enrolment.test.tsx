// Enrollment, and the recovery codes at the end of it.
//
// The codes are generated once and are not retrievable afterwards. A screen that lets
// someone click past them without noticing does not fail here — it fails weeks later, as a
// locked-out administrator nobody can help, and by then nothing connects the two events.
// So the acknowledgement is a tested property rather than a courtesy.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnrolForm } from '../app/login/enrol/enrol-form';

const pushed: string[] = [];
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (path: string) => {
      pushed.push(path);
    },
  }),
}));

/** GET starts enrollment; POST confirms it. One stub answers both, by method. */
function apiAnswers(options: {
  start?: { status: number; body: unknown };
  confirm?: { status: number; body: unknown };
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string }) => {
      const answer =
        init?.method === 'POST'
          ? (options.confirm ?? { status: 500, body: {} })
          : (options.start ?? { status: 500, body: {} });
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }),
  );
}

afterEach(() => {
  cleanup();
  pushed.length = 0;
  vi.unstubAllGlobals();
});

describe('setting up a second factor', () => {
  it('shows the setup key so it can be typed in by hand', async () => {
    // No QR yet (WEB-020), so the key has to be readable — an authenticator app that
    // cannot be pointed at a camera still has to be usable.
    apiAnswers({
      start: { status: 200, body: { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x' } },
    });
    render(<EnrolForm />);
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
  });

  it('will not let the user continue until they acknowledge the recovery codes', async () => {
    const user = userEvent.setup();
    apiAnswers({
      start: { status: 200, body: { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x' } },
      confirm: { status: 200, body: { recoveryCodes: ['AAAA-BBBB', 'CCCC-DDDD'] } },
    });
    render(<EnrolForm />);

    await user.type(await screen.findByLabelText('Code from your app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    const codes = await screen.findByLabelText('Recovery codes');
    expect(codes).toHaveTextContent('AAAA-BBBB');

    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    await user.click(continueButton);
    expect(pushed).toEqual([]);

    await user.click(screen.getByLabelText('I have saved these somewhere safe'));
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);
    await waitFor(() => expect(pushed).toEqual(['/']));
  });

  it('keeps the user on the page when the code is refused', async () => {
    const user = userEvent.setup();
    apiAnswers({
      start: { status: 200, body: { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x' } },
      confirm: { status: 401, body: { error: 'That code was not accepted.' } },
    });
    render(<EnrolForm />);
    await user.type(await screen.findByLabelText('Code from your app'), '000000');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not accepted');
    expect(screen.queryByLabelText('Recovery codes')).not.toBeInTheDocument();
  });

  it('sends the user back when the ticket has expired', async () => {
    apiAnswers({ start: { status: 440, body: { error: 'That sign-in expired. Start again.' } } });
    render(<EnrolForm />);
    const back = await screen.findByRole('button', { name: 'Back to sign in' });
    await userEvent.setup().click(back);
    await waitFor(() => expect(pushed).toEqual(['/login']));
  });
});
