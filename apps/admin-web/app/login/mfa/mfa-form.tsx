'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Input } from '@church/ui';
import { AuthForm, post } from '../../../components/auth-form';

export function MfaForm() {
  const router = useRouter();
  const [code, setCode] = useState('');

  return (
    <AuthForm
      title="Enter your code"
      intro={<p>Open your authenticator app and enter the six-digit code, or a recovery code.</p>}
      submitLabel="Sign in"
      onSubmit={async () => {
        const { ok, data } = await post('/api/auth/mfa', { code: code.trim() });
        if (!ok) {
          // 440 means the challenge cookie is gone or expired; there is nothing to retry
          // on this page, so send them back rather than letting them type into a dead form.
          if (data.expired) router.push('/login');
          return (data.error as string) ?? 'That code was not accepted.';
        }
        router.push((data.next as string) ?? '/');
        return undefined;
      }}
    >
      <label htmlFor="code">Code</label>
      <Input
        id="code"
        name="code"
        // Not type="number": a leading zero matters and a spinner on a TOTP code is absurd.
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        required
        value={code}
        onChange={(event) => setCode(event.target.value)}
      />
    </AuthForm>
  );
}
