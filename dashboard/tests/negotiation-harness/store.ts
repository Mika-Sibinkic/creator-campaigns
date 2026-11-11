// tests/negotiation-harness/store.ts
//
// A minimal in-memory Supabase-client mock supporting exactly the call chains
// the negotiation lib uses:
//
//   from(t).insert(row).select().single()
//   from(t).select(cols).eq(col,v)[.eq()...].single() | .maybeSingle()
//   from(t).select(cols).eq().in('status',[...]).neq('id',x)   (awaited → rows[])
//   from(t).update(patch).eq('id',v)[.is('col',null)][.select().single()]
//   from(t).upsert(row, { onConflict: 'a' | 'a,b' })[.select().single()]
//   from(t).delete().eq(col,v)[.eq()...]
//
// Rows are canonical mutable objects so applyTransition's read-then-write and
// multi-round state persist across calls, exactly like a real table. Reads
// return shallow COPIES so a caller's `offer` snapshot doesn't alias the store.

import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;

interface Filter {
  kind: 'eq' | 'neq' | 'in' | 'is' | 'not_is' | 'lte' | 'lt' | 'gte';
  col: string;
  val: unknown;
}

type Tables = Record<string, Row[]>;

interface ExecResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Large enough that the campaign budget never binds, small enough to still be
 * a real enforced ceiling. Scenarios that want the budget to bite pass a
 * number; scenarios that want it out of the way pass null and get this.
 */
export const HARNESS_UNBOUNDED_BUDGET = 1_000_000;

let idSeq = 0;

class Query implements PromiseLike<ExecResult> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private conflictCols: string[] = [];
  private payload: Row | Row[] | null = null;
  private orderBy?: { col: string; asc: boolean };
  private limitN?: number;

  constructor(
    private tables: Tables,
    private table: string,
  ) {}

  private rows(): Row[] {
    if (!this.tables[this.table]) this.tables[this.table] = [];
    return this.tables[this.table];
  }

  select(cols?: string): this {
    void cols; // projection is ignored by the mock; full rows are returned
    return this;
  }
  insert(payload: Row | Row[]): this {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  update(patch: Row): this {
    this.op = 'update';
    this.payload = patch;
    return this;
  }
  /** DELETE … WHERE <filters>. Removes matching rows; returns them. */
  delete(): this {
    this.op = 'delete';
    return this;
  }
  /**
   * INSERT … ON CONFLICT (cols) DO UPDATE — the atomic write shape.
   *
   * onConflict is parsed as a COMMA-SEPARATED LIST, not a single column name.
   * cpm_snapshots conflicts on (campaign_id, snapshot_date); a single-column
   * implementation would look for a column literally named
   * "campaign_id,snapshot_date", read undefined on every row, and match the
   * FIRST row every time — silently overwriting an unrelated snapshot.
   */
  upsert(payload: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = 'upsert';
    this.payload = payload;
    this.conflictCols = (opts?.onConflict ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ kind: 'eq', col, val });
    return this;
  }
  neq(col: string, val: unknown): this {
    this.filters.push({ kind: 'neq', col, val });
    return this;
  }
  in(col: string, val: unknown[]): this {
    this.filters.push({ kind: 'in', col, val });
    return this;
  }
  /**
   * `.is(col, null)` — the conditional-write shape.
   *
   * Needed because a guard like `.update({...}).eq('id',x).is('sent_at', null)`
   * is the ONLY correct way to make a mark-sent idempotent: a read-then-write
   * check loses the race between two concurrent clicks, and Postgres is the only
   * thing that can arbitrate. Without this the double is missing a method the
   * production path depends on, and the suite fails with a TypeError rather than
   * telling you anything about the behaviour.
   */
  is(col: string, val: unknown): this {
    this.filters.push({ kind: 'is', col, val });
    return this;
  }
  /**
   * `.not(col, 'is', null)` — only the IS-NULL negation, which is the one shape
   * the payment reclaimer (src/lib/payment-reclaim.ts) uses. Any other operator
   * throws rather than silently matching everything.
   */
  not(col: string, op: string, val: unknown): this {
    if (op !== 'is') throw new Error(`mock store: .not('${col}', '${op}') is not supported`);
    this.filters.push({ kind: 'not_is', col, val });
    return this;
  }
  /** Range filters compare with JS `<`/`>`, which is correct for ISO-8601
   *  timestamps and numbers — the only things the callers compare. NULL never
   *  matches, as in Postgres. */
  lte(col: string, val: unknown): this {
    this.filters.push({ kind: 'lte', col, val });
    return this;
  }
  lt(col: string, val: unknown): this {
    this.filters.push({ kind: 'lt', col, val });
    return this;
  }
  gte(col: string, val: unknown): this {
    this.filters.push({ kind: 'gte', col, val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private match(row: Row): boolean {
    return this.filters.every((f) => {
      if (f.kind === 'eq') return row[f.col] === f.val;
      if (f.kind === 'neq') return row[f.col] !== f.val;
      // PostgREST `is` compares against NULL; treat undefined as NULL the way
      // an absent column reads from a real row.
      if (f.kind === 'is') {
        if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
        return row[f.col] === f.val;
      }
      if (f.kind === 'not_is') {
        if (f.val === null) return row[f.col] !== null && row[f.col] !== undefined;
        return row[f.col] !== f.val;
      }
      if (f.kind === 'lte' || f.kind === 'lt' || f.kind === 'gte') {
        const v = row[f.col] as string | number | null | undefined;
        if (v === null || v === undefined) return false;
        const target = f.val as string | number;
        if (f.kind === 'lte') return v <= target;
        if (f.kind === 'lt') return v < target;
        return v >= target;
      }
      return (f.val as unknown[]).includes(row[f.col]);
    });
  }

  private exec(): ExecResult {
    const rows = this.rows();
    if (this.op === 'insert') {
      const toInsert = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const inserted = toInsert.map((r) => {
        idSeq += 1;
        const row: Row = { id: `${this.table}-${idSeq}`, ...r };
        rows.push(row);
        return { ...row };
      });
      return { data: inserted, error: null };
    }
    if (this.op === 'upsert') {
      const toUpsert = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const out: Row[] = [];
      for (const r of toUpsert) {
        const match =
          this.conflictCols.length > 0
            ? rows.find((existing) => this.conflictCols.every((c) => existing[c] === r[c]))
            : undefined;
        if (match) {
          Object.assign(match, r);
          out.push({ ...match });
        } else {
          idSeq += 1;
          const row: Row = { id: `${this.table}-${idSeq}`, ...r };
          rows.push(row);
          out.push({ ...row });
        }
      }
      return { data: out, error: null };
    }
    if (this.op === 'delete') {
      const removed: Row[] = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        if (this.match(rows[i])) removed.push(...rows.splice(i, 1));
      }
      return { data: removed, error: null };
    }
    if (this.op === 'update') {
      const patch = this.payload as Row;
      const updated: Row[] = [];
      for (const row of rows) {
        if (this.match(row)) {
          Object.assign(row, patch);
          updated.push({ ...row });
        }
      }
      return { data: updated, error: null };
    }
    let selected = rows.filter((r) => this.match(r)).map((r) => ({ ...r }));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      selected = selected.sort((a, b) => {
        const av = a[col] as string | number;
        const bv = b[col] as string | number;
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      });
    }
    if (this.limitN != null) selected = selected.slice(0, this.limitN);
    return { data: selected, error: null };
  }

  single(): Promise<ExecResult> {
    const { data } = this.exec();
    const arr = data as Row[];
    if (arr.length === 0) return Promise.resolve({ data: null, error: { message: 'no rows' } });
    return Promise.resolve({ data: arr[0], error: null });
  }
  maybeSingle(): Promise<ExecResult> {
    const { data } = this.exec();
    const arr = data as Row[];
    return Promise.resolve({ data: arr.length ? arr[0] : null, error: null });
  }
  then<TResult1 = ExecResult, TResult2 = never>(
    onfulfilled?: ((value: ExecResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.exec()).then(onfulfilled, onrejected);
  }
}

export interface MockStore {
  sb: SupabaseClient;
  /**
   * Seed a campaign. `null` means "the campaign budget is NOT the binding
   * constraint in this scenario" and seeds HARNESS_UNBOUNDED_BUDGET, not a
   * NULL column.
   *
   * An unestablishable campaign budget fails CLOSED: negotiation
   * escalates instead of falling back to the per-creator ceiling. Migration
   * 037's campaigns_confirmed_requires_caps already makes a confirmed campaign
   * with no budget unrepresentable in the real database, so a NULL-budget
   * campaign is not a state these scenarios can be testing on purpose — it was
   * shorthand for "I don't care about the budget here". That shorthand now has
   * to say so explicitly.
   *
   * A test that genuinely wants an unset budget seeds the column itself:
   *   store.seed('campaigns', { id, firm_id, total_budget_usd: null })
   */
  seedCampaign(id: string, totalBudgetUsd: number | null): void;
  seedOffer(row: Row): Row;
  getOffer(id: string): Row | undefined;
  allOffers(): Row[];
  /** Generic seed into any table (multi-table integration tests). */
  seed(table: string, row: Row): Row;
  /** Generic read of a whole table (canonical mutable rows). */
  all(table: string): Row[];
}

export function makeStore(): MockStore {
  const tables: Tables = { creator_offers: [], campaigns: [] };
  const sb = {
    from(table: string) {
      return new Query(tables, table);
    },
  } as unknown as SupabaseClient;

  return {
    sb,
    seedCampaign(id, totalBudgetUsd) {
      tables.campaigns.push({
        id,
        total_budget_usd: totalBudgetUsd ?? HARNESS_UNBOUNDED_BUDGET,
      });
    },
    seedOffer(row) {
      tables.creator_offers.push(row);
      return row;
    },
    getOffer(id) {
      return tables.creator_offers.find((r) => r.id === id);
    },
    allOffers() {
      return tables.creator_offers;
    },
    seed(table, row) {
      if (!tables[table]) tables[table] = [];
      tables[table].push(row);
      return row;
    },
    all(table) {
      return tables[table] ?? [];
    },
  };
}
