import type { Hono } from "hono";
import type { Address } from "viem";
import { z } from "zod";
import type { Alert, AlertKind, EngineEvent, Receipt } from "../../packages/sdk/src/schema.ts";
import { balanceOf } from "./accounts.ts";
import { registerRoutes } from "./api/registry.ts";
import { body, safeOwner, safeParam, send, zAmount } from "./api/http.ts";
import { chainNow, type Ctx } from "./ctx.ts";
import { getTemplate } from "./templates.ts";
import { fmt, id, lower, now, usd } from "./util.ts";

export const ALERT_KINDS: AlertKind[] = ["payment_blocked", "approval_needed", "frozen", "spend_over", "balance_under", "income"];
const COOLDOWN: Partial<Record<AlertKind, number>> = { spend_over: 86400, balance_under: 6 * 3600 };

export function listAlerts(ctx: Ctx, safe: string): Alert[] {
  return (ctx.db.prepare("SELECT * FROM alerts WHERE safe = ? ORDER BY kind").all(lower(safe)) as { id: string; safe: string; kind: AlertKind; threshold: string | null; created_at: number }[]).map((r) => ({
    id: r.id,
    safe: r.safe as Address,
    kind: r.kind,
    threshold: r.threshold,
    createdAt: r.created_at,
  }));
}

export function setAlerts(ctx: Ctx, safe: string, alerts: { kind: AlertKind; threshold?: string | null }[]) {
  ctx.db.prepare("DELETE FROM alerts WHERE safe = ?").run(lower(safe));
  for (const a of alerts) ctx.db.prepare("INSERT INTO alerts (id, safe, kind, threshold, created_at) VALUES (?, ?, ?, ?, ?)").run(id("alr"), lower(safe), a.kind, a.threshold ?? null, now());
  return listAlerts(ctx, safe);
}

/** A template's alerts, for an account created from it. */
export const applyTemplateAlerts = (ctx: Ctx, safe: string, template: string) => setAlerts(ctx, safe, getTemplate(template).alerts);

async function fire(ctx: Ctx, safe: string, kind: AlertKind, title: string, detail: string) {
  const row = ctx.db.prepare("SELECT id, last_fired FROM alerts WHERE safe = ? AND kind = ?").get(lower(safe), kind) as { id: string; last_fired: number | null } | undefined;
  if (!row) return;
  const t = await chainNow(ctx);
  if (COOLDOWN[kind] && row.last_fired && t - row.last_fired < COOLDOWN[kind]!) return;
  ctx.db.prepare("UPDATE alerts SET last_fired = ? WHERE id = ?").run(t, row.id);
  ctx.bus.emit("alert", safe, { kind, title, detail, alert: row.id });
}

/** Alerts follow engine events: blocked payments, approvals, freezes, income, spending and balance levels. */
async function onEvent(ctx: Ctx, e: EngineEvent) {
  if (!e.safe) return;
  const d = e.data as Record<string, unknown>;
  if (e.type === "intent" && d.event === "blocked") return fire(ctx, e.safe, "payment_blocked", "A payment was blocked", String(d.error ?? d.summary ?? ""));
  if (e.type === "approval" && d.event === "queued") return fire(ctx, e.safe, "approval_needed", "A payment waits for your approval", `Intent ${d.intentId ?? ""}`);
  if (e.type === "account" && d.event === "frozen") return fire(ctx, e.safe, "frozen", "The account was frozen", `Frozen by ${d.by}.`);
  if (e.type !== "receipt" || !("money" in d)) return;
  const r = d as unknown as Receipt;
  const rules = ctx.db.prepare("SELECT kind, threshold FROM alerts WHERE safe = ?").all(lower(e.safe)) as { kind: AlertKind; threshold: string | null }[];
  for (const a of rules) {
    if (a.kind === "income" && r.direction === "in" && r.money.usd && BigInt(Math.round(Number(r.money.usd) * 1e6)) >= BigInt(a.threshold ?? "0"))
      await fire(ctx, e.safe, "income", "Money came in", `${r.money.display} from ${r.counterpartyName ?? r.counterparty}.`);
    if (a.kind === "spend_over" && r.direction === "out" && a.threshold) {
      const t = await chainNow(ctx);
      const spent = BigInt(
        (ctx.db.prepare("SELECT COALESCE(SUM(CAST(usd_micro AS INTEGER)),0) AS v FROM receipts WHERE safe = ? AND direction = 'out' AND status = 'executed' AND category != 'treasury' AND created_at >= ?").get(lower(e.safe), t - (t % 86400)) as { v: number }).v,
      );
      if (spent > BigInt(a.threshold)) await fire(ctx, e.safe, "spend_over", "Spending passed your alert level", `$${usd(spent)} spent today; the alert is at $${usd(BigInt(a.threshold))}.`);
    }
    if (a.kind === "balance_under" && r.direction === "out" && a.threshold && ctx.dep) {
      const bal = await balanceOf(ctx, ctx.dep.usdg, e.safe as Address);
      if (bal < BigInt(a.threshold)) await fire(ctx, e.safe, "balance_under", "The balance is low", `${fmt(bal, 6)} USDG left; the alert is at ${fmt(BigInt(a.threshold), 6)} USDG.`);
    }
  }
}

const installed = new WeakSet<Ctx>();
export function installAlerts(ctx: Ctx) {
  if (installed.has(ctx)) return;
  installed.add(ctx);
  ctx.bus.subscribe((e) => {
    if (e.type !== "alert") void onEvent(ctx, e).catch(() => undefined);
  });
}

registerRoutes((app: Hono, ctx: Ctx) => {
  installAlerts(ctx);
  app.get("/v1/accounts/:safe/alerts", (c) => send(c, { items: listAlerts(ctx, safeParam(c)), kinds: ALERT_KINDS, next: null }));
  app.put("/v1/accounts/:safe/alerts", async (c) => {
    const safe = safeParam(c);
    await safeOwner(ctx, c, safe);
    const b = await body(c, z.object({ alerts: z.array(z.object({ kind: z.enum(ALERT_KINDS as [AlertKind, ...AlertKind[]]), threshold: zAmount.nullable().optional() })).max(20) }));
    return send(c, { items: setAlerts(ctx, safe, b.alerts), next: null });
  });
  app.post("/v1/accounts/:safe/alerts/template", async (c) => {
    const safe = safeParam(c);
    await safeOwner(ctx, c, safe);
    const b = await body(c, z.object({ template: z.string() }));
    return send(c, { items: applyTemplateAlerts(ctx, safe, b.template), next: null });
  });
});
