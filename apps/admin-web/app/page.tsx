import { redirect } from 'next/navigation';
import { readAccessToken } from '../lib/session';

/**
 * A placeholder landing page, replaced by the dashboard in WEB-010b.
 *
 * It exists now because the auth flow has to land somewhere: without it every successful
 * sign-in would end on a 404 and the three branches could not be walked end to end.
 */
export default async function HomePage() {
  if (!(await readAccessToken())) redirect('/login');
  return (
    <main>
      <h1>Signed in</h1>
      <p>The shell, navigation and dashboard arrive in WEB-010b.</p>
    </main>
  );
}
