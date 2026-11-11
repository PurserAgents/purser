import type { Context, Hono } from "hono";
import { decodeEventLog, encodeFunctionData, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";
import { purserRecurringAbi } from "../../packages/sdk/src/abi.ts";
import { agentOpDigest, agentOpTypedData, packSignatures, randomNonce } from "../../packages/sdk/src/eip712.ts";
import type { PayResult, Stream, Subscription } from "../../packages/sdk/src/schema.ts";
import { readRule } from "./accounts.ts";
import { registerRoutes } from "./api/registry.ts";
import { agent, body, param, safeParam, send, zAddr, zAmount, zHex } from "./api/http.ts";
import { explainRevert } from "./chain.ts";
import { chainNow, requireDep, type Ctx } from "./ctx.ts";
import { registerTask } from "./engine.ts";
import { evaluate } from "./firewall.ts";
import { ingestReceipt, onExtension, tagTx } from "./indexer.ts";
import { resumers } from "./intents.ts";
import { checkPolicy } from "./policy.ts";
import { getIntentRow, setIntent } from "./receipts.ts";
import { fail, id, json, lower, now, parseJson } from "./util.ts";

// ---------------------------------------------------------------------------------------------------- state from chain

async function syncStream(ctx: Ctx, sid: bigint) {
  const dep = requireDep(ctx);
  const s = await ctx.chain.pub.readContract({ address: dep.recurring, abi: purserRecurringAbi, functionName: "streams", args: [sid] });
  const [safe, payee, token, rate, start, end, settledUntil, lastBeat, grace] = s;
  const existing = ctx.db.prepare("SELECT paid, stopped, created_at FROM streams WHERE id = ?").get(sid.toString()) as { paid: string; stopped: number; created_at: number } | undefined;
  ctx.db
    .prepare(
      `INSERT INTO streams (id, safe, payee, token, rate, start, end_at, settled_until, last_beat, grace, paid, stopped, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET end_at = excluded.end_at, settled_until = excluded.settled_until, last_beat = excluded.last_beat`,
    )
    .run(sid.toString(), lower(safe), lower(payee), lower(token), rate.toString(), Number(start), Number(end), Number(settledUntil), Number(lastBeat), Number(grace), existing?.paid ?? "0", existing?.stopped ?? 0, existing?.created_at ?? now());
}

async function syncSubscription(ctx: Ctx, sid: bigint) {
  const dep = requireDep(ctx);
  const s = await ctx.chain.pub.readContract({ address: dep.recurring, abi: purserRecurringAbi, functionName: "subscriptions", args: [sid] });
  const [safe, payee, token, amount, period, nextDue, chargesLeft, active] = s;
  const existing = ctx.db.prepare("SELECT charged, created_at FROM subscriptions WHERE id = ?").get(sid.toString()) as { charged: number; created_at: number } | undefined;
  ctx.db
    .prepare(
      `INSERT INTO subscriptions (id, safe, payee, token, amount, period, next_due, charges_left, charged, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET next_due = excluded.next_due, charges_left = excluded.charges_left, active = excluded.active`,
    )
    .run(sid.toString(), lower(safe), lower(payee), lower(token), amount.toString(), Number(period), Number(nextDue), Number(chargesLeft), existing?.charged ?? 0, active ? 1 : 0, existing?.created_at ?? now());
}

onExtension(async (ctx, source, ev) => {
  if (source !== "recurring") return;
  const a = ev.args as Record<string, bigint>;
  switch (ev.eventName) {
    case "StreamCreated":
    case "Heartbeat":
      await syncStream(ctx, a.id);
      break;
    case "StreamSettled":
      await syncStream(ctx, a.id);
      ctx.db.prepare("UPDATE streams SET paid = CAST(CAST(paid AS INTEGER) + ? AS TEXT) WHERE id = ?").run(a.amount, a.id.toString());
      break;
    case "StreamStopped":
      await syncStream(ctx, a.id);
      ctx.db.prepare("UPDATE streams SET stopped = 1 WHERE id = ?").run(a.id.toString());
      break;
    case "SubscriptionCreated":
    case "SubscriptionCancelled":
      await syncSubscription(ctx, a.id);
      break;
    case "SubscriptionCharged":
      await syncSubscription(ctx, a.id);
      ctx.db.prepare("UPDATE subscriptions SET charged = charged + 1 WHERE id = ?").run(a.id.toString());
      break;
  }
});

// ---------------------------------------------------------------------------------------------------- views

interface StreamRow {
  id: string;
  safe: string;
  payee: string;
  token: string;
  rate: string;
  start: number;
  end_at: number;
  settled_until: number;
  last_beat: number;
  grace: number;
  paid: string;
  stopped: number;
}

export { chainNow };

export function streamView(ctx: Ctx, r: StreamRow, t = now()): Stream {
  const until = Math.min(t, r.end_at, r.last_beat + r.grace);
  const accrued = until > r.settled_until ? BigInt(until - r.settled_until) * BigInt(r.rate) : 0n;
  const status: Stream["status"] = r.stopped ? "stopped" : t >= r.end_at ? "ended" : r.last_beat + r.grace < t ? "stalled" : "active";
  return {
    id: r.id,
    safe: r.safe as Address,
    payee: r.payee as Address,
    token: ctx.tokens.infoSync(r.token),
    ratePerSecond: r.rate,
    start: r.start,
    end: r.end_at,
    settledUntil: r.settled_until,
    lastBeat: r.last_beat,
    grace: r.grace,
    status,
    accrued: ctx.tokens.money(r.token, accrued),
    paid: ctx.tokens.money(r.token, BigInt(r.paid)),
  };
}

interface SubRow {
  id: string;
  safe: string;
  payee: string;
  token: string;
  amount: string;
  period: number;
  next_due: number;
  charges_left: number;
  charged: number;
  active: number;
}

export const subscriptionView = (ctx: Ctx, r: SubRow): Subscription => ({
  id: r.id,
  safe: r.safe as Address,
  payee: r.payee as Address,
  token: ctx.tokens.infoSync(r.token),
  amount: ctx.tokens.money(r.token, BigInt(r.amount)),
  periodSeconds: r.period,
  nextDue: r.next_due,
  chargesLeft: r.charges_left,
  active: !!r.active,
  charged: r.charged,
});

export async function listStreams(ctx: Ctx, opts: { safe?: string; payee?: string }) {
  const t = await chainNow(ctx);
  const rows = ctx.db
    .prepare(`SELECT * FROM streams WHERE (? IS NULL OR safe = ?) AND (? IS NULL OR payee = ?) ORDER BY created_at DESC`)
    .all(opts.safe ?? null, opts.safe ? lower(opts.safe) : null, opts.payee ?? null, opts.payee ? lower(opts.payee) : null) as StreamRow[];
  return rows.map((r) => streamView(ctx, r, t));
}

export function listSubscriptions(ctx: Ctx, opts: { safe?: string; payee?: string }) {
  const rows = ctx.db
    .prepare(`SELECT * FROM subscriptions WHERE (? IS NULL OR safe = ?) AND (? IS NULL OR payee = ?) ORDER BY created_at DESC`)
    .all(opts.safe ?? null, opts.safe ? lower(opts.safe) : null, opts.payee ?? null, opts.payee ? lower(opts.payee) : null) as SubRow[];
  return rows.map((r) => subscriptionView(ctx, r));
}

// ---------------------------------------------------------------------------------------------------- create (agent-signed)

type Op =
  | { kind: "stream"; payee: Address; token: Address; rate: bigint; maxDuration: bigint; grace: number }
  | { kind: "subscription"; payee: Address; token: Address; amount: bigint; period: bigint; maxCharges: number };

async function opHashOf(ctx: Ctx, op: Op): Promise<{ opHash: Hex; total: bigint }> {
  const dep = requireDep(ctx);
  if (op.kind === "stream") {
    const opHash = await ctx.chain.pub.readContract({ address: dep.recurring, abi: purserRecurringAbi, functionName: "streamOpHash", args: [op.payee, op.token, op.rate, op.maxDuration, BigInt(op.grace)] });
    return { opHash, total: op.rate * op.maxDuration };
  }
  const opHash = await ctx.chain.pub.readContract({ address: dep.recurring, abi: purserRecurringAbi, functionName: "subscriptionOpHash", args: [op.payee, op.token, op.amount, op.period, BigInt(op.maxCharges)] });
  return { opHash, total: op.amount * BigInt(op.maxCharges) };
}

function createData(op: Op, safe: Address, nonce: bigint, deadline: bigint, sigs: Hex): Hex {
  return op.kind === "stream"
    ? encodeFunctionData({ abi: purserRecurringAbi, functionName: "createStream", args: [safe, op.payee, op.token, op.rate, op.maxDuration, op.grace, nonce, deadline, sigs] })
    : encodeFunctionData({ abi: purserRecurringAbi, functionName: "createSubscription", args: [safe, op.payee, op.token, op.amount, op.period, op.maxCharges, nonce, deadline, sigs] });
}

const opJson = (op: Op) => json(op);
const opFrom = (s: string): Op => {
  const o = JSON.parse(s);
  return o.kind === "stream"
    ? { ...o, rate: BigInt(o.rate), maxDuration: BigInt(o.maxDuration) }
    : { ...o, amount: BigInt(o.amount), period: BigInt(o.period) };
};

export async function createRecurring(ctx: Ctx, safe: Address, signer: PrivateKeyAccount | null, op: Op, meta: { trigger?: string | null; memo?: string | null } = {}): Promise<PayResult & { streamId?: string; subscriptionId?: string }> {
  const dep = requireDep(ctx);
  if (!signer) fail(400, "no_session_key", "Creating streams and subscriptions through the engine needs an engine-held session key.");
  const { opHash, total } = await opHashOf(ctx, op);
  const nonce = randomNonce();
  const deadline = BigInt((await chainNow(ctx)) + 15 * 60);
  const msg = { safe, extension: dep.recurring, opHash, token: op.token, amount: total, nonce, deadline };
  const digest = agentOpDigest(ctx.cfg.chainId, dep.module, msg);
  const agentSig = await signer!.signTypedData(agentOpTypedData(ctx.cfg.chainId, dep.module, msg));
  const first = op.kind === "stream" ? op.rate * 60n : op.amount;
  const policy = await checkPolicy(ctx, safe, [{ token: op.token, amount: first, to: op.payee }]);
  const rule = await readRule(ctx, safe, op.token);
  policy.needsApproval = total > rule.approvalAbove;
  policy.needsCosign = !!policy.cosigner && total > rule.cosignAbove;
  if (policy.needsCosign) policy.reasons.push({ code: "cosign_unsupported", severity: "block", title: "Needs a second signer", detail: "Streams and subscriptions above the co-sign threshold need the co-signer; create it from the owner app." });
  const fwSig = policy.firewall && ctx.chain.accounts.firewall ? await ctx.chain.accounts.firewall.sign({ hash: digest }) : null;
  const sigs = packSignatures(agentSig, fwSig);
  const iid = id("int");
  const summary = op.kind === "stream" ? `Stream to ${op.payee.slice(0, 8)}... for up to ${op.maxDuration}s` : `Subscription to ${op.payee.slice(0, 8)}... every ${op.period}s`;
  ctx.db
    .prepare(`INSERT INTO intents (id, safe, kind, digest, payload, sigs, status, summary, token, amount, to_addr, category, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'checking', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(iid, lower(safe), op.kind, lower(digest), json({ op: opJson(op), nonce, deadline }), sigs, summary, lower(op.token), total.toString(), lower(op.payee), op.kind, json(meta), now(), now());
  const data = createData(op, safe, nonce, deadline, sigs);
  const { verdict } = await evaluate(ctx, {
    safe,
    kind: op.kind,
    to: op.payee,
    token: op.token,
    amount: first,
    tx: { from: ctx.chain.accounts.relayer?.address ?? safe, to: dep.recurring, data },
    policy,
    trigger: meta.trigger,
    intentId: iid,
    category: op.kind,
  });
  if (verdict.decision === "block") {
    const intent = setIntent(ctx, iid, { status: "blocked", verdict_id: verdict.id, error: verdict.summary })!;
    return { intent, verdict, receipt: null };
  }
  setIntent(ctx, iid, { verdict_id: verdict.id });
  return sendCreate(ctx, iid, op, data, verdict);
}

async function sendCreate(ctx: Ctx, iid: string, op: Op, data: Hex, verdict: PayResult["verdict"]): Promise<PayResult & { streamId?: string; subscriptionId?: string }> {
  const dep = requireDep(ctx);
  if (!ctx.chain.broadcast) return { intent: setIntent(ctx, iid, { status: "ready" })!, verdict, receipt: null };
  try {
    const r = await ctx.chain.send(ctx.chain.accounts.relayer!, { to: dep.recurring, data });
    if (r.status !== "success") throw new Error("reverted");
    setIntent(ctx, iid, { tx_hash: lower(r.transactionHash) });
    tagTx(ctx, r.transactionHash, op.kind);
    await ingestReceipt(ctx, r);
    let createdId: bigint | null = null;
    for (const l of r.logs) {
      try {
        const ev = decodeEventLog({ abi: purserRecurringAbi, data: l.data, topics: l.topics });
        if (ev.eventName === "StreamCreated" || ev.eventName === "SubscriptionCreated") createdId = (ev.args as { id: bigint }).id;
      } catch {
        /* other contracts */
      }
    }
    const intent = setIntent(ctx, iid, { status: createdId ? "executed" : "queued" })!;
    await ctx.audit.append(`agent:${intent.safe}`, `${op.kind}.${createdId ? "created" : "queued"}`, intent.safe, { intent: iid, id: createdId?.toString() ?? null });
    return { intent, verdict, receipt: null, ...(op.kind === "stream" ? { streamId: createdId?.toString() } : { subscriptionId: createdId?.toString() }) };
  } catch (e) {
    return { intent: setIntent(ctx, iid, { status: "failed", error: explainRevert(e) })!, verdict, receipt: null };
  }
}

for (const kind of ["stream", "subscription"] as const) {
  resumers[kind] = async (ctx, iid) => {
    const row = getIntentRow(ctx, iid) ?? fail(404, "not_found", "No such intent.");
    const p = parseJson<{ op: string; nonce: string; deadline: string }>(row.payload, { op: "{}", nonce: "0", deadline: "0" });
    const op = opFrom(p.op);
    const claimed = ctx.db.prepare("UPDATE intents SET status = 'submitted', updated_at = ? WHERE id = ? AND status IN ('approved','queued')").run(now(), iid);
    if (!claimed.changes) fail(409, "busy", "This intent is already being sent.");
    const data = createData(op, row.safe as Address, BigInt(p.nonce), BigInt(p.deadline), row.sigs as Hex);
    const verdict = { id: row.verdict_id ?? "", safe: row.safe as Address, intentId: iid, decision: "allow" as const, summary: "Approved by the owner.", reasons: [], simulation: null, trigger: null, createdAt: now() };
    return sendCreate(ctx, iid, op, data, verdict);
  };
}

// ---------------------------------------------------------------------------------------------------- scheduler

async function relay(ctx: Ctx, data: Hex, category: string) {
  const dep = requireDep(ctx);
  const r = await ctx.chain.send(ctx.chain.accounts.relayer!, { to: dep.recurring, data });
  if (r.status !== "success") throw new Error("reverted");
  tagTx(ctx, r.transactionHash, category);
  await ingestReceipt(ctx, r);
  return r;
}

/** Settles every stream with something due. A settlement the rules refuse leaves the stream unpaid (and visible). */
export async function settleStreams(ctx: Ctx) {
  if (!ctx.chain.broadcast) return 0;
  let n = 0;
  const dep = requireDep(ctx);
  for (const s of await listStreams(ctx, {})) {
    if (s.status === "stopped" && BigInt(s.accrued.amount) === 0n) continue;
    const [due] = await ctx.chain.pub.readContract({ address: dep.recurring, abi: purserRecurringAbi, functionName: "accrued", args: [BigInt(s.id)] });
    if (due === 0n) continue;
    try {
      await relay(ctx, encodeFunctionData({ abi: purserRecurringAbi, functionName: "settle", args: [BigInt(s.id)] }), "stream");
      n++;
    } catch (e) {
      ctx.bus.emit("stream", s.safe, { event: "settle_failed", id: s.id, reason: explainRevert(e) });
    }
  }
  return n;
}

export async function chargeSubscriptions(ctx: Ctx) {
  if (!ctx.chain.broadcast) return 0;
  let n = 0;
  const due = ctx.db.prepare("SELECT id, safe FROM subscriptions WHERE active = 1 AND charges_left > 0 AND next_due <= ?").all(await chainNow(ctx)) as { id: string; safe: string }[];
  for (const s of due) {
    try {
      await relay(ctx, encodeFunctionData({ abi: purserRecurringAbi, functionName: "charge", args: [BigInt(s.id)] }), "subscription");
      n++;
    } catch (e) {
      ctx.bus.emit("subscription", s.safe, { event: "charge_failed", id: s.id, reason: explainRevert(e) });
    }
  }
  return n;
}

registerTask({ name: "streams", every: 15000, run: settleStreams });
registerTask({ name: "subscriptions", every: 30000, run: chargeSubscriptions });

// ---------------------------------------------------------------------------------------------------- routes

/** Stream and subscription ids are the contract's numeric ids; anything else is a bad request, not a crash. */
function numId(c: Context): bigint {
  const v = param(c, "id");
  if (!/^\d{1,78}$/.test(v)) fail(400, "bad_request", "id must be a number");
  return BigInt(v);
}

registerRoutes((app: Hono, ctx: Ctx) => {
  app.post("/v1/streams", async (c) => {
    const auth = agent(ctx, c, "recurring");
    const b = await body(c, z.object({ payee: zAddr, token: zAddr.optional(), ratePerSecond: zAmount, maxDurationSeconds: z.number().int().positive(), graceSeconds: z.number().int().positive().default(120), trigger: z.string().optional() }));
    const r = await createRecurring(ctx, auth.safe, auth.session, { kind: "stream", payee: b.payee, token: b.token ?? requireDep(ctx).usdg, rate: BigInt(b.ratePerSecond), maxDuration: BigInt(b.maxDurationSeconds), grace: b.graceSeconds }, { trigger: b.trigger });
    return send(c, r, r.intent.status === "blocked" ? 422 : 200);
  });
  app.get("/v1/accounts/:safe/streams", async (c) => send(c, { items: await listStreams(ctx, { safe: safeParam(c) }), next: null }));
  app.get("/v1/streams", async (c) => send(c, { items: await listStreams(ctx, { payee: c.req.query("payee") }), next: null }));
  app.get("/v1/streams/:id", async (c) => {
    const r = ctx.db.prepare("SELECT * FROM streams WHERE id = ?").get(param(c, "id")) as StreamRow | undefined;
    return send(c, r ? streamView(ctx, r, await chainNow(ctx)) : fail(404, "not_found", "No such stream."));
  });
  app.post("/v1/streams/:id/heartbeat", async (c) => {
    const b = await body(c, z.object({ upTo: z.number().int(), signature: zHex }));
    const r = await relay(ctx, encodeFunctionData({ abi: purserRecurringAbi, functionName: "heartbeat", args: [numId(c), BigInt(b.upTo), b.signature] }), "stream").catch((e) => fail(400, "heartbeat_refused", explainRevert(e)));
    return send(c, { txHash: r.transactionHash });
  });
  app.post("/v1/streams/:id/settle", async (c) => {
    const r = await relay(ctx, encodeFunctionData({ abi: purserRecurringAbi, functionName: "settle", args: [numId(c)] }), "stream").catch((e) => fail(400, "settle_refused", explainRevert(e)));
    return send(c, { txHash: r.transactionHash });
  });
  app.post("/v1/streams/:id/stop", async (c) => {
    const auth = agent(ctx, c, "recurring");
    return send(c, await stopByAgent(ctx, auth, 1, param(c, "id")));
  });
  app.post("/v1/streams/:id/stop/prepare", (c) => send(c, prepareStop(ctx, 1, String(numId(c)))));

  app.post("/v1/subscriptions", async (c) => {
    const auth = agent(ctx, c, "recurring");
    const b = await body(c, z.object({ payee: zAddr, token: zAddr.optional(), amount: zAmount, periodSeconds: z.number().int().min(3600), maxCharges: z.number().int().min(1).max(1000), trigger: z.string().optional() }));
    const r = await createRecurring(ctx, auth.safe, auth.session, { kind: "subscription", payee: b.payee, token: b.token ?? requireDep(ctx).usdg, amount: BigInt(b.amount), period: BigInt(b.periodSeconds), maxCharges: b.maxCharges }, { trigger: b.trigger });
    return send(c, r, r.intent.status === "blocked" ? 422 : 200);
  });
  app.get("/v1/accounts/:safe/subscriptions", (c) => send(c, { items: listSubscriptions(ctx, { safe: safeParam(c) }), next: null }));
  app.get("/v1/subscriptions", (c) => send(c, { items: listSubscriptions(ctx, { payee: c.req.query("payee") }), next: null }));
  app.post("/v1/subscriptions/:id/cancel", async (c) => {
    const auth = agent(ctx, c, "recurring");
    return send(c, await stopByAgent(ctx, auth, 2, param(c, "id")));
  });
  app.post("/v1/subscriptions/:id/cancel/prepare", (c) => send(c, prepareStop(ctx, 2, String(numId(c)))));
});

/** The owner (or the payee) stops directly from a wallet: no signature, the contract checks msg.sender. */
function prepareStop(ctx: Ctx, kind: 1 | 2, sid: string) {
  const dep = requireDep(ctx);
  return {
    chainId: ctx.cfg.chainId,
    to: dep.recurring,
    data: kind === 1
      ? encodeFunctionData({ abi: purserRecurringAbi, functionName: "stopStream", args: [BigInt(sid), 0n, 0n, "0x"] })
      : encodeFunctionData({ abi: purserRecurringAbi, functionName: "cancelSubscription", args: [BigInt(sid), 0n, 0n, "0x"] }),
    value: "0",
    description: kind === 1 ? "Stop this stream now." : "Cancel this subscription.",
  };
}

async function stopByAgent(ctx: Ctx, auth: { safe: Address; session: PrivateKeyAccount | null }, kind: 1 | 2, sid: string) {
  const dep = requireDep(ctx);
  if (!auth.session) fail(400, "no_session_key", "Needs an engine-held session key.");
  const table = kind === 1 ? "streams" : "subscriptions";
  const row = ctx.db.prepare(`SELECT safe, token FROM ${table} WHERE id = ?`).get(sid) as { safe: string; token: Address } | undefined;
  if (!row || row.safe !== lower(auth.safe)) fail(404, "not_found", "Not this account's.");
  const typehash = await ctx.chain.pub.readContract({ address: dep.recurring, abi: [{ type: "function", name: "STOP_TYPEHASH", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" }], functionName: "STOP_TYPEHASH" });
  const { encodeAbiParameters, keccak256 } = await import("viem");
  const opHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], [typehash, BigInt(kind), BigInt(sid)]));
  const nonce = randomNonce();
  const deadline = BigInt((await chainNow(ctx)) + 600);
  const msg = { safe: auth.safe, extension: dep.recurring, opHash, token: row!.token, amount: 0n, nonce, deadline };
  const agentSig = await auth.session!.signTypedData(agentOpTypedData(ctx.cfg.chainId, dep.module, msg));
  const fwSig = ctx.chain.accounts.firewall ? await ctx.chain.accounts.firewall.sign({ hash: agentOpDigest(ctx.cfg.chainId, dep.module, msg) }) : null;
  const acct = await import("./accounts.ts").then((m) => m.readChainAccount(ctx, auth.safe));
  const sigs = packSignatures(agentSig, acct.config.firewall !== "0x0000000000000000000000000000000000000000" ? fwSig : null);
  const data = kind === 1
    ? encodeFunctionData({ abi: purserRecurringAbi, functionName: "stopStream", args: [BigInt(sid), nonce, deadline, sigs] })
    : encodeFunctionData({ abi: purserRecurringAbi, functionName: "cancelSubscription", args: [BigInt(sid), nonce, deadline, sigs] });
  const r = await relay(ctx, data, kind === 1 ? "stream" : "subscription").catch((e) => fail(400, "stop_refused", explainRevert(e)));
  return { txHash: r.transactionHash };
}
