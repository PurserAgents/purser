import type { DB } from "./db.ts";
import { MAX_U128 } from "./util.ts";

/**
 * Amounts an owner or an agent typed in are at most 2^128 - 1 (what the escrow and the module's rules take); the API
 * refuses anything longer. Rows stored before that limit existed are brought within it when the engine starts:
 * a listing or a service with a larger price is switched off, and every such amount is set to the largest allowed,
 * so no row can make printing or searching slow. Returns how many rows each table had.
 */
export function clampStoredAmounts(db: DB): Record<string, number> {
  const max = MAX_U128.toString();
  const over = (v: string | null) => v !== null && (v.length > max.length || (v.length === max.length && v > max) || !/^\d+$/.test(v));
  const plan: [table: string, key: string, column: string, extra: string][] = [
    ["listings", "id", "price", ", active = 0"],
    ["services", "id", "price", ", active = 0"],
    ["invoices", "id", "amount", ""],
    ["departments", "id", "daily_budget", ""],
    ["hire_rules", "safe", "max_per_job", ""],
    ["hire_rules_more", "safe", "max_per_seller_day", ""],
  ];
  const out: Record<string, number> = {};
  for (const [table, key, column, extra] of plan) {
    // only rows at least as long as the limit can be over it; the length test keeps this one cheap query
    const rows = db.prepare(`SELECT ${key} AS k, ${column} AS v FROM ${table} WHERE length(${column}) >= ?`).all(max.length) as { k: string; v: string | null }[];
    const bad = rows.filter((r) => over(r.v));
    for (const r of bad) db.prepare(`UPDATE ${table} SET ${column} = ?${extra} WHERE ${key} = ?`).run(max, r.k);
    if (bad.length) out[table] = bad.length;
  }
  return out;
}
