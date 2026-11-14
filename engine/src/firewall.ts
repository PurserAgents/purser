import { decodeEventLog, getAddress, size, slice, type Address, type Hex } from "viem";
import { erc20Abi } from "../../packages/sdk/src/abi.ts";
import type { AssetChange, SimulationSummary, Verdict, VerdictReason } from "../../packages/sdk/src/schema.ts";
import { balanceOf, setsOf } from "./accounts.ts";
import { decodeRevertData, REVERT_WORDS } from "./chain.ts";
import { requireDep, type Ctx } from "./ctx.ts";
import type { PolicyResult } from "./policy.ts";
import { fmt, id, json, lower, now, parseJson, sameAddress, ZERO } from "./util.ts";
import { protectSchedules, recordShieldStop, recordThreats, sentencePrints, shieldCheck, type ThreatCandidate } from "./shield.ts";

// ---------------------------------------------------------------------------------------------------- simulation

const ETH_PSEUDO = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}
interface RawCall {
  from: Address;
  to: Address;
  value: bigint;
  input: Hex;
}
export interface RawSimulation {
  backend: SimulationSummary["backend"];
  success: boolean;
  revertData: Hex | null;
  revertText: string | null;
  gasUsed: bigint;
  logs: RawLog[];
  calls: RawCall[];
}

let backendCache: "eth_simulateV1" | "debug_traceCall" | "none" | null = (process.env.PURSER_SIM_BACKEND as "eth_simulateV1" | "debug_traceCall" | undefined) ?? null;

/** Pins the simulation backend (tests, or a node where one method misbehaves). */
export function forceBackend(b: "eth_simulateV1" | "debug_traceCall" | null) {
  backendCache = b;
}

async function rpc(ctx: Ctx, method: string, params: unknown[]): Promise<unknown> {
  return ctx.chain.pub.request({ method: method as never, params: params as never });
}

/** Simulates a call on the node: eth_simulateV1 (with ETH transfer traces) or debug_traceCall with the call tracer. */
export async function simulate(ctx: Ctx, tx: { from: Address; to: Address; data: Hex; value?: bigint }): Promise<RawSimulation> {
  const value = `0x${(tx.value ?? 0n).toString(16)}`;
  const order: ("eth_simulateV1" | "debug_traceCall")[] =
    backendCache === "debug_traceCall" ? ["debug_traceCall"] : backendCache === "eth_simulateV1" ? ["eth_simulateV1"] : ["eth_simulateV1", "debug_traceCall"];
  for (const backend of order) {
    try {
      if (backend === "eth_simulateV1") {
        const res = (await rpc(ctx, "eth_simulateV1", [
          { blockStateCalls: [{ calls: [{ from: tx.from, to: tx.to, data: tx.data, value }] }], traceTransfers: true, validation: false },
          "latest",
        ])) as { calls: { status: Hex; returnData: Hex; gasUsed: Hex; logs?: RawLog[]; error?: { data?: Hex; message?: string } }[] }[];
        const c = res[0].calls[0];
        backendCache = "eth_simulateV1";
        const ok = c.status === "0x1";
        const revertData = ok ? null : ((c.error?.data ?? c.returnData ?? null) as Hex | null);
        return {
          backend,
          success: ok,
          revertData,
          revertText: ok ? null : c.error?.message ?? null,
          gasUsed: BigInt(c.gasUsed),
          logs: c.logs ?? [],
          calls: [{ from: tx.from, to: tx.to, value: tx.value ?? 0n, input: tx.data }],
        };
      }
      const trace = (await rpc(ctx, "debug_traceCall", [
        { from: tx.from, to: tx.to, data: tx.data, value },
        "latest",
        { tracer: "callTracer", tracerConfig: { withLog: true } },
      ])) as TraceFrame;
      backendCache = "debug_traceCall";
      const logs: RawLog[] = [];
      const calls: RawCall[] = [];
      walk(trace, logs, calls);
      const ok = !trace.error;
      return {
        backend,
        success: ok,
        revertData: ok ? null : ((trace.output as Hex) ?? null),
        revertText: ok ? null : (trace.revertReason ?? trace.error ?? null),
        gasUsed: BigInt(trace.gasUsed ?? "0x0"),
        logs,
        calls,
      };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!/not (exist|available|supported|found)|unsupported|Method not found|-32601/i.test(msg)) {
        if (backend === order[order.length - 1]) throw e;
      }
    }
  }
  backendCache = "none";
  return { backend: "none", success: true, revertData: null, revertText: null, gasUsed: 0n, logs: [], calls: [] };
}

interface TraceFrame {
  type: string;
  from: Address;
  to: Address;
  value?: Hex;
  input: Hex;
  output?: Hex;
  gasUsed?: Hex;
  error?: string;
  revertReason?: string;
  calls?: TraceFrame[];
  logs?: RawLog[];
}

function walk(f: TraceFrame, logs: RawLog[], calls: RawCall[]) {
  if (f.error) return; // reverted frames leave nothing behind
  calls.push({ from: lower(f.from), to: lower(f.to), value: BigInt(f.value ?? "0x0"), input: f.input });
  const v = BigInt(f.value ?? "0x0");
  if (v > 0n && f.type !== "DELEGATECALL") {
    // record ETH movement as a pseudo Transfer log, like eth_simulateV1 does
    logs.push({
      address: ETH_PSEUDO as Address,
      topics: [TRANSFER_TOPIC as Hex, `0x${lower(f.from).slice(2).padStart(64, "0")}` as Hex, `0x${lower(f.to).slice(2).padStart(64, "0")}` as Hex],
      data: `0x${v.toString(16).padStart(64, "0")}` as Hex,
    });
  }
  for (const l of f.logs ?? []) logs.push(l);
  for (const c of f.calls ?? []) walk(c, logs, calls);
}

export async function summarize(ctx: Ctx, raw: RawSimulation, safe: Address, balances: { token: Address; before: bigint }[]): Promise<SimulationSummary> {
  const assetChanges: AssetChange[] = [];
  const approvals: SimulationSummary["approvals"] = [];
  for (const l of raw.logs) {
    const topic = l.topics[0]?.toLowerCase();
    if (topic === TRANSFER_TOPIC && l.topics.length === 3) {
      const token = sameAddress(l.address, ETH_PSEUDO) ? ZERO : lower(l.address);
      const info = await ctx.tokens.info(token);
      const amount = BigInt(l.data);
      assetChanges.push({
        token: info,
        from: lower(`0x${l.topics[1].slice(26)}`),
        to: lower(`0x${l.topics[2].slice(26)}`),
        amount: amount.toString(),
        display: `${fmt(amount, info.decimals)} ${info.symbol}`,
      });
    } else if (topic === APPROVAL_TOPIC && l.topics.length === 3) {
      try {
        const d = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        const args = d.args as { owner: Address; spender: Address; value: bigint };
        approvals.push({ token: lower(l.address), owner: lower(args.owner), spender: lower(args.spender), amount: args.value.toString() });
      } catch {
        /* not ERC-20 shaped */
      }
    }
  }
  const after = balances.map((b) => {
    let v = b.before;
    for (const c of assetChanges) {
      if (!sameAddress(c.token.address, b.token)) continue;
      if (sameAddress(c.from, safe)) v -= BigInt(c.amount);
      if (sameAddress(c.to, safe)) v += BigInt(c.amount);
    }
    return v;
  });
  const name = raw.revertData ? decodeRevertData(raw.revertData) : null;
  return {
    backend: raw.backend,
    success: raw.success,
    revertReason: raw.success ? null : name ? (REVERT_WORDS[name] ?? name) : (raw.revertText ?? "reverted"),
    gasUsed: raw.gasUsed.toString(),
    assetChanges,
    approvals,
    calls: raw.calls.map((c) => ({
      from: c.from,
      to: c.to,
      selector: size(c.input) >= 4 ? slice(c.input, 0, 4) : null,
      value: c.value.toString(),
    })),
    balanceBefore: balances.map((b) => ctx.tokens.money(b.token, b.before)),
    balanceAfter: balances.map((b, i) => ctx.tokens.money(b.token, after[i] < 0n ? 0n : after[i])),
  };
}

// ---------------------------------------------------------------------------------------------------- prompt injection

const STRONG_MARKERS: [RegExp, string][] = [
  [/ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|rules|messages|prompts)/i, "tells the agent to ignore its instructions"],
  [/disregard (all |any )?(the )?(previous|prior|above|system) (instructions|rules|prompt)/i, "tells the agent to disregard its instructions"],
  [/(new|updated|real|actual|secret|hidden) (system )?instructions?\s*:/i, "claims to give new or secret instructions"],
  [/you are now (a|an|in)\b/i, "tries to give the agent a new role"],
  [/(send|transfer|move|withdraw|pay)\s+(all|everything|the (entire|whole|full) (balance|wallet|treasury)|100 ?%|your (entire|whole) (balance|wallet))/i, "asks to move the whole balance"],
  [/(drain|empty|sweep)\s+(the |your |this )?(wallet|account|safe|balance|funds|treasury)/i, "asks to empty the account"],
  [/do not (tell|inform|alert|notify) (the )?(user|owner|human)/i, "asks to hide the action from the owner"],
  [/without (asking|telling|notifying) (the )?(user|owner|human)/i, "asks to act without the owner"],
  [/(urgent|immediately|right now).{0,40}(transfer|send|pay)/i, "pushes for an urgent transfer"],
  [/\bsystem\s*(override|prompt)\b/i, "pretends to be a system message"],
  [/<\s*\/?\s*(system|assistant|instructions?)\s*>/i, "contains fake chat role tags"],
];

const HIDING_MARKERS: [RegExp, string][] = [
  [/[​‌‍⁠﻿]/, "contains invisible zero-width characters"],
  [/<!--[\s\S]*?-->/, "contains an HTML comment"],
  [/(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|color\s*:\s*(white|#fff\b|#ffffff))/i, "contains text styled to be invisible"],
  [/[‪-‮⁦-⁩]/, "contains text-direction control characters"],
];

export interface InjectionFinding {
  strong: string[];
  hiding: string[];
  addressInText: boolean;
  excerpt: string | null;
}

/** Looks for instructions planted in content the agent read (web pages, emails, tool output). */
export function scanInjection(text: string | null | undefined, payee?: string): InjectionFinding {
  const out: InjectionFinding = { strong: [], hiding: [], addressInText: false, excerpt: null };
  if (!text) return out;
  const plain = text.replace(/<!--|-->/g, " ").replace(/<[^>]*>/g, " ").replace(/[​-‍⁠﻿‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ");
  for (const [re, why] of STRONG_MARKERS) {
    const m = re.exec(text);
    if (m) {
      out.strong.push(why);
      if (!out.excerpt) {
        const pm = re.exec(plain);
        const at = pm ? pm.index : 0;
        const from = Math.max(plain.lastIndexOf(". ", at) + 2, at - 60, 0);
        out.excerpt = plain.slice(from, at + (pm?.[0].length ?? 0) + 60).trim();
      }
    }
  }
  for (const [re, why] of HIDING_MARKERS) if (re.test(text)) out.hiding.push(why);
  if (payee) out.addressInText = text.toLowerCase().includes(payee.toLowerCase().slice(2));
  return out;
}

// ---------------------------------------------------------------------------------------------------- checks and verdict

const DANGEROUS_SELECTORS: Record<string, string> = {
  "0xf2fde38b": "transferOwnership",
  "0x3659cfe6": "upgradeTo",
  "0x4f1ef286": "upgradeToAndCall",
  "0x13af4035": "setOwner",
  "0x715018a6": "renounceOwnership",
  "0x610b5925": "enableModule",
  "0xe19a9dd9": "setGuard",
  "0xf08a0323": "setFallbackHandler",
};
const DEAD = new Set(["0x000000000000000000000000000000000000dead", ZERO]);

export interface FirewallInput {
  safe: Address;
  kind: "pay" | "call" | "treasury" | "stream" | "subscription" | "escrow";
  to: Address; // payee or call target
  token: Address | null;
  amount: bigint;
  callData?: Hex | null;
  tx: { from: Address; to: Address; data: Hex; value?: bigint };
  policy: PolicyResult;
  trigger?: string | null;
  intentId: string | null;
  category?: string;
  /** A payout of a plan the owner and the firewall already agreed to (a subscription charge, a stream payout): the
   *  amount is not news, so its share of the balance and a contract payee only warn. Everything about the payee is
   *  checked fresh. */
  agreed?: boolean;
  /** the owner already approved this payment (a queued intent being sent); a Shield match in warn mode lets it go */
  ownerApproved?: boolean;
}

export interface FirewallResult {
  verdict: Verdict;
  simulation: RawSimulation;
  /** Purser Shield matched and the account is set to warn: the payment waits for the owner */
  hold: boolean;
}

/** The firewall: simulate, check, explain. Returns an allow or block verdict with plain reasons, stored. */
export async function evaluate(ctx: Ctx, input: FirewallInput): Promise<FirewallResult> {
  const dep = requireDep(ctx);
  const reasons: VerdictReason[] = [...input.policy.reasons];
  const add = (code: string, severity: VerdictReason["severity"], title: string, detail: string) =>
    reasons.push({ code, severity, title, detail });

  // 1. what the account holds before
  const tracked = [ZERO as Address, dep.usdg, ...(dep.weth ? [dep.weth] : [])];
  if (input.token && !tracked.some((t) => sameAddress(t, input.token))) tracked.push(input.token);
  const balances = await Promise.all(tracked.map(async (t) => ({ token: t, before: await balanceOf(ctx, t, input.safe) })));

  // 2. simulate the exact transaction that would be sent
  const raw = await simulate(ctx, input.tx);
  const sim = await summarize(ctx, raw, input.safe, balances);
  const queuedOnly = raw.success && !sim.assetChanges.some((c) => sameAddress(c.from, input.safe)) && input.policy.needsApproval;
  if (!raw.success && !input.policy.reasons.length) {
    add("simulation_failed", "block", "The payment would fail on chain", sim.revertReason ?? "The simulation reverted.");
  }

  // 3. balance drain: one action moving most of what the account holds, without value coming back
  const outflows = new Map<string, bigint>();
  const inflows = new Map<string, bigint>();
  for (const c of sim.assetChanges) {
    if (sameAddress(c.from, input.safe)) outflows.set(c.token.address, (outflows.get(c.token.address) ?? 0n) + BigInt(c.amount));
    if (sameAddress(c.to, input.safe)) inflows.set(c.token.address, (inflows.get(c.token.address) ?? 0n) + BigInt(c.amount));
  }
  if (!raw.success || queuedOnly) {
    if (input.token) outflows.set(lower(input.token), (outflows.get(lower(input.token)) ?? 0n) + input.amount);
  }
  await ctx.tokens.ethUsdMicro();
  let usdOut = 0n;
  let usdIn = 0n;
  let priced = true;
  for (const [t, v] of outflows) {
    const u = ctx.tokens.usdMicroSync(t, v);
    if (u === null) priced = false;
    else usdOut += u;
  }
  for (const [t, v] of inflows) {
    const u = ctx.tokens.usdMicroSync(t, v);
    if (u !== null) usdIn += u;
  }
  // a treasury move only goes into a vault the owner allowed; the shares come back to the Safe
  const valueComesBack = input.kind === "treasury" || (priced && usdOut > 0n && usdIn * 100n >= usdOut * 90n);
  for (const [token, out] of outflows) {
    const before = balances.find((b) => sameAddress(b.token, token))?.before ?? 0n;
    if (before === 0n || valueComesBack) continue;
    const t = ctx.tokens.infoSync(token);
    const share = Number((out * 10_000n) / before) / 100;
    if (share >= 50)
      add("drain", input.agreed ? "warn" : "block", "This would drain the account", `It moves ${fmt(out, t.decimals)} ${t.symbol}, ${share.toFixed(0)}% of the ${fmt(before, t.decimals)} ${t.symbol} in the account, in one step.`);
    else if (share >= 25)
      add("large_share", "warn", "A large share of the balance", `It moves ${share.toFixed(0)}% of the account's ${t.symbol}.`);
  }
  if (valueComesBack) add("value_returned", "info", "Value comes back", input.kind === "treasury" ? "The money goes into a vault the owner allowed; the vault shares come back to the account." : "The account receives assets worth about what it sends, as in a swap.");

  // 4. who is on the other side
  const code = await ctx.chain.pub.getCode({ address: input.to }).catch(() => undefined);
  const known = isKnownCounterparty(ctx, input.safe, input.to);
  let delegate: string | null = null;
  const threats: ThreatCandidate[] = [];
  if (code && code.startsWith("0xef0100")) {
    delegate = lower(`0x${code.slice(8, 48)}`);
    threats.push({ address: input.to, kind: "forwarding_wallet" }, { address: delegate, kind: "forwarding_code" });
    add("delegated_eoa", "block", "The payee's wallet runs delegated code", `The payee is a wallet that hands control to the contract ${delegate} (EIP-7702). Wallets like this are often set up to forward everything they receive.`);
  } else if (code && code !== "0x" && !known) {
    add("unknown_contract", input.kind === "pay" || input.agreed ? "warn" : "block", "Unknown contract", "The other side is a contract this account has never paid and that is not on the owner's list.");
  } else if (!known && input.amount > 0n) {
    add("new_counterparty", "info", "First payment to this address", "This account has not paid this address before.");
  }
  if (DEAD.has(lower(input.to))) add("burn_address", "block", "Paying a burn address", "Money sent to this address can never be recovered.");
  if (input.token && sameAddress(input.to, input.token)) add("token_contract", "block", "Paying the token contract itself", "Tokens sent to their own contract are usually lost.");

  // 5. approvals left behind
  for (const ap of sim.approvals) {
    if (!sameAddress(ap.owner, input.safe) || BigInt(ap.amount) === 0n) continue;
    const allowedSpender = setsOf(ctx, input.safe, "allow").some((a) => sameAddress(a, ap.spender)) || sameAddress(ap.spender, input.to);
    if (!allowedSpender) {
      add("approval_unknown_spender", "block", "Approval to an unknown spender", `The call would let ${ap.spender} take tokens from the account later.`);
      threats.push({ address: ap.spender, kind: "spender" });
    }
  }

  // 6. known-bad patterns in call data
  for (const c of sim.calls.length ? sim.calls : [{ selector: input.callData && size(input.callData) >= 4 ? slice(input.callData, 0, 4) : null, to: input.to }]) {
    const sel = c.selector?.toLowerCase();
    if (sel && DANGEROUS_SELECTORS[sel])
      add("dangerous_call", "block", "A takeover-style call", `The call runs ${DANGEROUS_SELECTORS[sel]}(), which changes who controls a contract.`);
  }

  // 7. the text that led to the payment
  const inj = scanInjection(input.trigger, input.to);
  const paysModelProvider = input.category === "model" && !inj.addressInText;
  if (inj.strong.length && paysModelProvider) {
    add("injection_in_prompt", "warn", "Instruction-like text in the prompt", `The prompt ${inj.strong[0]}. The payment only goes to the model provider, so it is allowed; the owner may want to look at the request.`);
  } else if (inj.strong.length) {
    if (inj.addressInText) threats.push({ address: input.to, kind: "planted_payee" });
    add(
      "injection",
      "block",
      "A hidden instruction in what the agent read",
      `The request that led to this payment ${inj.strong.slice(0, 2).join(" and ")}${inj.addressInText ? ", and the payee address comes from that same text" : ""}.${inj.excerpt ? ` It says: "${inj.excerpt.slice(0, 160)}"` : ""}`,
    );
  } else if (inj.hiding.length && inj.addressInText) {
    threats.push({ address: input.to, kind: "planted_payee" });
    add("injection", "block", "The payee came from hidden text", `The payee address appears in text that ${inj.hiding[0]}.`);
  } else if (inj.hiding.length) {
    add("hidden_text", "warn", "Hidden text in the request", `The request ${inj.hiding.join(" and ")}.`);
  }

  // 8. Purser Shield: everything this payment touches, checked against what other accounts' firewalls caught
  const touched = [input.to, ...(delegate ? [delegate] : []), ...sim.assetChanges.filter((c) => sameAddress(c.from, input.safe)).map((c) => c.to), ...sim.approvals.map((a) => a.spender)];
  const shield = shieldCheck(ctx, { safe: input.safe, addresses: touched, trigger: input.trigger, agreed: input.agreed, ownerApproved: input.ownerApproved });
  reasons.push(...shield.reasons);

  // 9. owner approval and co-sign are not firewall blocks; say so
  if (input.policy.needsApproval) add("needs_approval", "info", "Needs the owner's approval", "The amount is above the owner's approval threshold, so it waits for the owner.");
  if (input.policy.needsCosign) add("needs_cosign", "info", "Needs a second signature", "The amount is above the co-sign threshold.");

  const blocking = reasons.filter((r) => r.severity === "block");
  const decision = blocking.length ? "block" : "allow";
  const passed = 9 - new Set(reasons.filter((r) => r.severity !== "info").map((r) => r.code)).size;
  const summary =
    decision === "block"
      ? `Blocked: ${blocking[0].title.toLowerCase()}${blocking.length > 1 ? ` (and ${blocking.length - 1} more)` : ""}. Nothing was sent.`
      : `Allowed: the simulation ran clean and ${Math.max(passed, 1)} of 9 checks found nothing${reasons.some((r) => r.severity === "warn") ? "; see the warnings" : ""}.`;

  const verdict: Verdict = {
    id: id("vrd"),
    safe: lower(input.safe),
    intentId: input.intentId,
    decision,
    summary,
    reasons,
    simulation: sim,
    trigger: input.trigger ? input.trigger.slice(0, 4000) : null,
    createdAt: now(),
  };
  ctx.db
    .prepare("INSERT INTO verdicts (id, safe, intent_id, decision, summary, reasons, simulation, trigger_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(verdict.id, verdict.safe, verdict.intentId, decision, summary, json(reasons), json(sim), verdict.trigger, verdict.createdAt);
  ctx.bus.emit("verdict", verdict.safe, verdict);
  await ctx.audit.append("firewall", `verdict.${decision}`, verdict.safe, { verdict: verdict.id, intent: input.intentId, codes: reasons.map((r) => r.code) });

  // what this firewall caught goes on the shared list; what the list stopped is counted
  if (decision === "block") {
    const prints = inj.strong.length && !paysModelProvider ? sentencePrints(input.trigger).filter((p) => scanInjection(p.sentence).strong.length).map((p) => ({ print: p.print, why: scanInjection(p.sentence).strong[0] })) : [];
    const fresh = recordThreats(ctx, input.safe, verdict.id, threats, prints, verdict.createdAt);
    if (fresh.length) await ctx.audit.append("shield", "shield.flagged", verdict.safe, { verdict: verdict.id, addresses: fresh, prints: prints.length });
    for (const a of fresh) await protectSchedules(ctx, a).catch(() => undefined);
  }
  if (shield.matched.length && (decision === "block" || shield.hold)) recordShieldStop(ctx, input.safe, verdict.id, shield.matched, verdict.createdAt);
  return { verdict, simulation: raw, hold: decision === "allow" && shield.hold };
}

export function isKnownCounterparty(ctx: Ctx, safe: string, who: string): boolean {
  if (setsOf(ctx, safe, "allow").some((a) => sameAddress(a, who))) return true;
  if (setsOf(ctx, safe, "vault").some((a) => sameAddress(a, who))) return true;
  const dep = ctx.dep;
  if (dep && [dep.module, dep.recurring, dep.escrow, dep.feeRecipient].some((a) => sameAddress(a, who))) return true;
  const r = ctx.db
    .prepare("SELECT 1 FROM receipts WHERE safe = ? AND counterparty = ? AND status = 'executed' LIMIT 1")
    .get(lower(safe), lower(who));
  if (r) return true;
  // another Purser account (an internal payment) counts as known
  return !!ctx.db.prepare("SELECT 1 FROM accounts WHERE safe = ? LIMIT 1").get(lower(who));
}

interface VerdictRow {
  id: string;
  safe: string;
  intent_id: string | null;
  decision: Verdict["decision"];
  summary: string;
  reasons: string;
  simulation: string | null;
  trigger_text: string | null;
  created_at: number;
}

export const verdictFromRow = (r: VerdictRow): Verdict => ({
  id: r.id,
  safe: r.safe as Address,
  intentId: r.intent_id,
  decision: r.decision,
  summary: r.summary,
  reasons: parseJson(r.reasons, []),
  simulation: parseJson(r.simulation, null),
  trigger: r.trigger_text,
  createdAt: r.created_at,
});

export function getVerdict(ctx: Ctx, vid: string): Verdict | null {
  const r = ctx.db.prepare("SELECT * FROM verdicts WHERE id = ?").get(vid) as VerdictRow | undefined;
  return r ? verdictFromRow(r) : null;
}

export function listVerdicts(ctx: Ctx, opts: { safe?: string; decision?: string; limit?: number }): Verdict[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.safe) {
    where.push("safe = ?");
    args.push(lower(opts.safe));
  }
  if (opts.decision) {
    where.push("decision = ?");
    args.push(opts.decision);
  }
  return (
    ctx.db
      .prepare(`SELECT * FROM verdicts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...args, opts.limit ?? 50) as VerdictRow[]
  ).map(verdictFromRow);
}

export const checksumAddr = (a: string) => getAddress(a);
