import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { encodeFunctionData, keccak256, toHex, type Address } from "viem";
import { z } from "zod";
import { purserModuleAbi } from "../../packages/sdk/src/abi.ts";
import type { StoreService } from "../../packages/sdk/src/schema.ts";
import { decodeHeader, encodeHeader, HEADER_REQUIRED, HEADER_RESPONSE, HEADER_SIGNATURE, HEADER_V1_PAYMENT, type PaymentPayload, type PaymentRequired, type PaymentRequirements } from "../../packages/sdk/src/x402.ts";
import { accountRow, readChainAccount } from "./accounts.ts";
import { registerRoutes } from "./api/registry.ts";
import { agent, body, param, safeParam, send, zAddr, zAmount } from "./api/http.ts";
import { requireDep, type Ctx } from "./ctx.ts";
import { kvGet, kvSet } from "./db.ts";
import { tagRef } from "./indexer.ts";
import { fail, id, lower, now, parseJson } from "./util.ts";
import { network, recordFailedDelivery, recordServiceUse, settlePayment, verifyPayment } from "./x402.ts";
import { EMBED_JS } from "./embed.ts";

interface ServiceRow {
  id: string;
  safe: string;
  name: string;
  description: string;
  model: "per_call" | "per_minute" | "subscription";
  token: string;
  price: string;
  period: number | null;
  upstream: string | null;
  response: string | null;
  active: number;
  created_at: number;
}

export function serviceView(ctx: Ctx, r: ServiceRow): StoreService {
  const u = ctx.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount AS INTEGER)),0) AS total FROM service_usage WHERE service_id = ? AND delivered = 1").get(r.id) as { n: number; total: number };
  return {
    id: r.id,
    safe: r.safe as Address,
    name: r.name,
    description: r.description,
    pricing: { model: r.model, price: ctx.tokens.money(r.token, BigInt(r.price)), periodSeconds: r.period },
    endpoint: `${ctx.cfg.publicUrl}/v1/store/${r.id}`,
    uses: u.n,
    revenue: ctx.tokens.money(r.token, BigInt(u.total)),
    active: !!r.active,
    createdAt: r.created_at,
  };
}

export function listServices(ctx: Ctx, safe?: string): StoreService[] {
  const rows = (safe
    ? ctx.db.prepare("SELECT * FROM services WHERE safe = ? ORDER BY created_at DESC").all(lower(safe))
    : ctx.db.prepare("SELECT * FROM services WHERE active = 1 ORDER BY created_at DESC").all()) as ServiceRow[];
  return rows.map((r) => serviceView(ctx, r));
}

function getService(ctx: Ctx, sid: string): ServiceRow {
  return (ctx.db.prepare("SELECT * FROM services WHERE id = ?").get(sid) as ServiceRow | undefined) ?? fail(404, "not_found", "No such service.");
}

/** What a buyer pays for one request, one block of minutes, or one subscription period. */
function requirements(ctx: Ctx, s: ServiceRow, units: number): PaymentRequirements {
  return {
    scheme: "exact",
    network: network(ctx),
    amount: (BigInt(s.price) * BigInt(units)).toString(),
    asset: s.token as Address,
    payTo: s.safe as Address,
    maxTimeoutSeconds: 120,
    extra: { name: "Global Dollar", version: "1", purser: true, service: s.id, model: s.model, units },
  };
}

const accessKey = (sid: string, token: string) => `access:${sid}:${keccak256(toHex(token))}`;

/** Serves a paywalled call: checks access or payment, runs the agent's work, settles, meters. */
async function serve(ctx: Ctx, c: Context, s: ServiceRow): Promise<Response> {
  if (!s.active) fail(410, "inactive", "This service is paused.");
  const access = c.req.header("x-purser-access");
  let paid: { payment: PaymentPayload; req: PaymentRequirements } | null = null;
  let units = 1;
  if (access) {
    const exp = Number(kvGet(ctx.db, accessKey(s.id, access)) ?? 0);
    if (exp < now()) fail(402, "access_expired", "The access window ended. Pay again.");
  } else {
    if (s.model === "per_minute") units = Math.max(1, Math.min(1440, Number(c.req.query("minutes") ?? 1)));
    const req = requirements(ctx, s, units);
    const raw = c.req.header(HEADER_SIGNATURE) ?? c.req.header(HEADER_V1_PAYMENT);
    const payment = raw ? decodeHeader<PaymentPayload>(raw) : null;
    const v = payment ? await verifyPayment(ctx, payment, req) : null;
    if (!payment || !v?.isValid) {
      const pr: PaymentRequired = {
        x402Version: 2,
        ...(v && !v.isValid ? { error: v.invalidReason } : {}),
        resource: { url: `${ctx.cfg.publicUrl}/v1/store/${s.id}`, description: s.description, mimeType: "application/json", serviceName: s.name.slice(0, 32) },
        accepts: [req],
      };
      return c.body(JSON.stringify(pr), 402, { "content-type": "application/json", [HEADER_REQUIRED]: encodeHeader(pr) });
    }
    paid = { payment, req };
  }

  // the agent's work: forward to its endpoint, or answer with its fixed response
  let status = 200;
  let out = s.response ?? JSON.stringify({ ok: true, service: s.name });
  let contentType = "application/json";
  if (s.upstream) {
    const method = c.req.method;
    try {
      const res = await fetch(s.upstream, { method, headers: { "content-type": c.req.header("content-type") ?? "application/json" }, body: method === "GET" || method === "HEAD" ? undefined : await c.req.text() });
      status = res.status;
      contentType = res.headers.get("content-type") ?? contentType;
      out = await res.text();
    } catch {
      status = 502;
      out = JSON.stringify({ error: "upstream_unreachable", message: "The agent's service did not answer. Nothing was charged." });
    }
  }
  if (!paid) return c.body(out, status as 200, { "content-type": contentType });
  if (status >= 400) {
    recordUsage(ctx, s, paid.req, "0x0000000000000000000000000000000000000000", 0n, units, false);
    return c.body(out, status as 400, { "content-type": contentType });
  }

  const payer = lower((paid.payment.payload as { authorization?: { from: string }; purser?: { safe: string } }).authorization?.from ?? (paid.payment.payload as { purser: { safe: string } }).purser.safe);
  const settled = await settlePayment(ctx, paid.payment, paid.req, { resource: `${ctx.cfg.publicUrl}/v1/store/${s.id}`, service: s.id, category: "storefront", memo: `${s.name}${units > 1 ? ` (${units} min)` : ""}` });
  if (!settled.success) {
    recordUsage(ctx, s, paid.req, payer, 0n, units, false);
    return c.body(JSON.stringify({ error: "payment_failed", reason: settled.errorReason }), 402, { "content-type": "application/json" });
  }
  const nonce = (paid.payment.payload as { authorization?: { nonce: string }; purser?: { nonce: string } });
  const once = `${payer}:${nonce.authorization ? lower(nonce.authorization.nonce) : nonce.purser?.nonce}`;
  recordUsage(ctx, s, paid.req, payer, BigInt(paid.req.amount), units, true, settled.transaction || null, once);
  const headers: Record<string, string> = { "content-type": contentType, [HEADER_RESPONSE]: encodeHeader(settled) };
  if (s.model !== "per_call") {
    const token = `acc_${randomBytes(18).toString("base64url")}`;
    const until = now() + (s.model === "per_minute" ? units * 60 : (s.period ?? 30 * 86400));
    kvSet(ctx.db, accessKey(s.id, token), String(until));
    headers["x-purser-access"] = token;
    headers["x-purser-access-until"] = String(until);
  }
  return c.body(out, status as 200, headers);
}

function recordUsage(ctx: Ctx, s: ServiceRow, req: PaymentRequirements, payer: string, amount: bigint, units: number, delivered: boolean, tx: string | null = null, once?: string) {
  ctx.db
    .prepare("INSERT INTO service_usage (id, service_id, payer, amount, units, delivered, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id("use"), s.id, payer, amount.toString(), units, delivered ? 1 : 0, tx, now());
  const url = `${ctx.cfg.publicUrl}/v1/store/${s.id}`;
  if (delivered) recordServiceUse(ctx, url, req, payer, true, s.name, once);
  else recordFailedDelivery(ctx, url, req, s.name);
  ctx.bus.emit("receipt", s.safe, { event: "storefront.use", service: s.id, payer, amount: amount.toString(), delivered });
}

// ---------------------------------------------------------------------------------------------------- pay button

export async function paylinkInfo(ctx: Ctx, safe: Address) {
  const dep = requireDep(ctx);
  const a = await readChainAccount(ctx, safe);
  if (!a.initialized) fail(404, "not_found", "No Purser account at this address.");
  const ref = keccak256(toHex(`paylink:${safe}:${randomBytes(16).toString("hex")}`));
  tagRef(ctx, ref, { category: "storefront", memo: "Pay button", service: "paylink" });
  return {
    safe: lower(safe),
    name: accountRow(ctx, safe)?.name ?? null,
    chainId: ctx.cfg.chainId,
    module: dep.module,
    usdg: { address: dep.usdg, name: "Global Dollar", version: "1", decimals: 6 },
    ref,
    // ETH: send this from the payer's wallet with the amount as value; splits apply on arrival
    ethTx: { to: dep.module, data: encodeFunctionData({ abi: purserModuleAbi, functionName: "receiveETH", args: [safe, ref] }) },
    settleUrl: `${ctx.cfg.publicUrl}/v1/paylink/${lower(safe)}/settle`,
  };
}

registerRoutes((app: Hono, ctx: Ctx) => {
  app.post("/v1/storefront/services", async (c) => {
    const auth = agent(ctx, c, "sell");
    const b = await body(
      c,
      z.object({
        name: z.string().min(1).max(60),
        description: z.string().max(500).default(""),
        model: z.enum(["per_call", "per_minute", "subscription"]).default("per_call"),
        price: zAmount,
        token: zAddr.optional(),
        periodSeconds: z.number().int().min(3600).optional(),
        upstream: z.string().url().optional(),
        response: z.string().max(20000).optional(),
      }),
    );
    if (BigInt(b.price) === 0n) fail(400, "bad_request", "price must be above zero");
    const sid = id("svc");
    ctx.db
      .prepare("INSERT INTO services (id, safe, name, description, model, token, price, period, upstream, response, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
      .run(sid, lower(auth.safe), b.name, b.description, b.model, lower(b.token ?? requireDep(ctx).usdg), b.price, b.model === "subscription" ? (b.periodSeconds ?? 30 * 86400) : null, b.upstream ?? null, b.response ?? null, now());
    await ctx.audit.append(`agent:${lower(auth.safe)}`, "service.created", auth.safe, { service: sid, name: b.name, model: b.model, price: b.price });
    return send(c, serviceView(ctx, getService(ctx, sid)), 201);
  });
  app.patch("/v1/storefront/services/:id", async (c) => {
    const auth = agent(ctx, c, "sell");
    const s = getService(ctx, param(c, "id"));
    if (s.safe !== lower(auth.safe)) fail(403, "not_yours", "This service belongs to another account.");
    const b = await body(c, z.object({ active: z.boolean().optional(), price: zAmount.optional(), description: z.string().max(500).optional() }));
    ctx.db.prepare("UPDATE services SET active = COALESCE(?, active), price = COALESCE(?, price), description = COALESCE(?, description) WHERE id = ?").run(b.active === undefined ? null : b.active ? 1 : 0, b.price ?? null, b.description ?? null, s.id);
    return send(c, serviceView(ctx, getService(ctx, s.id)));
  });
  app.get("/v1/storefront/services", (c) => send(c, { items: listServices(ctx, c.req.query("safe")), next: null }));
  app.get("/v1/accounts/:safe/services", (c) => send(c, { items: listServices(ctx, safeParam(c)), next: null }));
  app.get("/v1/storefront/services/:id", (c) => send(c, serviceView(ctx, getService(ctx, param(c, "id")))));
  app.get("/v1/storefront/services/:id/usage", (c) => {
    const rows = ctx.db.prepare("SELECT * FROM service_usage WHERE service_id = ? ORDER BY created_at DESC LIMIT 200").all(param(c, "id")) as { payer: string; amount: string; units: number; delivered: number; tx_hash: string | null; created_at: number }[];
    const s = getService(ctx, param(c, "id"));
    return send(c, {
      service: serviceView(ctx, s),
      items: rows.map((r) => ({ payer: r.payer, money: ctx.tokens.money(s.token, BigInt(r.amount)), units: r.units, delivered: !!r.delivered, txHash: r.tx_hash, createdAt: r.created_at })),
      next: null,
    });
  });
  app.all("/v1/store/:id", (c) => serve(ctx, c, getService(ctx, param(c, "id"))));
  app.all("/v1/store/:id/*", (c) => serve(ctx, c, getService(ctx, param(c, "id"))));

  // pay button
  app.get("/embed.js", (c) => c.body(EMBED_JS.replace(/__ENGINE__/g, ctx.cfg.publicUrl), 200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300" }));
  app.get("/v1/paylink/:safe", async (c) => send(c, await paylinkInfo(ctx, safeParam(c))));
  app.post("/v1/paylink/:safe/settle", async (c) => {
    const safe = safeParam(c);
    const b = await body(c, z.object({ payload: z.any(), amount: zAmount }));
    const req: PaymentRequirements = { scheme: "exact", network: network(ctx), amount: b.amount, asset: requireDep(ctx).usdg, payTo: safe, maxTimeoutSeconds: 600, extra: { name: "Global Dollar", version: "1" } };
    const p = b.payload as PaymentPayload;
    const r = await settlePayment(ctx, p, req, { resource: `${ctx.cfg.publicUrl}/v1/paylink/${safe}`, category: "storefront", service: "paylink", memo: "Pay button" });
    return send(c, r, r.success ? 200 : 402);
  });
});

export const _parse = parseJson;
