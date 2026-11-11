import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { purserModuleAbi } from "../../packages/sdk/src/abi.ts";
import type { VerdictReason } from "../../packages/sdk/src/schema.ts";
import { readChainAccount, readRule, type ChainRule } from "./accounts.ts";
import { chainNow, requireDep, type Ctx } from "./ctx.ts";
import { fmt, now, sameAddress, ZERO } from "./util.ts";

export interface Spend {
  token: Address;
  amount: bigint;
  to: Address;
  service?: Hex;
}

export interface PolicyResult {
  reasons: VerdictReason[];
  needsApproval: boolean;
  needsCosign: boolean;
  frozen: boolean;
  rule: ChainRule | null;
  cosigner: Address | null;
  firewall: Address | null;
  agent: Address;
}

const block = (code: string, title: string, detail: string): VerdictReason => ({ code, severity: "block", title, detail });

/**
 * The engine's copy of the module's rules, used to explain a refusal in plain words before anything is signed.
 * The module checks the same rules again on chain; this copy never loosens them.
 */
export async function checkPolicy(ctx: Ctx, safe: Address, spends: Spend[], opts: { kind: "pay" | "call" } = { kind: "pay" }): Promise<PolicyResult> {
  const dep = requireDep(ctx);
  const a = await readChainAccount(ctx, safe);
  const reasons: VerdictReason[] = [];
  const cfg = a.config;
  const out: PolicyResult = {
    reasons,
    needsApproval: false,
    needsCosign: false,
    frozen: a.frozen,
    rule: null,
    cosigner: sameAddress(cfg.cosigner, ZERO) ? null : cfg.cosigner,
    firewall: sameAddress(cfg.firewall, ZERO) ? null : cfg.firewall,
    agent: cfg.agent,
  };
  if (!a.initialized) {
    reasons.push(block("not_account", "Not a Purser account", "This address has no Purser account."));
    return out;
  }
  if (a.frozen) reasons.push(block("frozen", "The account is frozen", "The owner (or the watchdog) froze this account. Nothing can be paid until the owner unfreezes it."));

  const ts = await chainNow(ctx);
  const hour = Math.floor(ts / 3600) % 24;
  const weekday = (Math.floor(ts / 86400) + 3) % 7;
  if (cfg.hoursMask && !((cfg.hoursMask >> hour) & 1))
    reasons.push(block("time_window", "Outside the allowed hours", `Payments are allowed only in the hours the owner set (UTC). It is ${hour}:00 UTC now.`));
  if (cfg.daysMask && !((cfg.daysMask >> weekday) & 1))
    reasons.push(block("time_window", "Outside the allowed days", "Payments are not allowed on this day of the week."));

  const day = BigInt(Math.floor(ts / 86400));
  const week = (day + 3n) / 7n;
  const fee = await ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "FEE_BPS" });

  for (const s of spends) {
    const rule = await readRule(ctx, safe, s.token);
    out.rule = rule;
    const t = await ctx.tokens.info(s.token);
    const show = (v: bigint) => `${fmt(v, t.decimals)} ${t.symbol}`;
    if (!rule.enabled) {
      reasons.push(block("token_not_enabled", `${t.symbol} is not enabled`, `The owner has not allowed this agent to spend ${t.symbol}.`));
      continue;
    }
    const total = s.amount + (s.amount * fee) / 10_000n;
    if (s.amount > rule.maxSingle)
      reasons.push(block("max_single", "Above the largest single payment", `${show(s.amount)} is more than the ${show(rule.maxSingle)} the owner allows in one payment.`));
    const [spentDay, spentWeek, cpSpent, cpOverride, allowed, serviceOk] = await Promise.all([
      ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "spentOnDay", args: [safe, s.token, day] }),
      ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "spentInWeek", args: [safe, s.token, week] }),
      ctx.chain.pub.readContract({
        address: dep.module,
        abi: purserModuleAbi,
        functionName: "counterpartySpent",
        args: [keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [safe, s.token, s.to, day]))],
      }),
      ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "counterpartyLimit", args: [safe, s.token, s.to] }),
      ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "allowed", args: [safe, s.to] }),
      s.service
        ? ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "allowedService", args: [safe, s.service] })
        : Promise.resolve(false),
    ]);
    if (spentDay + total > rule.daily)
      reasons.push(block("daily_budget", "Over today's budget", `Today ${show(spentDay)} of ${show(rule.daily)} is spent; this payment with its fee is ${show(total)}.`));
    if (spentWeek + total > rule.weekly)
      reasons.push(block("weekly_budget", "Over this week's budget", `This week ${show(spentWeek)} of ${show(rule.weekly)} is spent.`));
    const cpCap = cpOverride > 0n ? cpOverride : rule.perCounterpartyDaily;
    if (cpSpent + s.amount > cpCap)
      reasons.push(block("counterparty_limit", "Over the daily limit for this payee", `This payee has received ${show(cpSpent)} today; the limit is ${show(cpCap)}.`));
    if (opts.kind === "pay" && cfg.payeeAllowlist && !allowed)
      reasons.push(block("payee_not_allowed", "Payee not on the allowlist", "The owner only allows payments to listed payees, and this one is not listed."));
    if (opts.kind === "pay" && cfg.serviceAllowlist && !serviceOk)
      reasons.push(block("service_not_allowed", "Service not on the allowlist", "The owner only allows listed services, and this one is not listed."));
    if (s.amount > rule.approvalAbove) out.needsApproval = true;
    if (s.amount > rule.cosignAbove && out.cosigner) out.needsCosign = true;
  }
  if (cfg.maxPerMinute) {
    const minute = BigInt(Math.floor(ts / 60));
    if (a.minute === minute && a.minuteCount >= cfg.maxPerMinute)
      reasons.push(block("rate_limit", "Too many payments this minute", `The owner allows ${cfg.maxPerMinute} payments per minute.`));
  }
  return out;
}
