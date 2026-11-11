import type { Hono } from "hono";
import { encodeFunctionData, type Address } from "viem";
import { z } from "zod";
import { purserModuleAbi } from "../../packages/sdk/src/abi.ts";
import type { WatchdogBaseline, WatchdogEvent } from "../../packages/sdk/src/schema.ts";
import { accountRow, balanceOf, readChainAccount } from "./accounts.ts";
import { registerRoutes } from "./api/registry.ts";
import { body, safeOwner, safeParam, send } from "./api/http.ts";
import { chainNow, requireDep, type Ctx } from "./ctx.ts";
import { registerTask } from "./engine.ts";
import { ingestReceipt } from "./indexer.ts";
import { explainRevert } from "./chain.ts";
import { fmt, id, lower, sameAddress, usd, ZERO } from "./util.ts";

export const WATCH = {
  baselineDays: 7,
  minHoursForSpike: 12,
  spikeSigmas: 4,
  spikeMinUsdMicro: 5_000_000n, // a spike must be at least $5 in the hour
  burstCount: 10, // payments in 60 seconds
  loopCount: 5, // same payee and amount within 10 minutes
  drainShare: 50, // % of the balance at the start of the hour, gone within the hour
  newCounterpartyFactor: 3, // a first payment this many times the usual size
  cooldown: 600,
};

interface Row {
  counterparty: string;
  amount: string;
  token: string;
  usd_micro: string;
  created_at: number;
}

function outflows(ctx: Ctx, safe: string, since: number): Row[] {
  return ctx.db
    .prepare("SELECT counterparty, amount, token, usd_micro, created_at FROM receipts WHERE safe = ? AND direction = 'out' AND status = 'executed' AND category NOT IN ('treasury','split') AND created_at >= ? ORDER BY created_at ASC")
    .all(lower(safe), since) as Row[];
}

/** Hourly spend over the last week, and how many payees the agent knows. */
export function baseline(ctx: Ctx, safe: string, t: number): WatchdogBaseline & { meanMicro: bigint; stdMicro: bigint; medianMicro: bigint } {
  const since = t - WATCH.baselineDays * 86400;
  const rows = outflows(ctx, safe, since).filter((r) => r.created_at < t - 3600);
  const first = rows.length ? rows[0].created_at : t;
  const hours = Math.max(0, Math.floor((t - 3600 - first) / 3600));
  const buckets = new Map<number, bigint>();
  for (const r of rows) {
    const h = Math.floor(r.created_at / 3600);
    buckets.set(h, (buckets.get(h) ?? 0n) + BigInt(r.usd_micro));
  }
  const n = Math.max(hours, 1);
  const total = [...buckets.values()].reduce((s, v) => s + v, 0n);
  const mean = total / BigInt(n);
  let varSum = 0n;
  for (let i = 0; i < n; i++) {
    const v = buckets.get(Math.floor((first + i * 3600) / 3600)) ?? 0n;
    varSum += (v - mean) * (v - mean);
  }
  const std = BigInt(Math.floor(Math.sqrt(Number(varSum / BigInt(n)))));
  const sizes = rows.map((r) => BigInt(r.usd_micro)).sort((a, b) => (a < b ? -1 : 1));
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0n;
  const known = (ctx.db.prepare("SELECT COUNT(DISTINCT counterparty) AS n FROM receipts WHERE safe = ? AND direction = 'out' AND status = 'executed' AND created_at < ?").get(lower(safe), t - 3600) as { n: number }).n;
  const row = accountRow(ctx, safe);
  return {
    safe: lower(safe),
    samples: hours,
    hourlyMeanUsd: usd(mean),
    hourlyStdUsd: usd(std),
    knownCounterparties: known,
    autoFreeze: row ? !!row.auto_freeze : true,
    updatedAt: t,
    meanMicro: mean,
    stdMicro: std,
    medianMicro: median,
  };
}

interface Finding {
  kind: WatchdogEvent["kind"];
  severity: WatchdogEvent["severity"];
  title: string;
  detail: string;
  freeze: boolean;
}

/** Looks at the last hour against the baseline. Returns what is wrong, in plain words. */
export async function inspect(ctx: Ctx, safe: Address, t?: number): Promise<Finding[]> {
  const dep = requireDep(ctx);
  const now_ = t ?? (await chainNow(ctx));
  const b = baseline(ctx, safe, now_);
  const hour = outflows(ctx, safe, now_ - 3600);
  const found: Finding[] = [];
  const hourUsd = hour.reduce((s, r) => s + BigInt(r.usd_micro), 0n);

  // spike
  if (b.samples >= WATCH.minHoursForSpike) {
    const limit = b.meanMicro + BigInt(WATCH.spikeSigmas) * b.stdMicro;
    if (hourUsd > limit && hourUsd >= WATCH.spikeMinUsdMicro && hourUsd > b.meanMicro * 3n)
      found.push({ kind: "spike", severity: "critical", title: "Spending spike", detail: `$${usd(hourUsd)} spent in the last hour. This agent usually spends about $${b.hourlyMeanUsd} an hour (give or take $${b.hourlyStdUsd}).`, freeze: true });
  }
  // burst
  const lastMinute = hour.filter((r) => r.created_at >= now_ - 60);
  if (lastMinute.length >= WATCH.burstCount)
    found.push({ kind: "burst", severity: "critical", title: "Payments in a burst", detail: `${lastMinute.length} payments in the last minute.`, freeze: true });
  // loop
  const recent = hour.filter((r) => r.created_at >= now_ - 600);
  const repeats = new Map<string, number>();
  for (const r of recent) repeats.set(`${r.counterparty}:${r.token}:${r.amount}`, (repeats.get(`${r.counterparty}:${r.token}:${r.amount}`) ?? 0) + 1);
  for (const [k, n] of repeats) {
    if (n < WATCH.loopCount) continue;
    const [cp, token, amount] = k.split(":");
    const ti = ctx.tokens.infoSync(token);
    found.push({ kind: "loop", severity: "critical", title: "The same payment again and again", detail: `${n} payments of ${fmt(BigInt(amount), ti.decimals)} ${ti.symbol} to ${cp} in ten minutes. This looks like the agent is stuck in a loop.`, freeze: true });
  }
  // drain over the hour
  for (const token of [dep.usdg, ZERO as Address]) {
    const out = hour.filter((r) => sameAddress(r.token, token)).reduce((s, r) => s + BigInt(r.amount), 0n);
    if (out === 0n) continue;
    const bal = await balanceOf(ctx, token, safe);
    const startOfHour = bal + out;
    if (startOfHour > 0n && (out * 100n) / startOfHour >= BigInt(WATCH.drainShare)) {
      const ti = ctx.tokens.infoSync(token);
      found.push({ kind: "drain", severity: "critical", title: "Most of the balance left within an hour", detail: `${fmt(out, ti.decimals)} ${ti.symbol} went out in the last hour, ${((Number(out) * 100) / Number(startOfHour)).toFixed(0)}% of what the account held.`, freeze: true });
    }
  }
  // strange new counterparties
  const seenBefore = new Set(
    (ctx.db.prepare("SELECT DISTINCT counterparty FROM receipts WHERE safe = ? AND direction = 'out' AND status = 'executed' AND created_at < ?").all(lower(safe), now_ - 3600) as { counterparty: string }[]).map((r) => r.counterparty),
  );
  const fresh = new Map<string, bigint>();
  for (const r of hour) if (!seenBefore.has(r.counterparty)) fresh.set(r.counterparty, (fresh.get(r.counterparty) ?? 0n) + BigInt(r.usd_micro));
  const typical = b.medianMicro > 0n ? b.medianMicro : 1_000_000n;
  const large = [...fresh.entries()].filter(([, v]) => v >= typical * BigInt(WATCH.newCounterpartyFactor) && v >= 1_000_000n);
  if (large.length >= 3)
    found.push({ kind: "new_counterparty", severity: "critical", title: "Money to several unknown payees", detail: `${large.length} payees this agent never paid before received more than usual in the last hour.`, freeze: true });
  else
    for (const [cp, v] of large)
      found.push({ kind: "new_counterparty", severity: "warn", title: "A large first payment to a new payee", detail: `$${usd(v)} to ${cp}, which this agent never paid before. Its usual payment is about $${usd(typical)}.`, freeze: false });
  return found;
}

/** Records findings, freezes when allowed, tells the owner (SSE + webhooks). */
export async function react(ctx: Ctx, safe: Address, findings: Finding[]): Promise<WatchdogEvent[]> {
  const out: WatchdogEvent[] = [];
  const t = await chainNow(ctx);
  for (const f of findings) {
    const recent = ctx.db.prepare("SELECT 1 FROM watch_events WHERE safe = ? AND kind = ? AND created_at > ?").get(lower(safe), f.kind, t - WATCH.cooldown);
    if (recent) continue;
    let action: WatchdogEvent["action"] = "alert";
    let txHash: string | null = null;
    let detail = f.detail;
    if (f.freeze) {
      const a = await readChainAccount(ctx, safe);
      const wd = ctx.chain.accounts.watchdog;
      const allowed = (accountRow(ctx, safe)?.auto_freeze ?? 1) === 1;
      if (a.frozen) detail += " The account is already frozen.";
      else if (!wd || !sameAddress(a.config.watchdog, wd.address)) detail += " Freezing by the watchdog is off for this account; the owner should look now.";
      else if (!allowed) detail += " Auto-freeze is switched off; the owner should look now.";
      else if (!ctx.chain.broadcast) detail += " The engine cannot send the freeze from here; the owner should freeze it.";
      else {
        try {
          const r = await ctx.chain.send(wd, { to: requireDep(ctx).module, data: encodeFunctionData({ abi: purserModuleAbi, functionName: "freeze", args: [safe] }) });
          await ingestReceipt(ctx, r);
          action = "freeze";
          txHash = r.transactionHash;
          detail += " The watchdog froze the account. Only the owner can unfreeze it.";
        } catch (e) {
          detail += ` Freezing failed: ${explainRevert(e)}`;
        }
      }
    }
    const ev: WatchdogEvent = { id: id("wd"), safe: lower(safe), kind: f.kind, severity: f.severity, title: f.title, detail, action, txHash: (txHash as `0x${string}`) ?? null, createdAt: t };
    ctx.db.prepare("INSERT INTO watch_events (id, safe, kind, severity, title, detail, action, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(ev.id, ev.safe, ev.kind, ev.severity, ev.title, ev.detail, ev.action, ev.txHash, ev.createdAt);
    ctx.bus.emit("watchdog", ev.safe, ev);
    await ctx.audit.append("watchdog", `watchdog.${ev.action}`, ev.safe, { event: ev.id, kind: ev.kind, tx: ev.txHash });
    out.push(ev);
  }
  return out;
}

export async function watch(ctx: Ctx, safe: Address) {
  return react(ctx, safe, await inspect(ctx, safe));
}

export function listWatchEvents(ctx: Ctx, safe?: string): WatchdogEvent[] {
  const rows = (safe
    ? ctx.db.prepare("SELECT * FROM watch_events WHERE safe = ? ORDER BY created_at DESC, rowid DESC LIMIT 100").all(lower(safe))
    : ctx.db.prepare("SELECT * FROM watch_events ORDER BY created_at DESC, rowid DESC LIMIT 100").all()) as Record<string, unknown>[];
  return rows.map((r) => ({ id: r.id, safe: r.safe, kind: r.kind, severity: r.severity, title: r.title, detail: r.detail, action: r.action, txHash: r.tx_hash ?? null, createdAt: r.created_at }) as WatchdogEvent);
}

// after every executed payment, and once a minute for every account
export function installWatchdog(ctx: Ctx) {
  if (ctx.hooks.afterExecuted.some((h) => (h as { watchdog?: boolean }).watchdog)) return;
  const hook = Object.assign(async (safe: string) => {
    await watch(ctx, safe as Address).catch(() => undefined);
  }, { watchdog: true });
  ctx.hooks.afterExecuted.push(hook);
}

registerTask({
  name: "watchdog",
  every: 60_000,
  async run(ctx) {
    installWatchdog(ctx);
    const since = (await chainNow(ctx)) - 3600;
    const active = ctx.db.prepare("SELECT DISTINCT safe FROM receipts WHERE direction = 'out' AND created_at >= ?").all(since) as { safe: Address }[];
    for (const a of active) await watch(ctx, a.safe).catch(() => undefined);
  },
});

registerRoutes((app: Hono, ctx: Ctx) => {
  installWatchdog(ctx);
  app.get("/v1/accounts/:safe/watchdog", async (c) => {
    const safe = safeParam(c);
    const { meanMicro, stdMicro, medianMicro, ...b } = baseline(ctx, safe, await chainNow(ctx));
    void meanMicro;
    void stdMicro;
    void medianMicro;
    return send(c, { baseline: b, events: listWatchEvents(ctx, safe), thresholds: WATCH });
  });
  app.get("/v1/watchdog/events", (c) => send(c, { items: listWatchEvents(ctx), next: null }));
  app.patch("/v1/accounts/:safe/watchdog", async (c) => {
    const safe = safeParam(c);
    await safeOwner(ctx, c, safe);
    const b = await body(c, z.object({ autoFreeze: z.boolean() }));
    ctx.db.prepare("UPDATE accounts SET auto_freeze = ? WHERE safe = ?").run(b.autoFreeze ? 1 : 0, safe);
    return send(c, { safe, autoFreeze: b.autoFreeze });
  });
});
