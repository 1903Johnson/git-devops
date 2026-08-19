import { describe, expect, it } from 'vitest';
import { type ModuleManifest, validateManifest, validateRegistry } from '../../src/index.js';

const base: ModuleManifest = {
  key: 'prayer_wall',
  name: 'Prayer Wall',
  version: '1.0.0',
  minPlan: 'FREE',
  defaultEnabled: true,
  requires: [],
  permissions: ['prayer_wall:read'],
  dataClasses: [{ name: 'request', sensitivity: 'standard', retention: 'P1Y' }],
  purgePolicy: {
    onDisable: 'retain',
    retentionAfterDisable: 'P90D',
    purgeStrategy: 'hard_delete',
    auditPurge: true,
  },
  nav: [{ label: 'Prayer', path: '/prayer', requiresPermission: 'prayer_wall:read' }],
  events: { publishes: ['prayer_wall.posted'], consumes: [] },
};

const withChange = (change: Partial<ModuleManifest>): ModuleManifest => ({ ...base, ...change });
const fields = (manifest: ModuleManifest) => validateManifest(manifest).map((p) => p.field);

describe('a well-formed manifest', () => {
  it('has no problems', () => {
    expect(validateManifest(base)).toEqual([]);
  });
});

describe('key', () => {
  it('rejects anything that is not snake_case', () => {
    // The key is the mod_<key>_ table prefix. A hyphen here produces table names the purge
    // path will never match, and the data would silently outlive the module.
    for (const key of ['prayer-wall', 'PrayerWall', '1prayer', '']) {
      expect(fields(withChange({ key }))).toContain('key');
    }
  });
});

describe('permissions', () => {
  it('requires the module key as a namespace', () => {
    // Two modules both declaring "read" would collide in one open registry, and a
    // collision means one module's role granting access to another's data.
    expect(fields(withChange({ permissions: ['read'] }))).toContain('permissions');
    expect(fields(withChange({ permissions: ['giving:manage'] }))).toContain('permissions');
  });
});

describe('data classes and purge policy', () => {
  it('insists on at least one data class', () => {
    expect(fields(withChange({ dataClasses: [] }))).toContain('dataClasses');
  });

  it('rejects duplicate class names', () => {
    const duplicated = [base.dataClasses[0]!, base.dataClasses[0]!];
    expect(fields(withChange({ dataClasses: duplicated }))).toContain('dataClasses');
  });

  it('refuses a purge policy that destroys data on disable', () => {
    const policy = { ...base.purgePolicy, onDisable: 'delete' as unknown as 'retain' };
    expect(fields(withChange({ purgePolicy: policy }))).toContain('purgePolicy');
  });

  it('rejects a legal hold naming a class that does not exist', () => {
    const policy = { ...base.purgePolicy, legalHoldClasses: ['receipts'] };
    expect(fields(withChange({ purgePolicy: policy }))).toContain('purgePolicy');
  });
});

describe('defaultEnabled', () => {
  it('forbids defaulting to on while holding restricted data', () => {
    // The rule that matters most here. A module holding minors', financial or pastoral
    // data must never arrive switched on — enabling it is a deliberate act by an admin who
    // has seen the consent screen (docs/02 §3).
    const restricted = withChange({
      defaultEnabled: true,
      dataClasses: [{ name: 'medical', sensitivity: 'restricted', retention: 'P1Y' }],
    });
    const problems = validateManifest(restricted);
    expect(problems.map((p) => p.field)).toContain('defaultEnabled');
    expect(problems.find((p) => p.field === 'defaultEnabled')?.problem).toMatch(/medical/);
  });

  it('allows defaulting to on for standard data', () => {
    expect(validateManifest(withChange({ defaultEnabled: true }))).toEqual([]);
  });
});

describe('nav and events', () => {
  it('rejects a nav entry gated on a permission the module never declares', () => {
    const nav = [{ label: 'Ghost', path: '/g', requiresPermission: 'prayer_wall:admin' }];
    expect(fields(withChange({ nav }))).toContain('nav');
  });

  it('requires published events to be namespaced', () => {
    expect(fields(withChange({ events: { publishes: ['posted'], consumes: [] } }))).toContain(
      'events',
    );
  });
});

describe('the registry as a whole', () => {
  it('rejects duplicate keys', () => {
    const problems = validateRegistry([base, { ...base, name: 'Copy' }]);
    expect(problems.some((p) => p.problem.includes('duplicate'))).toBe(true);
  });

  it('rejects a requirement no module provides', () => {
    const orphan = withChange({
      key: 'giving',
      requires: ['nonexistent'],
      permissions: ['giving:read'],
      nav: [],
      events: { publishes: [], consumes: [] },
    });
    const problems = validateRegistry([orphan]);
    expect(problems.some((p) => p.problem.includes('no module provides'))).toBe(true);
  });

  it('rejects a self-requirement', () => {
    expect(fields(withChange({ requires: ['prayer_wall'] }))).toContain('requires');
  });

  it('detects a requirement cycle', () => {
    // Two modules requiring each other can never be enabled: each needs the other on
    // first. The symptom is an admin clicking Enable and nothing happening.
    const a = withChange({
      key: 'a',
      requires: ['b'],
      permissions: ['a:read'],
      nav: [],
      events: { publishes: [], consumes: [] },
    });
    const b = withChange({
      key: 'b',
      requires: ['a'],
      permissions: ['b:read'],
      nav: [],
      events: { publishes: [], consumes: [] },
    });
    const problems = validateRegistry([a, b]);
    expect(problems.some((p) => p.problem.includes('cycle'))).toBe(true);
  });

  it('accepts a legitimate dependency chain', () => {
    const a = withChange({
      key: 'a',
      requires: [],
      permissions: ['a:read'],
      nav: [],
      events: { publishes: [], consumes: [] },
    });
    const b = withChange({
      key: 'b',
      requires: ['a'],
      permissions: ['b:read'],
      nav: [],
      events: { publishes: [], consumes: [] },
    });
    const c = withChange({
      key: 'c',
      requires: ['b'],
      permissions: ['c:read'],
      nav: [],
      events: { publishes: [], consumes: [] },
    });
    expect(validateRegistry([a, b, c])).toEqual([]);
  });
});
