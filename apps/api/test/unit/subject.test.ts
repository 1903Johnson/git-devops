import { describe, expect, it } from 'vitest';
import { toSubject } from '../../src/common/auth.guard.js';

describe('token claims to policy subject', () => {
  it('carries the identifying claims across', () => {
    const subject = toSubject({
      sub: 'user-1',
      church_id: 'church-1',
      roles: ['STAFF'],
      campus_id: 'campus-1',
    });
    expect(subject).toEqual({
      userId: 'user-1',
      churchId: 'church-1',
      roles: ['STAFF'],
      campusId: 'campus-1',
    });
  });

  it('drops a role the registry does not know', () => {
    // A token is signed data, not trusted data — it may come from an older deploy that
    // knew a role this one removed. Dropping can only reduce privilege, which is the
    // direction an unknown value must fail in.
    const subject = toSubject({ sub: 'u', church_id: 'c', roles: ['STAFF', 'SUPERADMIN'] });
    expect(subject.roles).toEqual(['STAFF']);
  });

  it('leaves personId unset, so self-access denies until CORE-017 resolves it', () => {
    // Pinning current behaviour rather than endorsing it: person:read_self cannot work
    // until the guard looks up app_user.person_id. When that lands this test changes, and
    // the change is visible in review instead of silent.
    expect(toSubject({ sub: 'u', church_id: 'c', roles: ['MEMBER'] }).personId).toBeUndefined();
  });
});
