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
    const inSpec = spec
      .slice(spec.indexOf('          enum:\n            - BAD_REQUEST'))
      .split('\n')
      .slice(1)
      .filter((line) => line.trim().startsWith('- '))
      .map((line) => line.trim().slice(2));

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

  it('matches the documented page size to the spec', () => {
    expect(spec).toMatch(new RegExp(`default: ${PAGE_SIZE.default}`));
    expect(spec).toMatch(new RegExp(`maximum: ${PAGE_SIZE.max}`));
  });
});
