import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { z } from "zod";
import { swapRouter02Abi } from "../../packages/sdk/src/abi.ts";
import { packSignatures, payTypedData, randomNonce, serviceId } from "../../packages/sdk/src/eip712.ts";
import type { ModelUsage, PayResult } from "../../packages/sdk/src/schema.ts";
import { decodeHeader, encodeHeader, HEADER_REQUIRED, HEADER_RESPONSE, HEADER_SIGNATURE, type PaymentPayload, type PaymentRequired, type SettleResponse } from "../../packages/sdk/src/x402.ts";
import { readChainAccount } from "./accounts.ts";
import { registerRoutes } from "./api/registry.ts";
import { agent, body, safeOwner, safeParam, send, zAddr, zAmount, zHex } from "./api/http.ts";
import { chainNow, requireDep, type Ctx } from "./ctx.ts";
import { kvGet, kvSet } from "./db.ts";
import { submitIntent } from "./intents.ts";
import { insertReceipt } from "./receipts.ts";
import { fail, id, lower, now, parseJson, sameAddress, usd, ZERO } from "./util.ts";
import { network, recordFailedDelivery, recordServiceUse } from "./x402.ts";

// ---------------------------------------------------------------------------------------------------- providers

/**
 * A model provider behind one adapter interface:
 * - "openai": OpenAI-compatible API with the owner's own key; the provider bills the owner, Purser records the cost.
 * - "x402": an OpenAI-compatible endpoint that asks for payment per request over x402 (paid from the agent's Safe).
 * - "transfer": a provider that takes a USDG transfer per request and a payment reference header (paid from the Safe).
 */
export interface Provider {
  id: string;
  kind: "openai" | "x402" | "transfer";
  baseUrl: string;
  apiKey?: string;
  payTo?: Address; // transfer providers
  models: { id: string; inputMicroPer1M: number; outputMicroPer1M: number; perRequestMicro?: number }[];
}

function dataKey(ctx: Ctx): Buffer {
  const env = process.env.PURSER_DATA_KEY;
  if (env) return Buffer.from(env, "hex");
  let k = kvGet(ctx.db, "data_key");
  if (!k) {
    k = randomBytes(32).toString("hex");
    kvSet(ctx.db, "data_key", k);
  }
  return Buffer.from(k, "hex");
}

function seal(ctx: Ctx, s: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dataKey(ctx), iv);
  const ct = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

function unseal(ctx: Ctx, s: string): string {
  const raw = Buffer.from(s, "base64");
  const d = createDecipheriv("aes-256-gcm", dataKey(ctx), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

/** Engine-wide providers from PURSER_PROVIDERS (JSON), plus providers an owner added for one account. */
export function providers(ctx: Ctx, safe: string): Provider[] {
  const global = parseJson<Provider[]>(process.env.PURSER_PROVIDERS, []);
  const own = parseJson<{ sealed: string }[]>(kvGet(ctx.db, `providers:${lower(safe)}`), []).map((p) => JSON.parse(unseal(ctx, p.sealed)) as Provider);
  return [...own, ...global];
}

export function addProvider(ctx: Ctx, safe: string, p: Provider) {
  const list = parseJson<{ id: string; sealed: string }[]>(kvGet(ctx.db, `providers:${lower(safe)}`), []).filter((x) => x.id !== p.id);
  list.push({ id: p.id, sealed: seal(ctx, JSON.stringify(p)) });
  kvSet(ctx.db, `providers:${lower(safe)}`, JSON.stringify(list));
}

function resolveModel(ctx: Ctx, safe: string, model: string): { provider: Provider; modelId: string; price: Provider["models"][number] } {
  const [pid, ...rest] = model.split("/");
  const all = providers(ctx, safe);
  for (const p of rest.length ? all.filter((x) => x.id === pid) : all) {
    const mid = rest.length ? rest.join("/") : model;
    const price = p.models.find((m) => m.id === mid);
    if (price) return { provider: p, modelId: mid, price };
  }
  return fail(404, "unknown_model", `No provider serves "${model}" for this account.`);
}

const lastUserText = (messages: { role: string; content: unknown }[]) => {
  const m = [...messages].reverse().find((x) => x.role === "user");
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
};

const allText = (messages: { role: string; content: unknown }[]) =>
  messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

export interface ChatResult {
  status: number;
  body: unknown;
  cost: { micro: bigint; paid: boolean; payment: PayResult | null };
}

/** OpenAI-compatible chat completion, paid from the agent's account within its rules. */
export async function chat(ctx: Ctx, auth: { safe: Address; session: import("viem/accounts").PrivateKeyAccount | null }, req: { model: string; messages: { role: string; content: unknown }[]; [k: string]: unknown }, meta: { taskId?: string | null }): Promise<ChatResult> {
  const dep = requireDep(ctx);
  const { provider, modelId, price } = resolveModel(ctx, auth.safe, req.model);
  const upstream = { ...req, model: modelId };
  const trigger = allText(req.messages).slice(-8000);
  let payment: PayResult | null = null;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  if (provider.kind === "transfer") {
    const amount = BigInt(price.perRequestMicro ?? 0);
    payment = await submitIntent(ctx, {
      safe: auth.safe,
      spec: { kind: "pay", pay: { token: dep.usdg, to: provider.payTo!, amount, service: `model:${provider.id}/${modelId}` } },
      category: "model",
      signer: auth.session,
      meta: { memo: `${provider.id}/${modelId}`, trigger, taskId: meta.taskId },
    });
    if (payment.intent.status !== "executed") return { status: 402, body: { error: { code: `payment_${payment.intent.status}`, message: payment.verdict.summary } }, cost: { micro: 0n, paid: false, payment } };
    headers["x-purser-payment"] = payment.intent.txHash!;
  }

  let res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers, body: JSON.stringify(upstream) });
  if (res.status === 402 && provider.kind === "x402") {
    const paid = await payX402(ctx, auth, res, { url: `${provider.baseUrl}/chat/completions`, trigger, category: "model", memo: `${provider.id}/${modelId}`, taskId: meta.taskId, service: `model:${provider.id}/${modelId}` });
    if (!paid.header) return { status: 402, body: { error: { code: "payment_refused", message: paid.reason } }, cost: { micro: 0n, paid: false, payment: paid.payment } };
    payment = paid.payment;
    res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { ...headers, [HEADER_SIGNATURE]: paid.header }, body: JSON.stringify(upstream) });
  }
  const out = (await res.json().catch(() => ({}))) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const usage: ModelUsage = { provider: provider.id, model: modelId, promptTokens: out.usage?.prompt_tokens ?? 0, completionTokens: out.usage?.completion_tokens ?? 0 };
  const tokenCost = BigInt(Math.ceil((usage.promptTokens * price.inputMicroPer1M + usage.completionTokens * price.outputMicroPer1M) / 1_000_000));
  const micro = payment?.intent.money ? BigInt(payment.intent.money.amount) : tokenCost;
  // record the call; own-key providers bill the owner directly, so the receipt has no transaction
  let receiptId = payment?.receipt?.id ?? null;
  if (!payment && res.ok) {
    const r = insertReceipt(ctx, {
      safe: auth.safe,
      direction: "out",
      category: "model",
      token: dep.usdg,
      amount: micro,
      counterparty: ZERO,
      service: `${provider.id}/${modelId}`,
      memo: `Billed by ${provider.id} to the owner's own key (no on-chain payment)`,
      status: "executed",
      taskId: meta.taskId,
      model: usage,
    });
    receiptId = r?.id ?? null;
  } else if (payment?.receipt) {
    ctx.db.prepare("UPDATE receipts SET model = ? WHERE id = ?").run(JSON.stringify(usage), payment.receipt.id);
  }
  ctx.db
    .prepare("INSERT INTO model_calls (id, safe, provider, model, prompt_tokens, completion_tokens, cost_micro, receipt_id, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id("mdl"), lower(auth.safe), provider.id, modelId, usage.promptTokens, usage.completionTokens, micro.toString(), receiptId, meta.taskId ?? null, now());
  return { status: res.status, body: { ...out, purser: { costUsd: usd(micro), receipt: receiptId, paid: !!payment } }, cost: { micro, paid: !!payment, payment } };
}

// ---------------------------------------------------------------------------------------------------- x402 fetch-and-pay

/**
 * Pays a 402 answer from the agent's account. The engine checks the rules and runs the firewall first; only then
 * it adds its firewall signature, so any facilitator can settle the signed Purser intent through the module.
 */
export async function payX402(
  ctx: Ctx,
  auth: { safe: Address; session: import("viem/accounts").PrivateKeyAccount | null },
  res402: Response,
  opts: { url: string; trigger?: string | null; maxAmount?: bigint; category?: "x402" | "model"; memo?: string; taskId?: string | null; service?: string },
): Promise<{ header: string | null; reason: string; payment: PayResult | null; requirement: PaymentRequired["accepts"][number] | null }> {
  const dep = requireDep(ctx);
  const pr = decodeHeader<PaymentRequired>(res402.headers.get(HEADER_REQUIRED)) ?? ((await res402.json().catch(() => null)) as PaymentRequired | null);
  if (!pr?.accepts?.length) return { header: null, reason: "The service asked for payment but sent no x402 requirements.", payment: null, requirement: null };
  const req = pr.accepts.find((a) => a.scheme === "exact" && a.network === network(ctx) && (sameAddress(a.asset, dep.usdg) || sameAddress(a.asset, ZERO)));
  if (!req) return { header: null, reason: "The service does not accept USDG or ETH on Robinhood Chain.", payment: null, requirement: null };
  if (opts.maxAmount !== undefined && BigInt(req.amount) > opts.maxAmount) return { header: null, reason: `The price ${req.amount} is above the most this request may pay (${opts.maxAmount}).`, payment: null, requirement: req };
  if (!auth.session) return { header: null, reason: "Paying x402 services through the engine needs an engine-held session key.", payment: null, requirement: req };

  const nonce = randomNonce();
  const deadline = BigInt((await chainNow(ctx)) + 600);
  const service = serviceId(opts.service ?? opts.url);
  const check = await submitIntent(ctx, {
    safe: auth.safe,
    spec: { kind: "pay", pay: { token: req.asset, to: req.payTo, amount: BigInt(req.amount), service } },
    category: opts.category ?? "x402",
    signer: auth.session,
    nonce,
    deadline,
    dryRun: true,
    meta: { trigger: opts.trigger, memo: opts.memo ?? `x402: ${opts.url}`, serviceRef: opts.url, taskId: opts.taskId },
  });
  if (check.verdict.decision === "block") return { header: null, reason: check.verdict.summary, payment: check, requirement: req };
  if (check.verdict.reasons.some((r) => r.code === "needs_approval" || r.code === "needs_cosign")) return { header: null, reason: "This payment needs the owner's approval first.", payment: check, requirement: req };

  const intent = { safe: auth.safe, token: req.asset, to: req.payTo, amount: BigInt(req.amount), service, nonce, deadline };
  const agentSig = await auth.session.signTypedData(payTypedData(ctx.cfg.chainId, dep.module, intent));
  const a = await readChainAccount(ctx, auth.safe);
  const fw = !sameAddress(a.config.firewall, ZERO) && ctx.chain.accounts.firewall ? await ctx.chain.accounts.firewall.sign({ hash: check.intent.digest }) : null;
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted: req,
    payload: { purser: { kind: "pay", safe: auth.safe, token: req.asset, to: req.payTo, amount: req.amount, service, nonce: nonce.toString(), deadline: deadline.toString(), signature: packSignatures(agentSig, fw) } },
  };
  // the dry-run row is replaced by the real settlement; tag it so accounting shows one payment
  ctx.db.prepare("UPDATE intents SET status = 'ready', error = 'signed for x402 settlement' WHERE id = ?").run(check.intent.id);
  return { header: encodeHeader(payload), reason: "signed", payment: check, requirement: req };
}

export async function x402Fetch(
  ctx: Ctx,
  auth: { safe: Address; session: import("viem/accounts").PrivateKeyAccount | null },
  r: { url: string; method?: string; headers?: Record<string, string>; body?: string; maxAmount?: bigint; trigger?: string | null; taskId?: string | null },
) {
  const init: RequestInit = { method: r.method ?? "GET", headers: r.headers, body: r.body };
  const first = await fetch(r.url, init);
  if (first.status !== 402) return { status: first.status, paid: false, body: await first.text(), headers: headersObject(first.headers), payment: null as PayResult | null, settlement: null as SettleResponse | null };
  const p = await payX402(ctx, auth, first, { url: r.url, trigger: r.trigger, maxAmount: r.maxAmount, taskId: r.taskId });
  if (!p.header) {
    if (p.requirement) recordServiceUse(ctx, r.url, p.requirement, lower(auth.safe), false);
    return { status: 402, paid: false, body: JSON.stringify({ error: p.reason }), headers: {}, payment: p.payment, settlement: null };
  }
  const second = await fetch(r.url, { ...init, headers: { ...(r.headers ?? {}), [HEADER_SIGNATURE]: p.header } });
  const settlement = decodeHeader<SettleResponse>(second.headers.get(HEADER_RESPONSE));
  if (!settlement?.success && second.status >= 400 && p.requirement) recordFailedDelivery(ctx, r.url, p.requirement);
  if (settlement?.success && p.requirement) {
    const purser = (decodeHeader<PaymentPayload>(p.header)?.payload as { purser?: { nonce: string } }).purser;
    recordServiceUse(ctx, r.url, p.requirement, lower(auth.safe), second.status < 400, undefined, purser ? `${lower(auth.safe)}:${purser.nonce}` : undefined);
  }
  return { status: second.status, paid: !!settlement?.success, body: await second.text(), headers: headersObject(second.headers), payment: p.payment, settlement };
}

// ---------------------------------------------------------------------------------------------------- on-chain apps

export function swapCall(ctx: Ctx, safe: Address, s: { tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint; minOut: bigint }) {
  const dep = requireDep(ctx);
  const router = dep.swapRouter ?? fail(503, "no_router", "No swap router is configured for this chain.");
  const ethIn = sameAddress(s.tokenIn, ZERO);
  const tokenIn = ethIn ? (dep.weth ?? fail(503, "no_weth", "No WETH configured.")) : s.tokenIn;
  return {
    target: router,
    value: ethIn ? s.amountIn : 0n,
    data: encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [{ tokenIn, tokenOut: s.tokenOut, fee: s.fee, recipient: safe, amountIn: s.amountIn, amountOutMinimum: s.minOut, sqrtPriceLimitX96: 0n }],
    }),
    spendToken: ethIn ? ZERO : s.tokenIn,
    spendLimit: ethIn ? 0n : s.amountIn,
  };
}

// ---------------------------------------------------------------------------------------------------- routes

const zMsg = z.object({ role: z.string(), content: z.any() }).passthrough();

registerRoutes((app: Hono, ctx: Ctx) => {
  app.get("/v1/models", (c) => {
    const auth = agent(ctx, c, "models");
    return send(c, { object: "list", data: providers(ctx, auth.safe).flatMap((p) => p.models.map((m) => ({ id: `${p.id}/${m.id}`, object: "model", owned_by: p.id }))) });
  });

  app.post("/v1/chat/completions", async (c) => {
    const auth = agent(ctx, c, "models");
    const b = await body(c, z.object({ model: z.string(), messages: z.array(zMsg).min(1) }).passthrough());
    const r = await chat(ctx, auth, b as never, { taskId: c.req.header("x-purser-task") ?? null });
    return send(c, r.body, r.status);
  });

  app.post("/v1/accounts/:safe/providers", async (c) => {
    const safe = safeParam(c);
    await safeOwner(ctx, c, safe);
    const p = await body(
      c,
      z.object({
        id: z.string().regex(/^[a-z0-9-]{1,32}$/),
        kind: z.enum(["openai", "x402", "transfer"]),
        baseUrl: z.string().url(),
        apiKey: z.string().optional(),
        payTo: zAddr.optional(),
        models: z.array(z.object({ id: z.string(), inputMicroPer1M: z.number().nonnegative(), outputMicroPer1M: z.number().nonnegative(), perRequestMicro: z.number().nonnegative().optional() })).min(1),
      }),
    );
    addProvider(ctx, safe, p as Provider);
    await ctx.audit.append("owner", "provider.added", safe, { provider: p.id, kind: p.kind, baseUrl: p.baseUrl });
    return send(c, { id: p.id, kind: p.kind, baseUrl: p.baseUrl, models: p.models }, 201);
  });

  app.get("/v1/accounts/:safe/providers", (c) => {
    const safe = safeParam(c);
    return send(c, { items: providers(ctx, safe).map(({ apiKey, ...rest }) => ({ ...rest, hasKey: !!apiKey })), next: null });
  });

  app.post("/v1/x402/fetch", async (c) => {
    const auth = agent(ctx, c, "x402");
    const b = await body(c, z.object({ url: z.string().url(), method: z.string().default("GET"), headers: z.record(z.string(), z.string()).optional(), body: z.string().optional(), maxAmount: zAmount.optional(), trigger: z.string().max(20000).optional(), taskId: z.string().optional() }));
    const r = await x402Fetch(ctx, auth, { ...b, maxAmount: b.maxAmount ? BigInt(b.maxAmount) : undefined });
    return send(c, r);
  });

  app.post("/v1/call", async (c) => {
    const auth = agent(ctx, c, "call");
    const b = await body(c, z.object({ target: zAddr, value: zAmount.default("0"), data: zHex, spendToken: zAddr.default(ZERO), spendLimit: zAmount.default("0"), memo: z.string().optional(), trigger: z.string().max(20000).optional() }));
    const res = await submitIntent(ctx, {
      safe: auth.safe,
      spec: { kind: "call", call: { target: b.target, value: BigInt(b.value), data: b.data, spendToken: b.spendToken, spendLimit: BigInt(b.spendLimit) } },
      category: "onchain",
      signer: auth.session,
      meta: { memo: b.memo, trigger: b.trigger },
    });
    return send(c, res, res.intent.status === "blocked" ? 422 : 200);
  });

  app.post("/v1/swap", async (c) => {
    const auth = agent(ctx, c, "call");
    const b = await body(c, z.object({ tokenIn: zAddr, tokenOut: zAddr, amountIn: zAmount, minOut: zAmount, fee: z.number().int().default(100), trigger: z.string().max(20000).optional() }));
    const s = swapCall(ctx, auth.safe, { tokenIn: b.tokenIn, tokenOut: b.tokenOut, fee: b.fee, amountIn: BigInt(b.amountIn), minOut: BigInt(b.minOut) });
    const res = await submitIntent(ctx, {
      safe: auth.safe,
      spec: { kind: "call", call: { target: s.target, value: s.value, data: s.data, spendToken: s.spendToken, spendLimit: s.spendLimit } },
      category: "swap",
      signer: auth.session,
      meta: { memo: `Swap ${b.amountIn} of ${b.tokenIn} for ${b.tokenOut}`, trigger: b.trigger },
    });
    return send(c, res, res.intent.status === "blocked" ? 422 : 200);
  });

  app.get("/v1/accounts/:safe/model-calls", (c) => {
    const rows = ctx.db.prepare("SELECT * FROM model_calls WHERE safe = ? ORDER BY created_at DESC LIMIT 100").all(safeParam(c));
    return send(c, { items: rows, next: null });
  });
});

export type { Hex };

function headersObject(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => (o[k] = v));
  return o;
}
