import { redirect } from 'next/navigation';
import type { CurrentUser } from '@church/contracts';
import { Badge, Card } from '@church/ui';
import { callAuthed } from '../lib/api';
import { Shell } from '../components/shell';

/**
 * The dashboard.
 *
 * `/me` is read here on the server, which is the whole shape of this app in one line: the
 * token stays in the cookie, the fetch happens in the server component, and the browser
 * receives rendered HTML rather than a credential it would have to be trusted with.
 */
export default async function HomePage() {
  const response = await callAuthed('/me');
  // callAuthed already tried a refresh. Still 401 means there is no session left to
  // salvage — the middleware will not have caught this case, because a cookie being
  // present is not the same as a cookie being valid.
  if (response.status === 401) redirect('/login');

  const me = response.body as CurrentUser;

  return (
    <Shell email={me.email}>
      <h1>Welcome back</h1>
      <Card>
        <h2>Your access</h2>
        <dl>
          <dt>Church</dt>
          <dd>{me.churchId}</dd>
          <dt>Roles</dt>
          <dd>
            {me.roles.length > 0 ? (
              me.roles.map((role) => <Badge key={role}>{role}</Badge>)
            ) : (
              // A real state, not an error: a registered user with no role assigned yet
              // reaches nothing, and saying so beats an empty box.
              <span>No roles assigned yet. An administrator needs to grant you access.</span>
            )}
          </dd>
          {me.campusId ? (
            <>
              <dt>Campus</dt>
              {/* Present only for a campus-scoped role, and worth showing plainly: it is
                  the boundary of everything this person can see (REV-002). */}
              <dd>{me.campusId}</dd>
            </>
          ) : null}
          <dt>Two-factor</dt>
          <dd>{me.mfaEnrolled ? 'Enrolled' : 'Not enrolled'}</dd>
        </dl>
      </Card>
    </Shell>
  );
}
