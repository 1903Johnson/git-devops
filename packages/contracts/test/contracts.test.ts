import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  ModuleNotEnabledError,
  PAGE_SIZE,
  isApiError,
  isModuleNotEnabled,
} from '../src/index.js';

const spec = readFileSync(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8');

describe('error envelope', () => {
  it('exposes every code in the spec as a value', () => {
    // The type alone is not enough: clients compare against string literals, and a typo in
    // one is invisible until it silently fails to match at runtime.
    const body = spec
      .slice(spec.indexOf('          enum:\n            - BAD_REQUEST'))
      .split('\n')
      .slice(1);
    // Stop at the first non-item line. Filtering the whole remainder instead would sweep up
    // every `- ` further down the file — `allOf` entries included — and did.
    const end = body.findIndex((line) => !line.trim().startsWith('- '));
    const inSpec = body.slice(0, end === -1 ? body.length : end).map((line) => line.trim().slice(2));

    expect(Object.keys(API_ERROR_CODES).sort()).toEqual([...inSpec].sort());
  });

  it('recognises a well-formed error and rejects anything else', () => {
    expect(isApiError({ code: 'NOT_FOUND', message: 'gone' })).toBe(true);
    expect(isApiError({ code: 'MADE_UP', message: 'x' })).toBe(false);
    expect(isApiError({ code: 'NOT_FOUND' })).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError('NOT_FOUND')).toBe(false);
  });

  it('identifies a disabled module', () => {
    expect(isModuleNotEnabled({ code: 'MODULE_NOT_ENABLED', message: 'nope' })).toBe(true);
    expect(isModuleNotEnabled({ code: 'NOT_FOUND', message: 'nope' })).toBe(false);
  });

  it('carries the path and request id on ModuleNotEnabledError', () => {
    const error = new ModuleNotEnabledError('/checkin/sessions', 'req_123');
    expect(error.code).toBe('MODULE_NOT_ENABLED');
    expect(error.path).toBe('/checkin/sessions');
    expect(error.requestId).toBe('req_123');
  });
});

describe('spec invariants', () => {
  it('keeps MODULE_NOT_ENABLED a 404 rather than a 403', () => {
    // A 403 would confirm the module exists for a tenant that has not enabled it. This is
    // asserted here because it is a decision that looks like a mistake to a future reader.
    const notFound = spec.slice(spec.indexOf('    NotFound:'));
    expect(notFound).toMatch(/module that is not enabled/);
    expect(spec).not.toMatch(/'403':\s*\{ \$ref: '#\/components\/responses\/ModuleNotEnabled'/);
  });

  it('omits churchId from CampusCreate so a client cannot write into another tenant', () => {
    const createBlock = spec.slice(
      spec.indexOf('    CampusCreate:'),
      spec.indexOf('    CampusUpdate:'),
    );
    expect(createBlock).not.toMatch(/^\s+churchId:/m);
  });

  it('omits status from ChurchUpdate so a church cannot lift its own suspension', () => {
    const updateBlock = spec.slice(spec.indexOf('    ChurchUpdate:'), spec.indexOf('    Campus:'));
    expect(updateBlock).not.toMatch(/^\s+status:/m);
  });

  it('omits churchId from PersonCreate and FamilyCreate for the same reason', () => {
    const person = spec.slice(spec.indexOf('    PersonCreate:'), spec.indexOf('    PersonUpdate:'));
    expect(person).not.toMatch(/^\s+churchId:/m);
    const family = spec.slice(spec.indexOf('    FamilyCreate:'), spec.indexOf('  responses:'));
    expect(family).not.toMatch(/^\s+churchId:/m);
  });

  it('keeps status out of PersonUpdate so every change lands in the history', () => {
    // Status moves only through POST /people/{personId}/status, which appends to
    // membership_status_history in the same transaction. A `status` field here would let a
    // client rewrite someone's standing with no record of who did it — the append-only
    // table would still be append-only and would still be wrong.
    const block = spec.slice(
      spec.indexOf('    PersonUpdate:'),
      spec.indexOf('    MembershipStatusChange:'),
    );
    expect(block).not.toMatch(/^\s+status:/m);
    expect(block).not.toMatch(/^\s+archivedAt:/m);
  });

  it('states that a family relationship is not a collection authorisation', () => {
    // The single most dangerous shortcut available in this schema is treating
    // relationship=parent as permission to collect a child. Custody orders separate the
    // two, so the contract says so where an implementer will read it.
    const block = spec.slice(
      spec.indexOf('    FamilyRelationship:'),
      spec.indexOf('    FamilyMember:'),
    );
    expect(block).toMatch(/not an authorisation/i);
    expect(block).toMatch(/GuardianAuthorisation/);
  });

  it('declares person and family status enums that match the database CHECK constraints', () => {
    // The spec and the migration are written separately and drift silently: an enum value
    // accepted by the API and rejected by Postgres is a 500 at runtime.
    const sql = readFileSync(
      new URL('../../migrations/sql/0005_people.sql', import.meta.url),
      'utf8',
    );
    const fromSql = (column: string) => {
      const match = sql.match(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)`));
      if (!match?.[1]) throw new Error(`no CHECK constraint for ${column}`);
      return match[1]
        .split(',')
        .map((value) => value.trim().replace(/'/g, ''))
        .sort();
    };
    const fromSpec = (name: string, next: string) =>
      spec
        .slice(spec.indexOf(`    ${name}:`), spec.indexOf(`    ${next}:`))
        .match(/enum: \[([^\]]*)\]/)![1]!
        .split(',')
        .map((value) => value.trim())
        .sort();

    expect(fromSpec('MembershipStatus', 'Person')).toEqual(fromSql('status'));
    expect(fromSpec('MilestoneType', 'Milestone')).toEqual(fromSql('type'));
    expect(fromSpec('FamilyRelationship', 'FamilyMember')).toEqual(fromSql('relationship'));
  });

  it('matches the documented page size to the spec', () => {
    expect(spec).toMatch(new RegExp(`default: ${PAGE_SIZE.default}`));
    expect(spec).toMatch(new RegExp(`maximum: ${PAGE_SIZE.max}`));
  });
});
