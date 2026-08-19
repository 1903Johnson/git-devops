import { describe, expect, it } from 'vitest';
import { PurgeRefusedError, orderForDelete, type TableRow } from '../../src/index.js';

const table = (name: string, parents: string[] = []): TableRow => ({
  table_name: name,
  has_church_id: true,
  parents,
});

const order = (tables: TableRow[]) => orderForDelete(tables).map((t) => t.table_name);

describe('delete ordering', () => {
  it('puts a child before its parent', () => {
    expect(order([table('note'), table('line', ['note'])])).toEqual(['line', 'note']);
  });

  it('handles a chain, which a dependant count gets wrong', () => {
    // a -> b -> c. Counting dependants makes b and c tie at one each, and the tie is
    // resolved arbitrarily — so roughly half the time the delete fails partway through and
    // the module is left half-purged.
    const ordered = order([table('c'), table('b', ['c']), table('a', ['b'])]);
    expect(ordered.indexOf('a')).toBeLessThan(ordered.indexOf('b'));
    expect(ordered.indexOf('b')).toBeLessThan(ordered.indexOf('c'));
  });

  it('handles a diamond', () => {
    const ordered = order([
      table('root'),
      table('left', ['root']),
      table('right', ['root']),
      table('leaf', ['left', 'right']),
    ]);
    expect(ordered.indexOf('leaf')).toBeLessThan(ordered.indexOf('left'));
    expect(ordered.indexOf('leaf')).toBeLessThan(ordered.indexOf('right'));
    expect(ordered.at(-1)).toBe('root');
  });

  it('keeps independent tables and returns every one exactly once', () => {
    const ordered = order([table('a'), table('b'), table('c', ['a'])]);
    expect([...ordered].sort()).toEqual(['a', 'b', 'c']);
  });

  it('refuses a cycle rather than guessing an order', () => {
    expect(() => order([table('a', ['b']), table('b', ['a'])])).toThrow(PurgeRefusedError);
  });

  it('allows a self-reference, which is not a cycle for this purpose', () => {
    // A row pointing at another row in the same table is deleted by the same statement.
    expect(order([table('tree', ['tree'])])).toEqual(['tree']);
  });
});
