import { beforeEach, describe, expect, it } from 'vitest';
import {
  CORE_PERMISSIONS as P,
  ForbiddenError,
  ROLES,
  ROLE_PERMISSIONS,
  assertCan,
  can,
  permissionsFor,
  registerPermissions,
  resetRegisteredPermissions,
  type Resource,
  type Role,
  type Subject,
} from '../src/index.js';

const CHURCH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHURCH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAMPUS_1 = 'c1111111-1111-4111-8111-111111111111';
const CAMPUS_2 = 'c2222222-2222-4222-8222-222222222222';

const subject = (roles: Role[], extra: Partial<Subject> = {}): Subject => ({
  userId: 'u1',
  churchId: CHURCH_A,
  roles,
  ...extra,
});

const resource = (extra: Partial<Resource> = {}): Resource => ({
  type: 'person',
  churchId: CHURCH_A,
  ...extra,
});

beforeEach(() => resetRegisteredPermissions());

describe('deny by default', () => {
  it('denies a permission no role grants', () => {
    const decision = can(subject(['MEMBER']), P.billing_manage);
    expect(decision).toEqual({
      allowed: false,
      rule: 'missing_permission',
      detail: 'billing:manage',
    });
  });

  it('denies a subject with no roles at all', () => {
    expect(can(subject([]), P.person_read).allowed).toBe(false);
  });

  it('denies an unknown permission string rather than falling through', () => {
    expect(can(subject(['CHURCH_ADMIN']), 'nonsense:action').allowed).toBe(false);
  });
});

describe('tenancy', () => {
  it('denies a resource belonging to another church, whatever the role', () => {
    // Checked before permissions so the denial reports the boundary rather than the role,
    // and never reveals whether the permission exists.
    const decision = can(
      subject(['CHURCH_ADMIN']),
      P.person_read,
      resource({ churchId: CHURCH_B }),
    );
    expect(decision).toEqual({ allowed: false, rule: 'cross_tenant' });
  });

  it('ranks tenancy above every other rule', () => {
    const decision = can(
      subject(['MEMBER'], { personId: 'p1' }),
      P.person_read,
      resource({ churchId: CHURCH_B, personId: 'p1' }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ rule: 'cross_tenant' });
  });
});

describe('self access', () => {
  it('lets a member read their own record without a broad permission', () => {
    const decision = can(
      subject(['MEMBER'], { personId: 'p1' }),
      P.person_read,
      resource({ personId: 'p1' }),
    );
    expect(decision).toEqual({ allowed: true, rule: 'self_access' });
  });

  it('does not let a member read someone else', () => {
    const decision = can(
      subject(['MEMBER'], { personId: 'p1' }),
      P.person_read,
      resource({ personId: 'p2' }),
    );
    expect(decision).toMatchObject({ allowed: false, rule: 'missing_permission' });
  });

  it('does not extend self access to unrelated permissions', () => {
    const decision = can(
      subject(['MEMBER'], { personId: 'p1' }),
      P.user_manage,
      resource({ personId: 'p1' }),
    );
    expect(decision.allowed).toBe(false);
  });
});

describe('campus scoping', () => {
  it('lets a campus admin act on their own campus', () => {
    const decision = can(
      subject(['CAMPUS_ADMIN'], { campusId: CAMPUS_1 }),
      P.person_manage,
      resource({ campusId: CAMPUS_1 }),
    );
    expect(decision).toEqual({ allowed: true, rule: 'role_permission' });
  });

  it('stops a campus admin reaching another campus', () => {
    // campus_id is a scoping filter, never an isolation boundary, so RLS will not catch
    // this — the engine is the only thing standing in the way.
    const decision = can(
      subject(['CAMPUS_ADMIN'], { campusId: CAMPUS_1 }),
      P.person_manage,
      resource({ campusId: CAMPUS_2 }),
    );
    expect(decision).toEqual({ allowed: false, rule: 'campus_scope', detail: CAMPUS_2 });
  });

  it('does not confine a church admin to a campus', () => {
    const decision = can(
      subject(['CHURCH_ADMIN'], { campusId: CAMPUS_1 }),
      P.person_manage,
      resource({ campusId: CAMPUS_2 }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('does not confine someone who also holds a church-wide role', () => {
    const decision = can(
      subject(['CAMPUS_ADMIN', 'PASTOR'], { campusId: CAMPUS_1 }),
      P.person_manage,
      resource({ campusId: CAMPUS_2 }),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('group leadership', () => {
  it('lets a leader manage a group they lead', () => {
    const decision = can(
      subject(['GROUP_LEADER'], { ledGroupIds: ['g1'] }),
      P.group_manage,
      resource({ type: 'group', groupId: 'g1' }),
    );
    expect(decision).toEqual({ allowed: true, rule: 'role_permission' });
  });

  it('stops a leader managing a group they do not lead', () => {
    // The case docs/01 §2.5 calls out: the permission is real, its reach is not global.
    const decision = can(
      subject(['GROUP_LEADER'], { ledGroupIds: ['g1'] }),
      P.group_manage,
      resource({ type: 'group', groupId: 'g2' }),
    );
    expect(decision).toEqual({ allowed: false, rule: 'not_group_leader', detail: 'g2' });
  });

  it('lets staff manage any group', () => {
    const decision = can(
      subject(['STAFF']),
      P.group_manage,
      resource({ type: 'group', groupId: 'g2' }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('denies a leader with no groups recorded', () => {
    const decision = can(
      subject(['GROUP_LEADER']),
      P.group_manage,
      resource({ type: 'group', groupId: 'g1' }),
    );
    expect(decision).toMatchObject({ allowed: false, rule: 'not_group_leader' });
  });
});

describe('restricted sensitivity', () => {
  beforeEach(() => registerPermissions(['pastoral_care:read', 'pastoral_care:read_restricted']));

  it('denies restricted data to a broad permission', () => {
    // A pastoral case marked restricted must not open to whoever holds general read.
    const decision = can(
      { ...subject(['STAFF']), roles: ['STAFF'] },
      'person:read',
      resource({ sensitivity: 'restricted' }),
    );
    expect(decision).toEqual({
      allowed: false,
      rule: 'restricted_sensitivity',
      detail: 'person:read_restricted',
    });
  });

  it('allows standard data to the same permission', () => {
    const decision = can(subject(['STAFF']), 'person:read', resource({ sensitivity: 'standard' }));
    expect(decision.allowed).toBe(true);
  });
});

describe('assertCan', () => {
  it('returns quietly when allowed', () => {
    expect(() => assertCan(subject(['CHURCH_ADMIN']), P.church_manage)).not.toThrow();
  });

  it('throws with the rule that denied it', () => {
    try {
      assertCan(subject(['MEMBER']), P.billing_manage);
      expect.unreachable('should have thrown');
    } catch (error) {
      const forbidden = error as ForbiddenError;
      expect(forbidden).toBeInstanceOf(ForbiddenError);
      expect(forbidden.permission).toBe('billing:manage');
      expect(forbidden.decision.rule).toBe('missing_permission');
    }
  });
});

describe('role definitions', () => {
  it('gives every role a definition', () => {
    for (const role of ROLES) expect(ROLE_PERMISSIONS[role]).toBeDefined();
  });

  it('never lets a member reach another person, giving, or audit data', () => {
    // A regression here is the whole product's confidentiality promise, so it is asserted
    // rather than left to the shape of the arrays above.
    const member = permissionsFor(['MEMBER']);
    for (const forbidden of [
      P.person_read,
      P.person_manage,
      P.audit_read,
      P.billing_manage,
      P.user_manage,
    ]) {
      expect(member.has(forbidden)).toBe(false);
    }
  });

  it('escalates monotonically from volunteer to church admin', () => {
    const chain: Role[] = [
      'MEMBER',
      'VOLUNTEER',
      'GROUP_LEADER',
      'STAFF',
      'CAMPUS_ADMIN',
      'CHURCH_ADMIN',
    ];
    for (let i = 1; i < chain.length; i += 1) {
      const lower = permissionsFor([chain[i - 1]!]);
      const higher = permissionsFor([chain[i]!]);
      for (const permission of lower) {
        expect(higher.has(permission)).toBe(true);
      }
    }
  });

  it('reserves billing, audit, and module control for church admins', () => {
    for (const role of ROLES) {
      const held = permissionsFor([role]);
      const privileged = [P.billing_manage, P.audit_read, P.module_manage].some((p) => held.has(p));
      if (privileged) expect(role).toBe('CHURCH_ADMIN');
    }
  });

  it('unions permissions across multiple roles', () => {
    const both = permissionsFor(['MEMBER', 'CHURCH_ADMIN']);
    expect(both.has(P.person_read_self)).toBe(true);
    expect(both.has(P.billing_manage)).toBe(true);
  });
});

describe('permission registration', () => {
  it('accepts well-formed module permissions', () => {
    registerPermissions(['children_checkin:view_medical']);
    expect(can(subject(['CHURCH_ADMIN']), 'children_checkin:view_medical').allowed).toBe(false);
  });

  it('rejects a malformed permission at registration rather than at request time', () => {
    // A typo that only surfaces as a silent denial in production is the same bug wearing
    // a disguise.
    for (const bad of ['NoColon', 'two:colons:here', 'Upper:case', ':missing', 'trailing:']) {
      expect(() => registerPermissions([bad as never])).toThrow(TypeError);
    }
  });
});
