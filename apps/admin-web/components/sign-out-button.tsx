'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@church/ui';

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        // The route revokes the family server-side before clearing the cookies. Dropping
        // the cookies alone would leave a live refresh token for anyone holding a copy.
        await fetch('/api/auth/logout', { method: 'POST' });
        router.push('/login');
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
