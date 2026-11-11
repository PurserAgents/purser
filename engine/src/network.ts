import type { Hono } from "hono";
import type { Address } from "viem";
import { keccak256, toHex } from "viem";
import type { DirectoryEntry, Economy, LeaderboardEntry, PriceIndexPoint, PublicAgent } from "../../packages/sdk/src/schema.ts";
import { accountRow, readAccount } from "./accounts.ts";
import { registerRoutes } from "./api/registry.ts";
import { param, qInt, safeParam, send } from "./api/http.ts";
import { chainNow, type Ctx } from "./ctx.ts";
import { listReceipts } from "./receipts.ts";
import { listServices } from "./storefront.ts";
import { fail, lower, usd } from "./util.ts";

// ---------------------------------------------------------------------------------------------------- 18.1 directory

interface SvcRow {
  url: string;
  pay_to: string;
  name: string;
  asset: string | null;
  price: string | null;
  uses: number;
  payers: string;
  delivered: number;
  failed: number;
  refunds: number;
  last_used: number | null;
}

const entryId = (url: string) => `svc_${keccak256(toHex(url)).slice(2, 14)}`;

/** Every x402 service paid through Purser, and every storefront service on sale, with what buyers experienced. */
export function directory(ctx: Ctx): DirectoryEntry[] {
  const rows = ctx.db.prepare("SELECT * FROM x402_services").all() as SvcRow[];
  const byUrl = new Map<string, DirectoryEntry>();
  for (const r of rows) {
    const payers = JSON.parse(r.payers) as string[];
    const total = r.delivered + r.failed;
    byUrl.set(r.url, {
      id: entryId(r.url),
      name: r.name,
      url: r.url,
      payTo: r.pay_to as Address,
      source: r.url.includes("/v1/store/") ? "storefront" : "x402",
      price: r.asset && r.price ? ctx.tokens.money(r.asset, BigInt(r.price)) : null,
      uses: r.uses,
      payers: payers.length,
      deliveryRate: total ? r.delivered / total : null,
      refunds: r.refunds,
      lastUsed: r.last_used,
    });
  }
  // storefront services are listed from the moment they are on sale
  for (const s of listServices(ctx)) {
    if (byUrl.has(s.endpoint)) {
      byUrl.get(s.endpoint)!.name = s.name;
      continue;
    }
    const refunds = (ctx.db.prepare("SELECT COUNT(*) AS n FROM service_usage WHERE service_id = ? AND refunded = 1").get(s.id) as { n: number }).n;
    byUrl.set(s.endpoint, { id: entryId(s.endpoint), name: s.name, url: s.endpoint, payTo: s.safe, source: "storefront", price: s.pricing.price, uses: s.uses, payers: 0, deliveryRate: null, refunds, lastUsed: null });
  }
  return [...byUrl.values()];
}

export function sortDirectory(items: DirectoryEntry[], sort: string) {
  const by: Record<string, (a: DirectoryEntry, b: DirectoryEntry) => number> = {
    uses: (a, b) => b.uses - a.uses,
    rate: (a, b) => (b.deliveryRate ?? -1) - (a.deliveryRate ?? -1) || b.uses - a.uses,
    recent: (a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0),
    price: (a, b) => Number(a.price?.usd ?? Infinity) - Number(b.price?.usd ?? Infinity),
  };
  return items.sort(by[sort] ?? by.uses);
}

// ---------------------------------------------------------------------------------------------------- 19.1 economy

/** Flows that are spending or earning between parties (not moves inside one account or one team). */
const OUT = "direction = 'out' AND status = 'executed' AND category NOT IN ('treasury','internal')";
const IN = "direction = 'in' AND status = 'executed' AND category NOT IN ('treasury','internal')";

function sumUsd(ctx: Ctx, where: string, args: unknown[] = []): bigint {
  const r = ctx.db.prepare(`SELECT COALESCE(SUM(CAST(usd_micro AS INTEGER)),0) AS v, COUNT(*) AS n FROM receipts WHERE ${where}`).get(...args) as { v: number; n: number };
  return BigInt(r.v);
}

/**
 * The AI task price index: what agents paid per unit of work, from real receipts. Model calls give a price per
 * thousand tokens; x402 and storefront services give a median price per call. Each point compares the last 24 hours
 * with the 24 hours before.
 */
export function priceIndex(ctx: Ctx, t: number): PriceIndexPoint[] {
  const points: PriceIndexPoint[] = [];
  const window = (from: number, to: number) => {
    const r = ctx.db.prepare("SELECT COALESCE(SUM(CAST(cost_micro AS INTEGER)),0) AS cost, COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens, COUNT(*) AS n FROM model_calls WHERE created_at >= ? AND created_at < ? AND prompt_tokens + completion_tokens > 0").get(from, to) as { cost: number; tokens: number; n: number };
    return r.tokens > 0 ? { price: (r.cost * 1000) / r.tokens, n: r.n } : null;
  };
  const now24 = window(t - 86400, t + 1);
  const prev24 = window(t - 2 * 86400, t - 86400);
  if (now24) points.push({ category: "model-1k-tokens", unit: "1,000 tokens", priceUsd: (now24.price / 1e6).toFixed(4), samples: now24.n, change24h: prev24 ? now24.price / prev24.price - 1 : null });
  const median = (cat: string, from: number, to: number) => {
    const v = (ctx.db.prepare(`SELECT CAST(usd_micro AS INTEGER) AS v FROM receipts WHERE ${OUT} AND category = ? AND created_at >= ? AND created_at < ? ORDER BY v`).all(cat, from, to) as { v: number }[]).map((x) => x.v);
    return v.length ? { price: v[Math.floor(v.length / 2)], n: v.length } : null;
  };
  for (const [cat, label] of [["x402", "x402-call"], ["storefront", "agent-task"], ["model", "model-call"]] as const) {
    const a = median(cat, t - 86400, t + 1);
    const b = median(cat, t - 2 * 86400, t - 86400);
    if (a) points.push({ category: label, unit: "call", priceUsd: (a.price / 1e6).toFixed(4), samples: a.n, change24h: b && b.price ? a.price / b.price - 1 : null });
  }
  return points;
}

export async function economy(ctx: Ctx, range: "24h" | "30d" = "24h"): Promise<Economy> {
  const t = await chainNow(ctx);
  const agents = (ctx.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  const payments = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM receipts WHERE ${OUT}`).get() as { n: number }).n;
  const blocked = (ctx.db.prepare("SELECT COUNT(*) AS n FROM verdicts WHERE decision = 'block'").get() as { n: number }).n;
  const dir = directory(ctx);
  const step = range === "24h" ? 3600 : 86400;
  const buckets = range === "24h" ? 24 : 30;
  const start = Math.floor(t / step) * step - (buckets - 1) * step;
  const series = Array.from({ length: buckets }, (_, i) => {
    const from = start + i * step;
    return { t: from, spendUsd: usd(sumUsd(ctx, `${OUT} AND created_at >= ? AND created_at < ?`, [from, from + step])), earnUsd: usd(sumUsd(ctx, `${IN} AND created_at >= ? AND created_at < ?`, [from, from + step])) };
  });
  return {
    totals: { spendUsd: usd(sumUsd(ctx, OUT)), earnUsd: usd(sumUsd(ctx, IN)), payments, agents, services: dir.length, blocked },
    last24h: {
      spendUsd: usd(sumUsd(ctx, `${OUT} AND created_at >= ?`, [t - 86400])),
      earnUsd: usd(sumUsd(ctx, `${IN} AND created_at >= ?`, [t - 86400])),
      payments: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM receipts WHERE ${OUT} AND created_at >= ?`).get(t - 86400) as { n: number }).n,
    },
    topServices: sortDirectory(dir.filter((d) => d.uses > 0), "uses").slice(0, 10),
    priceIndex: priceIndex(ctx, t),
    series,
  };
}

// ---------------------------------------------------------------------------------------------------- leaderboard and public pages (opted-in only)

export async function leaderboard(ctx: Ctx, limit = 50): Promise<LeaderboardEntry[]> {
  const since = (await chainNow(ctx)) - 30 * 86400;
  const rows = ctx.db.prepare("SELECT safe, name, kind FROM accounts WHERE public = 1").all() as { safe: string; name: string; kind: LeaderboardEntry["kind"] }[];
  const list = rows.map((r) => {
    const earned = sumUsd(ctx, `safe = ? AND ${IN} AND created_at >= ?`, [r.safe, since]);
    const spent = sumUsd(ctx, `safe = ? AND ${OUT} AND created_at >= ?`, [r.safe, since]);
    const payments = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM receipts WHERE safe = ? AND status = 'executed' AND created_at >= ?`).get(r.safe, since) as { n: number }).n;
    return { safe: r.safe as Address, name: r.name, kind: r.kind, earned, spent, payments };
  });
  return list
    .sort((a, b) => (b.earned > a.earned ? 1 : b.earned < a.earned ? -1 : 0))
    .slice(0, limit)
    .map((x, i) => ({
      rank: i + 1,
      safe: x.safe,
      name: x.name,
      kind: x.kind,
      earnedUsd: usd(x.earned),
      spentUsd: usd(x.spent),
      profitUsd: (x.earned < x.spent ? "-" : "") + usd(x.earned < x.spent ? x.spent - x.earned : x.earned - x.spent),
      payments: x.payments,
    }));
}

export async function publicAgent(ctx: Ctx, safe: string): Promise<PublicAgent> {
  const row = accountRow(ctx, safe);
  if (!row || !row.public) fail(404, "not_public", "This agent's page is private.");
  const a = await readAccount(ctx, safe);
  const earned = sumUsd(ctx, `safe = ? AND ${IN}`, [lower(safe)]);
  const spent = sumUsd(ctx, `safe = ? AND ${OUT}`, [lower(safe)]);
  return {
    safe: a.safe,
    name: a.name,
    kind: a.kind,
    agentId: a.agentId,
    earnedUsd: usd(earned),
    spentUsd: usd(spent),
    profitUsd: (earned < spent ? "-" : "") + usd(earned < spent ? spent - earned : earned - spent),
    receipts: listReceipts(ctx, { safe, limit: 25 }).items,
    rules: a.rules,
    services: listServices(ctx, safe),
    createdAt: a.createdAt,
  };
}

registerRoutes((app: Hono, ctx: Ctx) => {
  app.get("/v1/directory", (c) => {
    let items = directory(ctx);
    const source = c.req.query("source");
    if (source) items = items.filter((d) => d.source === source);
    const q = c.req.query("q")?.toLowerCase();
    if (q) items = items.filter((d) => d.name.toLowerCase().includes(q) || d.url.toLowerCase().includes(q));
    return send(c, { items: sortDirectory(items, c.req.query("sort") ?? "uses").slice(0, qInt(c, "limit", 100)), next: null });
  });
  app.get("/v1/directory/:id", (c) => {
    const e = directory(ctx).find((d) => d.id === param(c, "id")) ?? fail(404, "not_found", "No such service.");
    const recent = ctx.db
      .prepare("SELECT safe, money_amount, created_at FROM (SELECT safe, amount AS money_amount, created_at, service, memo FROM receipts WHERE direction = 'out' AND status = 'executed' AND (memo = ? OR service = ?)) ORDER BY created_at DESC LIMIT 20")
      .all(`x402: ${e.url}`, e.url) as { safe: string; created_at: number }[];
    return send(c, { ...e, recentBuyers: recent.length });
  });
  app.get("/v1/economy", async (c) => send(c, await economy(ctx, c.req.query("range") === "30d" ? "30d" : "24h")));
  app.get("/v1/leaderboard", async (c) => send(c, { items: await leaderboard(ctx, qInt(c, "limit", 50)), next: null }));
  app.get("/v1/agents/:safe/public", async (c) => send(c, await publicAgent(ctx, safeParam(c))));
});
