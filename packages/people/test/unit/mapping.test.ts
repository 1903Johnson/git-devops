import { describe, expect, it } from 'vitest';
import { toDateOnly, toPerson, type PersonRow } from '../../src/index.js';

const baseRow: PersonRow = {
  id: '11111111-1111-4111-8111-111111111111',
  church_id: '22222222-2222-4222-8222-222222222222',
  campus_id: null,
  first_name: 'Jo',
  last_name: 'Smith',
  preferred_name: null,
  gender: null,
  date_of_birth: null,
  email: null,
  phone: null,
  address_line1: null,
  address_line2: null,
  city: null,
  region: null,
  postal_code: null,
  country: null,
  photo_url: null,
  status: 'visitor',
  archived_at: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

describe('date-only columns', () => {
  it('keeps the calendar date the database holds', () => {
    // The bug this exists to prevent: node-postgres builds a Date for a `date` column by
    // parsing it in the *server's* timezone. toISOString() on that shifts a birthday west
    // of UTC to the previous day — which surfaces as one child in a hundred being offered
    // the wrong class, months after anyone would connect it to a mapping function.
    const midnightLocal = new Date(2015, 5, 15); // 15 June 2015, local time
    expect(toDateOnly(midnightLocal)).toBe('2015-06-15');
  });

  it('handles a string from to_jsonb without reinterpreting it', () => {
    expect(toDateOnly('2015-06-15')).toBe('2015-06-15');
    expect(toDateOnly('2015-06-15T00:00:00.000Z')).toBe('2015-06-15');
  });

  it('reports no date rather than an epoch', () => {
    expect(toDateOnly(null)).toBeUndefined();
  });
});

describe('person mapping', () => {
  it('omits an address entirely when no part of one is held', () => {
    // `address: {}` reads as "we hold an address and it is blank", which is a different
    // claim from "we hold none" — and a client rendering the first shows an empty card.
    expect(toPerson(baseRow).address).toBeUndefined();
  });

  it('includes only the parts that are held', () => {
    const person = toPerson({ ...baseRow, city: 'Leeds', country: 'GB' });
    expect(person.address).toEqual({ city: 'Leeds', country: 'GB' });
  });

  it('reports archivedAt as null rather than omitting it', () => {
    // Present-and-null is the contract: a client checking `archivedAt === null` for "this
    // person is active" should not have to also check for absence.
    expect(toPerson(baseRow).archivedAt).toBeNull();
    expect(toPerson({ ...baseRow, archived_at: new Date('2026-02-01T00:00:00Z') }).archivedAt).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });

  it('never invents a preferred name', () => {
    expect(toPerson(baseRow).preferredName).toBeUndefined();
    expect(toPerson({ ...baseRow, preferred_name: 'Jojo' }).preferredName).toBe('Jojo');
  });
});
