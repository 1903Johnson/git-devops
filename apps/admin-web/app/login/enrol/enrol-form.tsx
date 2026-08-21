'use client';

// Enrollment for an account that cannot sign in without a second factor.
//
// Three states, in order: fetching the secret, confirming a code, and showing the recovery
// codes. The last one is the reason this file is longer than the other two forms — those
// codes are generated once and are not retrievable afterwards, so a screen that lets
// someone click past them without noticing produces locked-out administrators weeks later,
// when nobody connects the two events.

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, Card, Input } from '@church/ui';
import { AuthForm, post } from '../../../components/auth-form';

interface Started {
  secret: string;
  otpauthUri: string;
}

export function EnrolForm() {
  const router = useRouter();
  const [started, setStarted] = useState<Started>();
  const [failed, setFailed] = useState<string>();
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const response = await fetch('/api/auth/enrol');
      const data = (await response.json()) as Record<string, unknown>;
      if (!live) return;
      if (!response.ok) {
        setFailed((data.error as string) ?? 'Could not start enrollment.');
        return;
      }
      setStarted({ secret: data.secret as string, otpauthUri: data.otpauthUri as string });
    })();
    return () => {
      live = false;
    };
  }, []);

  if (recoveryCodes) {
    return (
      <Card>
        <h1>Save your recovery codes</h1>
        <p>
          These are shown once and cannot be retrieved later. Each works a single time, and they are
          the only way back in if you lose your phone.
        </p>
        <ul aria-label="Recovery codes">
          {recoveryCodes.map((recoveryCode) => (
            <li key={recoveryCode}>
              <code>{recoveryCode}</code>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(recoveryCodes.join('\n'));
          }}
        >
          Copy all
        </Button>
        <label htmlFor="acknowledge">
          <input
            id="acknowledge"
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I have saved these somewhere safe
        </label>
        {/* Disabled until acknowledged. The session already exists at this point, so the
            only thing standing between the user and losing these codes is this checkbox. */}
        <Button type="button" disabled={!acknowledged} onClick={() => router.push('/')}>
          Continue
        </Button>
      </Card>
    );
  }

  if (failed) {
    return (
      <Card>
        <h1>Enrollment could not start</h1>
        <p role="alert">{failed}</p>
        <Button type="button" onClick={() => router.push('/login')}>
          Back to sign in
        </Button>
      </Card>
    );
  }

  if (!started) {
    return (
      <Card>
        <p>Preparing your second factor…</p>
      </Card>
    );
  }

  return (
    <AuthForm
      title="Set up two-factor authentication"
      intro={
        <>
          <p>
            Your role requires a second factor. Add this account to an authenticator app, then enter
            the code it shows.
          </p>
          <p>
            Setup key: <code>{started.secret}</code>
          </p>
          <p>
            <a href={started.otpauthUri}>Open in an authenticator app</a>
          </p>
        </>
      }
      submitLabel="Confirm"
      onSubmit={async () => {
        const { ok, data } = await post('/api/auth/enrol', { code: code.trim() });
        if (!ok) return (data.error as string) ?? 'That code was not accepted.';
        setRecoveryCodes(data.recoveryCodes as string[]);
        return undefined;
      }}
    >
      <label htmlFor="code">Code from your app</label>
      <Input
        id="code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        value={code}
        onChange={(event) => setCode(event.target.value)}
      />
    </AuthForm>
  );
}
