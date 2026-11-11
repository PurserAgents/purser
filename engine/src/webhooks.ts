import { createHmac, randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import type { EngineEvent, Webhook, WebhookDelivery, WebhookEventType } from "../../packages/sdk/src/schema.ts";
import { registerRoutes } from "./api/registry.ts";
import { body, owner, param, send, zAddr } from "./api/http.ts";
import type { Ctx } from "./ctx.ts";
import { registerTask } from "./engine.ts";
import { fail, id, lower, now, parseJson, sameAddress } from "./util.ts";

export const WEBHOOK_EVENTS: WebhookEventType[] = [
  "receipt.created",
  "intent.blocked",
  "intent.queued",
  "intent.executed",
  "approval.decided",
  "watchdog.alert",
  "account.frozen",
  "account.unfrozen",
  "invoice.updated",
  "stream.updated",
  "alert",
];

/** Header: Purser-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the webhook secret>. */
export function signPayload(secret: string, body: string, t = now()): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

/** Maps an engine event to the webhook event a subscriber asked for. */
export function webhookType(e: EngineEvent): WebhookEventType | null {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case "receipt":
      return d && "money" in d ? "receipt.created" : null;
    case "intent":
      return d.status === "blocked" && d.event === "blocked" ? "intent.blocked" : d.status === "queued" ? "intent.queued" : d.status === "executed" ? "intent.executed" : null;
    case "approval":
      return d.event === "approved" || d.event === "rejected" ? "approval.decided" : d.event === "queued" ? "intent.queued" : null;
    case "watchdog":
      return "watchdog.alert";
    case "account":
      return d.event === "frozen" ? "account.frozen" : d.event === "unfrozen" ? "account.unfrozen" : null;
    case "invoice":
      return "invoice.updated";
    case "stream":
    case "subscription":
      return "stream.updated";
    default:
      return (e.type as string) === "alert" ? "alert" : null;
  }
}

interface HookRow {
  id: string;
  url: string;
  secret: string;
  events: string;
  safe: string | null;
  active: number;
  created_at: number;
}

const view = (r: HookRow): Webhook => ({ id: r.id, url: r.url, events: parseJson(r.events, []), safe: (r.safe as `0x${string}`) ?? null, active: !!r.active, createdAt: r.created_at });

const BACKOFF = [0, 5, 30, 120]; // seconds before attempts 1..4

/** Queues a delivery for every webhook that wants this event. */
export function enqueue(ctx: Ctx, type: WebhookEventType, safe: string | null, data: unknown, onlyHook?: string) {
  const hooks = ctx.db.prepare("SELECT * FROM webhooks WHERE active = 1").all() as HookRow[];
  for (const h of hooks) {
    if (onlyHook && h.id !== onlyHook) continue;
    const events = parseJson<string[]>(h.events, []);
    if (!events.includes(type)) continue;
    if (h.safe && !sameAddress(h.safe, safe)) continue;
    const did = id("dlv");
    const payload = JSON.stringify({ id: did, type, safe, createdAt: now(), data }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    ctx.db.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event, body, status, attempts, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?)").run(did, h.id, type, payload, now());
  }
}

/** Sends pending deliveries (with retries and backoff). Returns how many were delivered. */
export async function deliver(ctx: Ctx): Promise<number> {
  const pending = ctx.db.prepare("SELECT d.*, w.url, w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.status = 'pending' ORDER BY d.created_at LIMIT 50").all() as {
    id: string;
    event: string;
    body: string;
    attempts: number;
    created_at: number;
    url: string;
    secret: string;
  }[];
  let ok = 0;
  for (const d of pending) {
    if (now() < d.created_at + (BACKOFF[d.attempts] ?? 0)) continue;
    let code: number | null = null;
    try {
      const res = await fetch(d.url, {
        method: "POST",
        headers: { "content-type": "application/json", "Purser-Event": d.event, "Purser-Delivery": d.id, "Purser-Signature": signPayload(d.secret, d.body) },
        body: d.body,
        signal: AbortSignal.timeout(5000),
      });
      code = res.status;
    } catch {
      code = null;
    }
    const attempts = d.attempts + 1;
    const delivered = code !== null && code >= 200 && code < 300;
    const status = delivered ? "delivered" : attempts >= BACKOFF.length ? "failed" : "pending";
    ctx.db.prepare("UPDATE webhook_deliveries SET status = ?, attempts = ?, response_code = ? WHERE id = ?").run(status, attempts, code, d.id);
    if (delivered) ok++;
  }
  return ok;
}

let subscribed = new WeakSet<Ctx>();
export function installWebhooks(ctx: Ctx) {
  if (subscribed.has(ctx)) return;
  subscribed.add(ctx);
  ctx.bus.subscribe((e) => {
    const t = webhookType(e);
    if (t) enqueue(ctx, t, e.safe, e.data);
  });
}

registerTask({
  name: "webhooks",
  every: 2000,
  async run(ctx) {
    installWebhooks(ctx);
    return deliver(ctx);
  },
});

registerRoutes((app: Hono, ctx: Ctx) => {
  installWebhooks(ctx);
  app.post("/v1/webhooks", async (c) => {
    const who = owner(ctx, c);
    const b = await body(c, z.object({ url: z.string().url().refine((u) => /^https?:\/\//.test(u), "http or https only"), events: z.array(z.enum(WEBHOOK_EVENTS as [WebhookEventType, ...WebhookEventType[]])).min(1), safe: zAddr.nullable().default(null) }));
    const wid = id("wh");
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    ctx.db.prepare("INSERT INTO webhooks (id, url, secret, events, safe, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)").run(wid, b.url, secret, JSON.stringify(b.events), b.safe, now());
    ctx.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(`webhook_owner:${wid}`, lower(who));
    await ctx.audit.append(`owner:${lower(who)}`, "webhook.created", b.safe, { webhook: wid, url: b.url, events: b.events });
    return send(c, { webhook: view(ctx.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(wid) as HookRow), secret }, 201);
  });
  const mine = (who: string) =>
    (ctx.db.prepare("SELECT w.* FROM webhooks w JOIN kv ON kv.key = 'webhook_owner:' || w.id WHERE kv.value = ? ORDER BY w.created_at DESC").all(lower(who)) as HookRow[]);
  app.get("/v1/webhooks", (c) => send(c, { items: mine(owner(ctx, c)).map(view), events: WEBHOOK_EVENTS, next: null }));
  const own = (c: Parameters<typeof owner>[1]) => {
    const who = owner(ctx, c);
    const h = mine(who).find((x) => x.id === param(c, "id"));
    return h ?? fail(404, "not_found", "No such webhook for this wallet.");
  };
  app.delete("/v1/webhooks/:id", (c) => {
    const h = own(c);
    ctx.db.prepare("UPDATE webhooks SET active = 0 WHERE id = ?").run(h.id);
    return send(c, { ok: true });
  });
  app.get("/v1/webhooks/:id/deliveries", (c) => {
    const h = own(c);
    const rows = ctx.db.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 100").all(h.id) as Record<string, unknown>[];
    const items: WebhookDelivery[] = rows.map((r) => ({ id: r.id as string, webhookId: r.webhook_id as string, event: r.event as WebhookEventType, status: r.status as WebhookDelivery["status"], attempts: r.attempts as number, responseCode: (r.response_code as number) ?? null, createdAt: r.created_at as number }));
    return send(c, { items, next: null });
  });
  app.post("/v1/webhooks/:id/test", async (c) => {
    const h = own(c);
    const events = parseJson<WebhookEventType[]>(h.events, []);
    // only this webhook: other subscribers (possibly other wallets) never receive someone else's test
    enqueue(ctx, events[0], h.safe, { test: true, message: "This is a test delivery from Purser." }, h.id);
    return send(c, { delivered: await deliver(ctx) });
  });
});

export const _reset = () => (subscribed = new WeakSet());
