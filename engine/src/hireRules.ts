import { decodeFunctionData, type Address, type Hex } from "viem";
import { purserEscrowAbi } from "../../packages/sdk/src/abi.ts";
import type { VerdictReason } from "../../packages/sdk/src/schema.ts";
import type { Ctx } from "./ctx.ts";
import { fmt, lower, parseJson, sameAddress } from "./util.ts";

/**
 * The owner's rules for hiring other agents. They sit on top of the account's own rules (budgets, largest payment,
 * approval threshold, co-sign), which the module enforces on chain for every hire because the money only reaches the
 * escrow through a module call. These extra rules are checked by the firewall on the escrow call itself, so they hold
 * for a hire made through the marketplace API and for a raw call to the escrow alike.
 */
export interface HireRuleRow {
  safe: string;
  mode: "any" | "listed" | "off";
  sellers: string;
  max_per_job: string | null;
  updated_at: number;
}

export interface HireRule {
  mode: "any" | "listed" | "off";
  sellers: Address[];
  maxPerJob: bigint | null;
  updatedAt: number | null;
}

export function readHireRule(ctx: Ctx, safe: string): HireRule {
  const r = ctx.db.prepare("SELECT * FROM hire_rules WHERE safe = ?").get(lower(safe)) as HireRuleRow | undefined;
  if (!r) return { mode: "any", sellers: [], maxPerJob: null, updatedAt: null };
  return { mode: r.mode, sellers: parseJson<Address[]>(r.sellers, []), maxPerJob: r.max_per_job === null ? null : BigInt(r.max_per_job), updatedAt: r.updated_at };
}

export function writeHireRule(ctx: Ctx, safe: string, rule: { mode: HireRule["mode"]; sellers: string[]; maxPerJob: bigint | null }, at: number) {
  const sellers = [...new Set(rule.sellers.map(lower))];
  ctx.db
    .prepare(
      "INSERT INTO hire_rules (safe, mode, sellers, max_per_job, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(safe) DO UPDATE SET mode = excluded.mode, sellers = excluded.sellers, max_per_job = excluded.max_per_job, updated_at = excluded.updated_at",
    )
    .run(lower(safe), rule.mode, JSON.stringify(sellers), rule.maxPerJob === null ? null : rule.maxPerJob.toString(), at);
}

export interface EscrowFund {
  payee: Address;
  arbiter: Address;
  token: Address;
  amount: bigint;
  deadline: bigint;
  reviewPeriod: number;
  invoiceRef: Hex;
}

/** The job inside a call to PurserEscrow.fund, or null when the call is something else. */
export function decodeEscrowFund(ctx: Ctx, target: string, data: Hex | null | undefined): EscrowFund | null {
  if (!ctx.dep || !data || !sameAddress(target, ctx.dep.escrow)) return null;
  try {
    const d = decodeFunctionData({ abi: purserEscrowAbi, data });
    if (d.functionName !== "fund") return null;
    const [payee, arbiter, token, amount, deadline, reviewPeriod, invoiceRef] = d.args as readonly [Address, Address, Address, bigint, bigint, number, Hex];
    return { payee: lower(payee), arbiter: lower(arbiter), token: lower(token), amount, deadline, reviewPeriod: Number(reviewPeriod), invoiceRef };
  } catch {
    return null;
  }
}

/** The owner's hire rules applied to one escrow job. Block reasons only; an empty list means the hire may go ahead. */
export function hireReasons(ctx: Ctx, safe: string, job: EscrowFund): VerdictReason[] {
  const rule = readHireRule(ctx, safe);
  const out: VerdictReason[] = [];
  const t = ctx.tokens.infoSync(job.token);
  if (rule.mode === "off")
    out.push({ code: "hire_off", severity: "block", title: "Hiring is off", detail: "The owner does not let this agent hire other agents." });
  else if (rule.mode === "listed" && !rule.sellers.some((s) => sameAddress(s, job.payee)))
    out.push({ code: "hire_seller_not_allowed", severity: "block", title: "Not an agent the owner allows", detail: `The owner lets this agent hire only the agents on its list, and ${job.payee} is not on it.` });
  // the most per job is in USDG, like every listing; a job in another token cannot be held to it
  if (rule.maxPerJob !== null && ctx.dep && !sameAddress(job.token, ctx.dep.usdg))
    out.push({ code: "hire_max_per_job", severity: "block", title: "Not paid in USDG", detail: `The owner set the most per job in USDG, and this job is paid in ${t.symbol}.` });
  else if (rule.maxPerJob !== null && job.amount > rule.maxPerJob)
    out.push({
      code: "hire_max_per_job",
      severity: "block",
      title: "Above the most per job",
      detail: `${fmt(job.amount, t.decimals)} ${t.symbol} is more than the ${fmt(rule.maxPerJob, t.decimals)} ${t.symbol} the owner allows for one job.`,
    });
  return out;
}
