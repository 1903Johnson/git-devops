import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/index.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('cursors', () => {
  it('round-trips a sort key', () => {
    expect(decodeCursor(encodeCursor({ name: 'Main', id }))).toEqual({ name: 'Main', id });
  });

  it('survives a name containing spaces', () => {
    // "North Campus" is an ordinary name. Splitting on the first space would put half of it
    // in the id and the cursor would silently point at the wrong row.
    const cursor = { name: 'North Campus', id };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('survives a name containing a newline', () => {
    // The separator itself. Splitting on the first newline instead of the last would break
    // this, and a pasted name with a stray line break is not a hypothetical.
    const cursor = { name: 'Odd\nName', id };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects a cursor whose id is not a uuid', () => {
    // The id half goes into a SQL comparison. Encoding is not authentication, and anything
    // a client can construct has to be validated like any other input.
    const forged = Buffer.from("Main\n' OR 1=1 --", 'utf8').toString('base64url');
    expect(decodeCursor(forged)).toBeUndefined();
  });

  it('returns undefined for junk rather than throwing', () => {
    // A stale or copied URL should start the reader at the first page, not 500.
    for (const raw of ['', 'not-base64!!', 'Zm9v', undefined]) {
      expect(decodeCursor(raw)).toBeUndefined();
    }
  });
});
