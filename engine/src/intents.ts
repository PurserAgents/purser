import { decodeEventLog, encodeFunctionData, isHex, recoverTypedDataAddress, type Address, type Hex, type Log } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { purserModuleAbi } from "../../packages/sdk/src/abi.ts";
import {
  callDigest,
  callTypedData,
  packSignatures,
  payDigest,
  payTypedData,
  randomNonce,
  serviceId,
  treasuryDigest,
  treasuryTypedData,
  type CallIntent,
  type PayIntent,
  type TreasuryIntent,
} from "../../packages/sdk/src/eip712.ts";
import type { ModelUsage, PayResult, ReceiptCategory, Verdict } from "../../packages/sdk/src/schema.ts";
import { explainRevert } from "./chain.ts";
import { chainNow, requireDep, type Ctx } from "./ctx.ts";
import { evaluate } from "./firewall.ts";
import { ingestReceipt } from "./indexer.ts";
import { checkPolicy, type Spend } from "./policy.ts";
import { getIntentRow, intentFromRow, receiptFromRow, setIntent, type IntentRow, type ReceiptRow } from "./receipts.ts";
import { fail, fmt, id, json, lower, now, parseJson, sameAddress, ZERO } from "./util.ts";

export interface IntentMeta {
  memo?: string | null;
  trigger?: string | null; // the text that led to the payment (web page, email, tool output)
  taskId?: string | null;
  customer?: string | null;
  model?: ModelUsage | null;
  serviceRef?: string | null; // e.g. a storefront service id or an x402 URL
}

export type IntentSpec =
  | { kind: "pay"; pay: { token: Address; to: Address; amount: bigint; service?: string | Hex } }
  | { kind: "call"; call: { target: Address; value: bigint; data: Hex; spendToken: Address; spendLimit: bigint } }
  | { kind: "treasury"; treasury: { vault: Address; deposit: boolean; assets: bigint; limit: bigint } };

export interface SubmitInput {
  safe: Address;
  spec: IntentSpec;
  category: ReceiptCategory;
  meta?: IntentMeta;
  signer?: PrivateKeyAccount | null; // engine-held session key
  signature?: Hex; // or a signature made by the agent itself (self-held key)
  nonce?: bigint;
  deadline?: bigint;
  cosignature?: Hex;
  dryRun?: boolean; // check and simulate only; never send
}

type Built =
  | { kind: "pay"; intent: PayIntent; digest: Hex; typed: ReturnType<typeof payTypedData> }
  | { kind: "call"; intent: CallIntent; digest: Hex; typed: ReturnType<typeof callTypedData> }
  | { kind: "treasury"; intent: TreasuryIntent; digest: Hex; typed: ReturnType<typeof treasuryTypedData> };

function build(ctx: Ctx, safe: Address, spec: IntentSpec, nonce: bigint, deadline: bigint): Built {
  const dep = requireDep(ctx);
  const chainId = ctx.cfg.chainId;
  if (spec.kind === "pay") {
    const svc = spec.pay.service ? (isHex(spec.pay.service) && spec.pay.service.length === 66 ? spec.pay.service : serviceId(spec.pay.service)) : (`0x${"0".repeat(64)}` as Hex);
    const intent: PayIntent = { safe, token: spec.pay.token, to: spec.pay.to, amount: spec.pay.amount, service: svc, nonce, deadline };
    return { kind: "pay", intent, digest: payDigest(chainId, dep.module, intent), typed: payTypedData(chainId, dep.module, intent) };
  }
  if (spec.kind === "call") {
    const intent: CallIntent = { safe, ...spec.call, nonce, deadline };
    return { kind: "call", intent, digest: callDigest(chainId, dep.module, intent), typed: callTypedData(chainId, dep.module, intent) };
  }
  const intent: TreasuryIntent = { safe, ...spec.treasury, nonce, deadline };
  return { kind: "treasury", intent, digest: treasuryDigest(chainId, dep.module, intent), typed: treasuryTypedData(chainId, dep.module, intent) };
}

function txData(b: Built, sigs: Hex): Hex {
  if (b.kind === "pay") return encodeFunctionData({ abi: purserModuleAbi, functionName: "pay", args: [b.intent, sigs] });
  if (b.kind === "call") return encodeFunctionData({ abi: purserModuleAbi, functionName: "call", args: [b.intent, sigs] });
  return encodeFunctionData({ abi: purserModuleAbi, functionName: "treasury", args: [b.intent, sigs] });
}

function describe(ctx: Ctx, spec: IntentSpec): { summary: string; token: Address | null; amount: bigint; to: Address; spends: Spend[] } {
  if (spec.kind === "pay") {
    const t = ctx.tokens.infoSync(spec.pay.token);
    const svc = spec.pay.service && !isHex(spec.pay.service) ? spec.pay.service : undefined;
    return {
      summary: `Pay ${fmt(spec.pay.amount, t.decimals)} ${t.symbol} to ${short(spec.pay.to)}${svc ? ` for ${svc}` : ""}`,
      token: spec.pay.token,
      amount: spec.pay.amount,
      to: spec.pay.to,
      spends: [{ token: spec.pay.token, amount: spec.pay.amount, to: spec.pay.to, service: build_service(spec.pay.service) }],
    };
  }
  if (spec.kind === "call") {
    const c = spec.call;
    const spends: Spend[] = [];
    if (c.value > 0n) spends.push({ token: ZERO, amount: c.value, to: c.target });
    if (!sameAddress(c.spendToken, ZERO)) spends.push({ token: c.spendToken, amount: c.spendLimit, to: c.target });
    const main = spends[spends.length - 1];
    const t = main ? ctx.tokens.infoSync(main.token) : null;
    return {
      summary: `Call ${short(c.target)}${main && t ? ` spending up to ${fmt(main.amount, t.decimals)} ${t.symbol}` : ""}`,
      token: main?.token ?? null,
      amount: main?.amount ?? 0n,
      to: c.target,
      spends,
    };
  }
  const tr = spec.treasury;
  return { summary: `${tr.deposit ? "Move idle money into" : "Take money back from"} vault ${short(tr.vault)}`, token: null, amount: tr.assets, to: tr.vault, spends: [] };
}

const build_service = (s?: string | Hex) => (s ? (isHex(s) && s.length === 66 ? s : serviceId(s)) : undefined);
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

function serialize(b: Built): string {
  return json({ kind: b.kind, intent: b.intent });
}

function deserialize(row: IntentRow): Built {
  const p = parseJson<{ kind: Built["kind"]; intent: Record<string, string | boolean> }>(row.payload, { kind: "pay", intent: {} });
  const big = (k: string) => BigInt(p.intent[k] as string);
  // rebuild with the stored nonce and deadline; the digest must match what was signed
  if (p.kind === "pay") {
    const i = p.intent;
    return { kind: "pay", intent: { safe: i.safe as Address, token: i.token as Address, to: i.to as Address, amount: big("amount"), service: i.service as Hex, nonce: big("nonce"), deadline: big("deadline") }, digest: row.digest as Hex, typed: null as never };
  }
  if (p.kind === "call") {
    const i = p.intent;
    return { kind: "call", intent: { safe: i.safe as Address, target: i.target as Address, value: big("value"), data: i.data as Hex, spendToken: i.spendToken as Address, spendLimit: big("spendLimit"), nonce: big("nonce"), deadline: big("deadline") }, digest: row.digest as Hex, typed: null as never };
  }
  const i = p.intent;
  return { kind: "treasury", intent: { safe: i.safe as Address, vault: i.vault as Address, deposit: i.deposit as boolean, assets: big("assets"), limit: big("limit"), nonce: big("nonce"), deadline: big("deadline") }, digest: row.digest as Hex, typed: null as never };
}

/**
 * The payment pipeline: sign (or check the agent's signature), check the rules, simulate and run the firewall,
 * then relay to the local node. A blocked intent is stored with its verdict and never sent.
 */
export async function submitIntent(ctx: Ctx, input: SubmitInput): Promise<PayResult> {
  const dep = requireDep(ctx);
  const safe = lower(input.safe);
  const nonce = input.nonce ?? randomNonce();
  const deadline = input.deadline ?? BigInt((await chainNow(ctx)) + 15 * 60);
  const b = build(ctx, safe, input.spec, nonce, deadline);
  const d = describe(ctx, input.spec);
  for (const s of d.spends) await ctx.tokens.info(s.token);

  // agent signature
  let agentSig: Hex;
  if (input.signer) agentSig = await input.signer.signTypedData(b.typed as never);
  else if (input.signature) agentSig = input.signature;
  else return fail(400, "no_signature", "The intent needs the agent's signature (or an engine-held session key).");

  const iid = id("int");
  const meta: IntentMeta = { ...input.meta };
  if (input.spec.kind === "pay" && input.spec.pay.service && !isHex(input.spec.pay.service)) meta.serviceRef ??= input.spec.pay.service;
  ctx.db
    .prepare(
      `INSERT INTO intents (id, safe, kind, digest, payload, sigs, status, summary, token, amount, to_addr, category, meta, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'checking', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(iid, safe, b.kind, lower(b.digest), serialize(b), agentSig, d.summary, d.token ? lower(d.token) : null, d.amount.toString(), lower(d.to), input.category, json(meta), now(), now());

  const policy = await checkPolicy(ctx, safe, d.spends, { kind: b.kind === "call" ? "call" : "pay" });
  const signerOk = sameAddress(await recoverTypedDataAddress({ ...(b.typed as object), signature: agentSig } as never), policy.agent);
  if (!signerOk)
    policy.reasons.push({ code: "wrong_agent_key", severity: "block", title: "Not this account's agent key", detail: "The intent is not signed by the session key the owner set for this account." });

  // co-signature
  let cosig: Hex | null = null;
  if (policy.needsCosign) {
    if (!input.cosignature) {
      const intent = setIntent(ctx, iid, { status: "needs_cosign" })!;
      await ctx.audit.append(`agent:${safe}`, "intent.needs_cosign", safe, { intent: iid, digest: b.digest });
      return { intent, verdict: placeholderVerdict(safe, iid, "Waiting for the second signer."), receipt: null };
    }
    const who = await recoverTypedDataAddress({ ...(b.typed as object), signature: input.cosignature } as never);
    if (!sameAddress(who, policy.cosigner)) policy.reasons.push({ code: "bad_cosign", severity: "block", title: "Wrong co-signature", detail: "The second signature is not from the account's co-signer." });
    cosig = input.cosignature;
  }

  // firewall co-signature (only signed for simulation; discarded if the verdict blocks)
  let fwSig: Hex | null = null;
  if (policy.firewall) {
    const fw = ctx.chain.accounts.firewall;
    if (!fw || !sameAddress(fw.address, policy.firewall))
      policy.reasons.push({ code: "firewall_key", severity: "block", title: "Firewall key mismatch", detail: "The account requires a firewall signature from a key this engine does not hold." });
    else fwSig = await fw.sign({ hash: b.digest });
  }
  const sigs = packSignatures(agentSig, cosig, fwSig);
  const data = txData(b, sigs);
  const from = ctx.chain.accounts.relayer?.address ?? safe;
  const { verdict, hold } = await evaluate(ctx, {
    safe,
    kind: b.kind === "treasury" ? "treasury" : b.kind,
    to: d.to,
    token: d.token,
    amount: d.amount,
    callData: b.kind === "call" ? b.intent.data : null,
    tx: { from, to: dep.module, data },
    policy,
    trigger: meta.trigger,
    intentId: iid,
    category: input.category,
  });

  if (verdict.decision === "block") {
    const intent = setIntent(ctx, iid, { status: "blocked", verdict_id: verdict.id, error: verdict.summary })!;
    if (!input.dryRun) ctx.bus.emit("intent", safe, { ...intent, event: "blocked" });
    await ctx.audit.append("firewall", input.dryRun ? "intent.checked_blocked" : "intent.blocked", safe, { intent: iid, verdict: verdict.id, summary: d.summary });
    return { intent, verdict, receipt: null };
  }
  if (input.dryRun) {
    const intent = setIntent(ctx, iid, { status: "ready", verdict_id: verdict.id, error: hold ? "dry run: Purser Shield would hold it for the owner" : "dry run: checked, not sent" })!;
    return { intent, verdict, receipt: null };
  }
  if (hold) {
    const intent = setIntent(ctx, iid, { status: "held", verdict_id: verdict.id, sigs, error: "Held by Purser Shield until the owner releases or rejects it." })!;
    ctx.bus.emit("intent", safe, { ...intent, event: "held" });
    await ctx.audit.append("shield", "intent.held", safe, { intent: iid, verdict: verdict.id, summary: d.summary });
    return { intent, verdict, receipt: null };
  }
  setIntent(ctx, iid, { verdict_id: verdict.id, sigs });
  return relay(ctx, iid, verdict);
}

function placeholderVerdict(safe: Address, iid: string, summary: string): Verdict {
  return { id: "", safe, intentId: iid, decision: "allow", summary, reasons: [], simulation: null, trigger: null, createdAt: now() };
}

/** Sends a checked intent through the relayer (local node only) and records the outcome. */
async function relay(ctx: Ctx, iid: string, verdict: Verdict): Promise<PayResult> {
  const dep = requireDep(ctx);
  const row = getIntentRow(ctx, iid)!;
  const b = deserialize(row);
  if (!ctx.chain.broadcast || !ctx.chain.accounts.relayer) {
    const intent = setIntent(ctx, iid, { status: "ready" })!;
    return { intent, verdict, receipt: null };
  }
  setIntent(ctx, iid, { status: "submitted" });
  let receipt;
  try {
    receipt = await ctx.chain.send(ctx.chain.accounts.relayer, { to: dep.module, data: txData(b, row.sigs as Hex) });
  } catch (e) {
    const intent = setIntent(ctx, iid, { status: "failed", error: explainRevert(e) })!;
    await ctx.audit.append("engine", "intent.failed", row.safe, { intent: iid, error: intent.error });
    return { intent, verdict, receipt: null };
  }
  setIntent(ctx, iid, { tx_hash: lower(receipt.transactionHash) });
  if (receipt.status !== "success") {
    const intent = setIntent(ctx, iid, { status: "failed", error: "The transaction reverted on chain." })!;
    return { intent, verdict, receipt: null };
  }
  const queued = receipt.logs.some((l) => {
    try {
      return decodeEventLog({ abi: purserModuleAbi, data: l.data, topics: l.topics }).eventName === "IntentQueued";
    } catch {
      return false;
    }
  });
  await ingestReceipt(ctx, receipt);
  const status = queued ? "queued" : "executed";
  const intent = setIntent(ctx, iid, { status, tx_hash: lower(receipt.transactionHash) })!;
  await ctx.audit.append(`agent:${row.safe}`, `intent.${status}`, row.safe, { intent: iid, tx: receipt.transactionHash, summary: row.summary });
  if (status === "executed") for (const h of ctx.hooks.afterExecuted) await h(row.safe, iid);
  const r = ctx.db.prepare("SELECT * FROM receipts WHERE intent_id = ? ORDER BY rowid ASC LIMIT 1").get(iid) as ReceiptRow | undefined;
  return { intent, verdict, receipt: r ? receiptFromRow(ctx, r) : null };
}

/** Other intent kinds (streams, subscriptions) register how they resume after an approval. */
export const resumers: Record<string, (ctx: Ctx, iid: string) => Promise<PayResult>> = {};

/** After the owner approved (or a co-signer signed), run the firewall again on fresh state and send. */
export async function resumeIntent(ctx: Ctx, iid: string, cosignature?: Hex): Promise<PayResult> {
  const dep = requireDep(ctx);
  const row = getIntentRow(ctx, iid) ?? fail(404, "not_found", "No such intent.");
  if (resumers[row.kind]) return resumers[row.kind](ctx, iid);
  if (!["approved", "queued", "needs_cosign"].includes(row.status)) fail(409, "wrong_state", `The intent is ${row.status}.`);
  const b = deserialize(row);
  const safe = row.safe as Address;
  if (row.status === "queued") {
    const st = await ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "intentState", args: [safe, b.digest] });
    if (st !== 2) fail(409, "not_approved", "The owner has not approved this payment yet.");
  }
  const spec: IntentSpec =
    b.kind === "pay"
      ? { kind: "pay", pay: { token: b.intent.token, to: b.intent.to, amount: b.intent.amount, service: b.intent.service } }
      : b.kind === "call"
        ? { kind: "call", call: { target: b.intent.target, value: b.intent.value, data: b.intent.data, spendToken: b.intent.spendToken, spendLimit: b.intent.spendLimit } }
        : { kind: "treasury", treasury: { vault: b.intent.vault, deposit: b.intent.deposit, assets: b.intent.assets, limit: b.intent.limit } };
  const d = describe(ctx, spec);
  const policy = await checkPolicy(ctx, safe, d.spends, { kind: b.kind === "call" ? "call" : "pay" });
  policy.reasons = policy.reasons.filter((r) => r.code !== "needs_approval");
  const agentSig = (row.sigs ?? "0x").slice(0, 132) as Hex;
  let cosig: Hex | null = null;
  if (policy.needsCosign) {
    cosig = cosignature ?? (row.sigs && row.sigs.length >= 262 ? (`0x${row.sigs.slice(132, 262)}` as Hex) : null);
    if (!cosig) fail(400, "cosign_required", "A co-signature is required.");
  }
  const fwSig = policy.firewall && ctx.chain.accounts.firewall ? await ctx.chain.accounts.firewall.sign({ hash: b.digest }) : null;
  const sigs = packSignatures(agentSig, cosig, fwSig);
  const meta = parseJson<IntentMeta>(row.meta, {});
  // claim the intent so a second resume (task and request at once) cannot send it twice
  const claimed = ctx.db
    .prepare("UPDATE intents SET status = 'submitted', updated_at = ? WHERE id = ? AND status IN ('approved','queued','needs_cosign')")
    .run(now(), iid);
  if (!claimed.changes) fail(409, "busy", "This intent is already being sent.");
  const { verdict } = await evaluate(ctx, {
    safe,
    kind: row.kind,
    to: d.to,
    token: d.token,
    amount: d.amount,
    callData: b.kind === "call" ? b.intent.data : null,
    tx: { from: ctx.chain.accounts.relayer?.address ?? safe, to: dep.module, data: txData(b, sigs) },
    policy: { ...policy, needsApproval: false },
    trigger: meta.trigger,
    intentId: iid,
    category: row.category,
    ownerApproved: true,
  });
  if (verdict.decision === "block") {
    const intent = setIntent(ctx, iid, { status: "blocked", verdict_id: verdict.id, error: verdict.summary })!;
    return { intent, verdict, receipt: null };
  }
  setIntent(ctx, iid, { verdict_id: verdict.id, sigs, status: "approved" });
  return relay(ctx, iid, verdict);
}

/** The owner releases a payment Purser Shield held (warn mode): it is checked again, then sent. */
export async function releaseHeld(ctx: Ctx, iid: string): Promise<PayResult> {
  const row = getIntentRow(ctx, iid);
  if (!row) return fail(404, "not_found", "No such intent.");
  const claimed = ctx.db.prepare("UPDATE intents SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'held'").run(now(), iid);
  if (!claimed.changes) return fail(409, "not_held", "This payment is not waiting on Purser Shield.");
  await ctx.audit.append(`owner:${row.safe}`, "intent.released", row.safe, { intent: iid });
  return resumeIntent(ctx, iid);
}

/** The owner rejects a payment Purser Shield held. Nothing is sent. */
export async function rejectHeld(ctx: Ctx, iid: string) {
  const row = getIntentRow(ctx, iid);
  if (!row) return fail(404, "not_found", "No such intent.");
  const done = ctx.db.prepare("UPDATE intents SET status = 'rejected', error = ?, updated_at = ? WHERE id = ? AND status = 'held'").run("Rejected by the owner after a Purser Shield match.", now(), iid);
  if (!done.changes) return fail(409, "not_held", "This payment is not waiting on Purser Shield.");
  await ctx.audit.append(`owner:${row.safe}`, "intent.rejected", row.safe, { intent: iid });
  const intent = getIntent(ctx, iid)!;
  ctx.bus.emit("intent", row.safe, { ...intent, event: "rejected" });
  return intent;
}

export function getIntent(ctx: Ctx, iid: string) {
  const r = getIntentRow(ctx, iid);
  return r ? intentFromRow(ctx, r) : null;
}

export function listIntents(ctx: Ctx, opts: { safe?: string; status?: string; limit?: number }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.safe) {
    where.push("safe = ?");
    args.push(lower(opts.safe));
  }
  if (opts.status) {
    where.push("status = ?");
    args.push(opts.status);
  }
  return (
    ctx.db.prepare(`SELECT * FROM intents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, opts.limit ?? 50) as IntentRow[]
  ).map((r) => intentFromRow(ctx, r));
}

export const _test = { build, deserialize, txData };
export type { Log };
