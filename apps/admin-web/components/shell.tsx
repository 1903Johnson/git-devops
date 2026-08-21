import type { ReactNode } from 'react';
import { Nav } from './nav';
import { SignOutButton } from './sign-out-button';

interface ShellProps {
  readonly email: string;
  readonly churchName?: string | undefined;
  readonly children: ReactNode;
}

/** The signed-in frame: who you are, where you can go, and the page itself. */
export function Shell({ email, churchName, children }: ShellProps) {
  return (
    <div>
      <header>
        <strong>{churchName ?? 'Church admin'}</strong>
        <Nav />
        <span>{email}</span>
        <SignOutButton />
      </header>
      <main>{children}</main>
    </div>
  );
}
