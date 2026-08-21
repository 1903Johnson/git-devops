'use client';

// The shared shape of the three auth steps: a card, a heading, an error line, a submit
// that disables itself while in flight. Three near-identical forms drift apart otherwise —
// and the one that drifts is always the one that stops disabling the button, which is how
// a double-click becomes two login attempts against a lockout counter.

import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Card } from '@church/ui';

interface AuthFormProps {
  title: string;
  intro?: ReactNode;
  submitLabel: string;
  children: ReactNode;
  onSubmit: () => Promise<string | undefined>;
}

export function AuthForm({ title, intro, submitLabel, children, onSubmit }: AuthFormProps) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const failure = await onSubmit();
      if (failure) setError(failure);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} noValidate>
        <h1>{title}</h1>
        {intro}
        {children}
        {/* role="alert" so a screen reader announces a failed sign-in rather than leaving
            the user waiting for something that already happened. */}
        {error ? <p role="alert">{error}</p> : null}
        <Button type="submit" disabled={busy}>
          {busy ? 'Working…' : submitLabel}
        </Button>
      </form>
    </Card>
  );
}

/** Posts JSON to one of this app's own routes. Never to the platform API directly. */
export async function post(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as Record<string, unknown>;
  return { ok: response.ok, data };
}
