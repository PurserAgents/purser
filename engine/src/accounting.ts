import type { Hono } from "hono";
import type { Pnl, PnlLine } from "../../packages/sdk/src/schema.ts";
import { registerRoutes } from "./api/registry.ts";
import { param, qInt, safeParam, send } from "./api/http.ts";
import type { Ctx } from "./ctx.ts";
import type { ReceiptRow } from "./receipts.ts";
import { getTeam } from "./teams.ts";
import { dayKey, fmt, lower, now, parseJson, usd } from "./util.ts";

/** Receipts that are not profit or loss: moving money into or out of the account's own vault. */
const NOT_PNL = new Set(["treasury"]);

function rowsFor(ctx: Ctx, safes: string[], from: number, to: number): ReceiptRow[] {
  if (!safes.length) return [];
  return ctx.db
    .prepare(`SELECT * FROM receipts WHERE status = 'executed' AND created_at >= ? AND created_at < ? AND safe IN (${safes.map(() => "?").join(",")}) ORDER BY created_at ASC`)
    .all(from, to, ...safes.map(lower)) as ReceiptRow[];
}

function line(map: Map<string, { label: string; income: bigint; spend: bigint; count: number }>, key: string, label: string, income: bigint, spend: bigint) {
  const cur = map.get(key) ?? { label, income: 0n, spend: 0n, count: 0 };
  cur.income += income;
  cur.spend += spend;
  cur.count += 1;
  map.set(key, cur);
}

const lines = (m: Map<string, { label: string; income: bigint; spend: bigint; count: number }>): PnlLine[] =>
  [...m.entries()]
    .map(([key, v]) => ({ key, label: v.label, income: usd(v.income), spend: usd(v.spend), count: v.count, _sort: v.income + v.spend }))
    .sort((a, b) => (a._sort > b._sort ? -1 : 1))
    .map(({ _sort, ...l }) => (void _sort, l));

/**
 * Profit and loss in US dollars (USDG at one dollar, ETH at the chain's Chainlink price when the receipt was written).
 * For a team, payments between its own members cancel out and are left out.
 */
export function pnl(ctx: Ctx, scope: { safes: string[]; safe?: string | null; teamId?: string | null }, from: number, to: number): Pnl {
  const inside = new Set(scope.safes.map(lower));
  const cat = new Map(), model = new Map(), task = new Map(), customer = new Map(), day = new Map<string, { income: bigint; spend: bigint }>();
  let income = 0n, spend = 0n, fees = 0n;
  for (const r of rowsFor(ctx, scope.safes, from, to)) {
    if (NOT_PNL.has(r.category)) continue;
    if (scope.teamId && inside.has(r.counterparty as `0x${string}`)) continue; // internal to the team
    const v = BigInt(r.usd_micro);
    const fee = r.fee ? (ctx.tokens.usdMicroSync(r.token, BigInt(r.fee)) ?? 0n) : 0n;
    const isIn = r.direction === "in";
    if (isIn) income += v;
    else {
      spend += v;
      fees += fee;
    }
    line(cat, r.category, r.category, isIn ? v : 0n, isIn ? 0n : v);
    const m = parseJson<{ provider: string; model: string } | null>(r.model, null);
    const modelKey = m ? `${m.provider}/${m.model}` : r.category === "model" && r.service ? r.service : null;
    if (!isIn && modelKey) line(model, modelKey, modelKey, 0n, v);
    if (!isIn && r.task_id) line(task, r.task_id, r.task_id, 0n, v);
    if (isIn) {
      const c = r.customer ?? r.counterparty;
      const name = (ctx.db.prepare("SELECT name FROM accounts WHERE safe = ?").get(c) as { name: string } | undefined)?.name ?? c;
      line(customer, c, name, v, 0n);
    }
    const d = dayKey(r.created_at);
    const dd = day.get(d) ?? { income: 0n, spend: 0n };
    if (isIn) dd.income += v;
    else dd.spend += v;
    day.set(d, dd);
  }
  return {
    scope: { safe: scope.safe ? lower(scope.safe) : null, teamId: scope.teamId ?? null } as Pnl["scope"],
    from,
    to,
    incomeUsd: usd(income),
    spendUsd: usd(spend),
    feesUsd: usd(fees),
    profitUsd: (income - spend - fees < 0n ? "-" : "") + usd(income - spend - fees < 0n ? spend + fees - income : income - spend - fees),
    byCategory: lines(cat),
    byModel: lines(model),
    byTask: lines(task),
    byCustomer: lines(customer),
    byDay: [...day.entries()].sort().map(([d, v]) => ({ day: d, incomeUsd: usd(v.income), spendUsd: usd(v.spend) })),
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CSV_HEADER = ["date", "receipt", "account", "direction", "category", "amount", "token", "usd", "fee", "counterparty", "counterparty_name", "service", "memo", "task", "customer", "model", "status", "tx_hash"];

export function receiptsCsv(ctx: Ctx, safes: string[], from: number, to: number): string {
  const out = [CSV_HEADER.join(",")];
  for (const r of rowsFor(ctx, safes, from, to)) {
    const t = ctx.tokens.infoSync(r.token);
    const name = (ctx.db.prepare("SELECT name FROM accounts WHERE safe = ?").get(r.counterparty) as { name: string } | undefined)?.name ?? null;
    const m = parseJson<{ provider: string; model: string } | null>(r.model, null);
    out.push(
      [
        new Date(r.created_at * 1000).toISOString(),
        r.id,
        r.safe,
        r.direction,
        r.category,
        fmt(BigInt(r.amount), t.decimals, t.decimals).replace(/,/g, ""),
        t.symbol,
        usd(BigInt(r.usd_micro)),
        r.fee ? fmt(BigInt(r.fee), t.decimals, t.decimals).replace(/,/g, "") : "",
        r.counterparty,
        name,
        r.service,
        r.memo,
        r.task_id,
        r.customer,
        m ? `${m.provider}/${m.model}` : "",
        r.status,
        r.tx_hash,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return out.join("\n") + "\n";
}

const range = (c: Parameters<typeof qInt>[0]) => {
  const to = qInt(c, "to", now() + 1)!;
  return { from: qInt(c, "from", to - 30 * 86400)!, to };
};

const teamSafes = (ctx: Ctx, tid: string) => {
  const t = getTeam(ctx, tid);
  return [t.treasury, ...t.members.map((m) => m.safe)];
};

registerRoutes((app: Hono, ctx: Ctx) => {
  app.get("/v1/accounts/:safe/pnl", (c) => {
    const safe = safeParam(c);
    const { from, to } = range(c);
    return send(c, pnl(ctx, { safes: [safe], safe }, from, to));
  });
  app.get("/v1/teams/:id/pnl", (c) => {
    const tid = param(c, "id");
    const { from, to } = range(c);
    return send(c, pnl(ctx, { safes: teamSafes(ctx, tid), teamId: tid }, from, to));
  });
  app.get("/v1/accounts/:safe/export.csv", (c) => {
    const safe = safeParam(c);
    const { from, to } = range(c);
    return c.body(receiptsCsv(ctx, [safe], from, to), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="purser-${safe.slice(0, 10)}.csv"` });
  });
  app.get("/v1/teams/:id/export.csv", (c) => {
    const tid = param(c, "id");
    const { from, to } = range(c);
    return c.body(receiptsCsv(ctx, teamSafes(ctx, tid), from, to), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="purser-team-${tid}.csv"` });
  });
});
