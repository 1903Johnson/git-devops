// Base repository. docs/01 §3 states the rule it implements: "No query is ever written by
// hand with a raw church_id — a repository base class injects it."
//
// RLS is the backstop, not the plan. This class is the plan: it makes the correct query
// the easy one, so the database never has to catch a mistake in the first place.

import { currentTenant } from './context.js';
import type { TenantTransaction } from './database.js';

export class CrossTenantWriteError extends Error {
  constructor(table: string, attempted: string, actual: string) {
    super(
      `Refusing to write church_id "${attempted}" into ${table} from a context scoped to ` +
        `"${actual}". Cross-tenant writes go through unsafeCrossTenantTransaction with a reason.`,
    );
    this.name = 'CrossTenantWriteError';
  }
}

const COLUMN_RE = /^[a-z_][a-z0-9_]*$/;

function assertColumns(table: string, columns: readonly string[]): void {
  for (const column of columns) {
    if (!COLUMN_RE.test(column)) {
      throw new TypeError(`invalid column name "${column}" for table ${table}`);
    }
  }
}

export abstract class TenantRepository<Row extends { id: string }> {
  protected abstract readonly table: string;

  /**
   * Inserts a row, supplying church_id from the ambient context.
   *
   * A caller may pass church_id explicitly, but only one that matches the context —
   * passing another tenant's id is rejected rather than silently overwritten, because a
   * caller who wrote it meant something, and what they meant is a bug.
   */
  async insert(tx: TenantTransaction, data: Record<string, unknown>): Promise<Row> {
    const { churchId } = currentTenant(`${this.constructor.name}.insert`);
    const supplied = data['church_id'];
    if (supplied !== undefined && supplied !== churchId) {
      throw new CrossTenantWriteError(this.table, String(supplied), churchId);
    }

    const payload = { ...data, church_id: churchId };
    const columns = Object.keys(payload);
    assertColumns(this.table, columns);

    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await tx.query<Row>(
      `INSERT INTO ${this.table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      Object.values(payload),
    );
    const row = rows[0];
    if (!row) throw new Error(`insert into ${this.table} returned no row`);
    return row;
  }

  /**
   * Finds by id. No church_id predicate is added: RLS already restricts the visible set,
   * and adding one here would mask a policy that is missing or inactive. The isolation
   * tests must fail loudly if the policy is wrong, not be papered over by the ORM.
   */
  async findById(tx: TenantTransaction, id: string): Promise<Row | undefined> {
    const { rows } = await tx.query<Row>(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0];
  }

  async findAll(tx: TenantTransaction): Promise<Row[]> {
    const { rows } = await tx.query<Row>(`SELECT * FROM ${this.table}`);
    return rows;
  }

  async update(
    tx: TenantTransaction,
    id: string,
    changes: Record<string, unknown>,
  ): Promise<Row | undefined> {
    const { churchId } = currentTenant(`${this.constructor.name}.update`);
    const supplied = changes['church_id'];
    if (supplied !== undefined && supplied !== churchId) {
      throw new CrossTenantWriteError(this.table, String(supplied), churchId);
    }

    const columns = Object.keys(changes);
    if (columns.length === 0) return this.findById(tx, id);
    assertColumns(this.table, columns);

    const assignments = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const { rows } = await tx.query<Row>(
      `UPDATE ${this.table} SET ${assignments} WHERE id = $1 RETURNING *`,
      [id, ...Object.values(changes)],
    );
    return rows[0];
  }

  async deleteById(tx: TenantTransaction, id: string): Promise<number> {
    const { rowCount } = await tx.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
    return rowCount ?? 0;
  }
}
