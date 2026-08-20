'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Input } from '@church/ui';
import { AuthForm, post } from '../../components/auth-form';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <AuthForm
      title="Sign in"
      submitLabel="Continue"
      onSubmit={async () => {
        const { ok, data } = await post('/api/auth/login', { email, password });
        if (!ok) return (data.error as string) ?? 'Sign-in failed.';
        // Where to go next is the server's decision — it knows which of the three login
        // outcomes came back, and the browser was never told which credential it holds.
        router.push((data.next as string) ?? '/');
        return undefined;
      }}
    >
      <label htmlFor="email">Email</label>
      <Input
        id="email"
        name="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <label htmlFor="password">Password</label>
      <Input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
    </AuthForm>
  );
}
