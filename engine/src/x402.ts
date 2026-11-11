import type { Hono } from "hono";
import { encodeFunctionData, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { erc20Abi, purserModuleAbi } from "../../packages/sdk/src/abi.ts";
import { payDigest, payTypedData, transferAuthorizationTypedData } from "../../packages/sdk/src/eip712.ts";
import {
  isPurserPayload,
  type ExactEvmPayload,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "../../packages/sdk/src/x402.ts";
import { readChainAccount, readRule } from "./accounts.ts";
import { body, send } from "./api/http.ts";
import { registerRoutes } from "./api/registry.ts";
import { explainRevert } from "./chain.ts";
import { chainNow, requireDep, type Ctx } from "./ctx.ts";
import { simulate } from "./firewall.ts";
import { ingestReceipt, tagRef } from "./indexer.ts";
import { submitIntent } from "./intents.ts";
import { id, lower, now, sameAddress, ZERO } from "./util.ts";

export const network = (ctx: Ctx) => `eip155:${ctx.cfg.chainId}`;

const invalid = (reason: string, payer?: Address): VerifyResponse => ({ isValid: false, invalidReason: reason, ...(payer ? { payer } : {}) });

async function isPurserAccount(ctx: Ctx, who: Address): Promise<boolean> {
  try {
    return (await readChainAccount(ctx, who)).initialized;
  } catch {
    return false;
  }
}

/** The transaction that settles an EIP-3009 payload: through the module for Purser accounts (splits apply). */
async function settlementTx(ctx: Ctx, p: ExactEvmPayload, req: PaymentRequirements, ref: Hex): Promise<{ to: Address; data: Hex; viaModule: boolean }> {
  const dep = requireDep(ctx);
  const a = p.authorization;
  const toPurser = (await isPurserAccount(ctx, req.payTo)) && (await readRule(ctx, req.payTo, req.asset)).receivable;
  if (toPurser) {
    return {
      to: dep.module,
      viaModule: true,
      data: encodeFunctionData({
        abi: purserModuleAbi,
        functionName: "receiveWithAuthorization",
        args: [req.payTo, req.asset, a.from, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, p.signature, ref, true],
      }),
    };
  }
  return {
    to: req.asset,
    viaModule: false,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transferWithAuthorization",
      args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, p.signature],
    }),
  };
}

export async function verifyPayment(ctx: Ctx, payment: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
  const dep = requireDep(ctx);
  if (payment.x402Version !== 2 && payment.x402Version !== 1) return invalid("invalid_x402_version");
  if (req.scheme !== "exact") return invalid("unsupported_scheme");
  if (req.network !== network(ctx)) return invalid("invalid_network");
  if (payment.accepted && (payment.accepted.network !== req.network || !sameAddress(payment.accepted.payTo, req.payTo) || !sameAddress(payment.accepted.asset, req.asset)))
    return invalid("invalid_payment_requirements");

  if (isPurserPayload(payment.payload)) {
    const p = payment.payload.purser;
    if (!sameAddress(p.to, req.payTo)) return invalid("invalid_exact_evm_payload_recipient_mismatch", p.safe);
    if (!sameAddress(p.token, req.asset)) return invalid("invalid_exact_evm_payload_asset_mismatch", p.safe);
    if (BigInt(p.amount) < BigInt(req.amount)) return invalid("invalid_exact_evm_payload_authorization_value", p.safe);
    if (BigInt(p.deadline) < BigInt(await chainNow(ctx))) return invalid("invalid_exact_evm_payload_authorization_valid_before", p.safe);
    const a = await readChainAccount(ctx, p.safe).catch(() => null);
    if (!a?.initialized) return invalid("payer_not_a_purser_account", p.safe);
    const signer = await recoverTypedDataAddress({
      ...payTypedData(ctx.cfg.chainId, dep.module, { safe: p.safe, token: p.token, to: p.to, amount: BigInt(p.amount), service: p.service, nonce: BigInt(p.nonce), deadline: BigInt(p.deadline) }),
      signature: p.signature.slice(0, 132) as Hex, // agent first; a firewall signature may follow
    });
    if (!sameAddress(signer, a.config.agent)) return invalid("invalid_exact_evm_payload_signature", p.safe);
    if (a.frozen) return invalid("payer_frozen", p.safe);
    const used = await ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "nonceUsed", args: [p.safe, BigInt(p.nonce)] });
    if (used) return invalid("nonce_already_used", p.safe);
    return { isValid: true, payer: lower(p.safe) };
  }

  const p = payment.payload as ExactEvmPayload;
  const a = p.authorization;
  if (!a || !p.signature) return invalid("invalid_payload");
  if (sameAddress(req.asset, ZERO)) return invalid("eth_needs_purser_payload", a.from);
  if (!sameAddress(a.to, req.payTo)) return invalid("invalid_exact_evm_payload_recipient_mismatch", a.from);
  if (BigInt(a.value) < BigInt(req.amount)) return invalid("invalid_exact_evm_payload_authorization_value", a.from);
  const t = await chainNow(ctx);
  if (BigInt(a.validBefore) <= BigInt(t + 3)) return invalid("invalid_exact_evm_payload_authorization_valid_before", a.from);
  if (BigInt(a.validAfter) > BigInt(t)) return invalid("invalid_exact_evm_payload_authorization_valid_after", a.from);
  const signer = await recoverTypedDataAddress({
    ...transferAuthorizationTypedData(ctx.cfg.chainId, req.asset, req.extra?.name ?? "Global Dollar", req.extra?.version ?? "1", {
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    }),
    signature: p.signature,
  }).catch(() => null);
  if (!signer || !sameAddress(signer, a.from)) return invalid("invalid_exact_evm_payload_signature", a.from);
  const used = await ctx.chain.pub.readContract({ address: req.asset, abi: erc20Abi, functionName: "authorizationState", args: [a.from, a.nonce] }).catch(() => false);
  if (used) return invalid("nonce_already_used", a.from);
  const bal = await ctx.chain.pub.readContract({ address: req.asset, abi: erc20Abi, functionName: "balanceOf", args: [a.from] });
  if (bal < BigInt(a.value)) return invalid("insufficient_funds", a.from);
  const tx = await settlementTx(ctx, p, req, `0x${"0".repeat(64)}`);
  const sim = await simulate(ctx, { from: ctx.chain.accounts.relayer?.address ?? a.from, to: tx.to, data: tx.data });
  if (!sim.success) return invalid("settlement_would_fail", a.from);
  return { isValid: true, payer: lower(a.from) };
}

export async function settlePayment(ctx: Ctx, payment: PaymentPayload, req: PaymentRequirements, meta: { resource?: string; service?: string; category?: string; memo?: string } = {}): Promise<SettleResponse> {
  const net = network(ctx);
  const v = await verifyPayment(ctx, payment, req);
  if (!v.isValid) return { success: false, errorReason: v.invalidReason, payer: v.payer, transaction: "", network: net };
  const sid = id("x4s");
  const resource = meta.resource ?? payment.resource?.url ?? null;

  if (isPurserPayload(payment.payload)) {
    const p = payment.payload.purser;
    ctx.db.prepare("INSERT INTO x402_settlements (id, payer, pay_to, asset, amount, nonce, resource, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'purser', 'pending', ?)").run(sid, lower(p.safe), lower(req.payTo), lower(req.asset), p.amount, p.nonce, resource, now());
    // when this engine's own x402 client signed it, keep the category and notes it recorded (e.g. a model call)
    const dep = requireDep(ctx);
    const digest = payDigest(ctx.cfg.chainId, dep.module, { safe: p.safe, token: p.token, to: p.to, amount: BigInt(p.amount), service: p.service, nonce: BigInt(p.nonce), deadline: BigInt(p.deadline) });
    const prior = ctx.db.prepare("SELECT category, meta FROM intents WHERE digest = ? AND status = 'ready' LIMIT 1").get(lower(digest)) as { category: string; meta: string } | undefined;
    const res = await submitIntent(ctx, {
      safe: p.safe,
      spec: { kind: "pay", pay: { token: p.token, to: p.to, amount: BigInt(p.amount), service: p.service } },
      category: (prior?.category ?? "x402") as "x402",
      signature: p.signature.slice(0, 132) as Hex,
      nonce: BigInt(p.nonce),
      deadline: BigInt(p.deadline),
      meta: { serviceRef: resource, memo: resource ? `x402: ${resource}` : "x402 payment", ...(prior ? JSON.parse(prior.meta) : {}) },
    });
    const ok = res.intent.status === "executed";
    ctx.db.prepare("UPDATE x402_settlements SET status = ?, tx_hash = ?, error = ? WHERE id = ?").run(ok ? "settled" : "failed", res.intent.txHash, ok ? null : (res.intent.error ?? res.intent.status), sid);
    if (resource) recordServiceUse(ctx, resource, req, lower(p.safe), ok, undefined, `${lower(p.safe)}:${p.nonce}`);
    return ok
      ? { success: true, payer: lower(p.safe), transaction: res.intent.txHash!, network: net, amount: p.amount }
      : { success: false, errorReason: res.intent.status === "queued" ? "needs_owner_approval" : res.intent.status === "blocked" ? "blocked_by_firewall" : "settlement_failed", payer: lower(p.safe), transaction: "", network: net };
  }

  const p = payment.payload as ExactEvmPayload;
  const a = p.authorization;
  const relayer = ctx.chain.accounts.relayer;
  if (!relayer || !ctx.chain.broadcast) return { success: false, errorReason: "facilitator_cannot_broadcast", payer: lower(a.from), transaction: "", network: net };
  const ref = a.nonce;
  tagRef(ctx, ref, { category: meta.category ?? "x402", service: meta.service ?? null, memo: meta.memo ?? (resource ? `x402: ${resource}` : "x402 payment"), customer: lower(a.from) });
  try {
    ctx.db.prepare("INSERT INTO x402_settlements (id, payer, pay_to, asset, amount, nonce, resource, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'eip3009', 'pending', ?)").run(sid, lower(a.from), lower(req.payTo), lower(req.asset), a.value, lower(a.nonce), resource, now());
  } catch {
    return { success: false, errorReason: "nonce_already_used", payer: lower(a.from), transaction: "", network: net };
  }
  const tx = await settlementTx(ctx, p, req, ref);
  try {
    const r = await ctx.chain.send(relayer, { to: tx.to, data: tx.data });
    if (r.status !== "success") throw new Error("reverted");
    await ingestReceipt(ctx, r);
    ctx.db.prepare("UPDATE x402_settlements SET status = 'settled', tx_hash = ? WHERE id = ?").run(lower(r.transactionHash), sid);
    if (resource) recordServiceUse(ctx, resource, req, lower(a.from), true, undefined, `${lower(a.from)}:${lower(a.nonce)}`);
    await ctx.audit.append("facilitator", "x402.settled", tx.viaModule ? req.payTo : null, { settlement: sid, payer: a.from, payTo: req.payTo, amount: a.value, tx: r.transactionHash });
    return { success: true, payer: lower(a.from), transaction: r.transactionHash, network: net, amount: a.value };
  } catch (e) {
    ctx.db.prepare("UPDATE x402_settlements SET status = 'failed', error = ? WHERE id = ?").run(explainRevert(e), sid);
    return { success: false, errorReason: "settlement_failed", payer: lower(a.from), transaction: "", network: net };
  }
}

/** Every x402 resource paid through Purser feeds the service directory (18.1). */
export function recordServiceUse(ctx: Ctx, url: string, req: PaymentRequirements, payer: string, delivered: boolean, name?: string, once?: string) {
  // the engine's own x402 client and its facilitator can both see one payment: count it once
  if (once && !ctx.db.prepare("INSERT OR IGNORE INTO seen_logs (uniq) VALUES (?)").run(`svcuse:${once}`).changes) {
    if (!delivered) ctx.db.prepare("UPDATE x402_services SET delivered = MAX(delivered - 1, 0), failed = failed + 1 WHERE url = ?").run(url);
    return;
  }
  const row = ctx.db.prepare("SELECT payers FROM x402_services WHERE url = ?").get(url) as { payers: string } | undefined;
  const payers = new Set<string>(row ? JSON.parse(row.payers) : []);
  payers.add(payer);
  ctx.db
    .prepare(
      `INSERT INTO x402_services (url, pay_to, name, asset, price, uses, payers, delivered, failed, last_used) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET uses = uses + 1, payers = excluded.payers, delivered = delivered + excluded.delivered,
       failed = failed + excluded.failed, last_used = excluded.last_used, price = excluded.price`,
    )
    .run(url, lower(req.payTo), name ?? hostOf(url), lower(req.asset), req.amount, JSON.stringify([...payers]), delivered ? 1 : 0, delivered ? 0 : 1, now());
}

/** A request that reached a paid service but was not delivered (and so not charged): lowers its delivery rate. */
export function recordFailedDelivery(ctx: Ctx, url: string, req: PaymentRequirements, name?: string) {
  ctx.db
    .prepare(
      `INSERT INTO x402_services (url, pay_to, name, asset, price, uses, payers, delivered, failed, last_used) VALUES (?, ?, ?, ?, ?, 0, '[]', 0, 1, ?)
       ON CONFLICT(url) DO UPDATE SET failed = failed + 1, last_used = excluded.last_used`,
    )
    .run(url, lower(req.payTo), name ?? hostOf(url), lower(req.asset), req.amount, now());
}

const hostOf = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname === "/" ? "" : x.pathname}`;
  } catch {
    return u;
  }
};

export function supported(ctx: Ctx) {
  return {
    kinds: [{ x402Version: 2, scheme: "exact", network: network(ctx), extra: { assets: ctx.dep ? [ctx.dep.usdg, ZERO] : [], purserIntents: true } }],
    extensions: [],
    signers: { "eip155:*": ctx.chain.accounts.relayer ? [ctx.chain.accounts.relayer.address] : [] },
  };
}

const zReq = z.object({
  scheme: z.literal("exact"),
  network: z.string(),
  amount: z.string(),
  asset: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().default(120),
  extra: z.record(z.string(), z.unknown()).optional(),
});
const zBody = z.object({ x402Version: z.number().optional(), paymentPayload: z.any(), paymentRequirements: zReq });

registerRoutes((app: Hono, ctx: Ctx) => {
  app.get("/x402/supported", (c) => send(c, supported(ctx)));
  app.post("/x402/verify", async (c) => {
    const b = await body(c, zBody);
    return send(c, await verifyPayment(ctx, b.paymentPayload, b.paymentRequirements as PaymentRequirements));
  });
  app.post("/x402/settle", async (c) => {
    const b = await body(c, zBody);
    return send(c, await settlePayment(ctx, b.paymentPayload, b.paymentRequirements as PaymentRequirements));
  });
  app.get("/v1/x402/settlements", (c) => {
    const rows = ctx.db.prepare("SELECT * FROM x402_settlements ORDER BY created_at DESC LIMIT ?").all(Number(c.req.query("limit") ?? 50));
    return send(c, { items: rows, next: null });
  });
});
