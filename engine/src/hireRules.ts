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
  /** the most paid to one seller in a day (escrow jobs funded today), null = no limit */
  maxPerSellerPerDay: bigint | null;
  /** when not empty, a hire's arbiter must be one of these */
  arbiters: Address[];
  /** the shortest review window a hire may have, null = any */
  minReviewSeconds: number | null;
  updatedAt: number | null;
}

export function readHireRule(ctx: Ctx, safe: string): HireRule {
  const r = ctx.db.prepare("SELECT * FROM hire_rules WHERE safe = ?").get(lower(safe)) as HireRuleRow | undefined;
  const m = ctx.db.prepare("SELECT * FROM hire_rules_more WHERE safe = ?").get(lower(safe)) as { max_per_seller_day: string | null; arbiters: string; min_review: number | null } | undefined;
  const more = {
    maxPerSellerPerDay: m?.max_per_seller_day ? BigInt(m.max_per_seller_day) : null,
    arbiters: parseJson<Address[]>(m?.arbiters, []),
    minReviewSeconds: m?.min_review ?? null,
  };
  if (!r) return { mode: "any", sellers: [], maxPerJob: null, ...more, updatedAt: null };
  return { mode: r.mode, sellers: parseJson<Address[]>(r.sellers, []), maxPerJob: r.max_per_job === null ? null : BigInt(r.max_per_job), ...more, updatedAt: r.updated_at };
}

export function writeHireRule(
  ctx: Ctx,
  safe: string,
  rule: { mode: HireRule["mode"]; sellers: string[]; maxPerJob: bigint | null; maxPerSellerPerDay?: bigint | null; arbiters?: string[]; minReviewSeconds?: number | null },
  at: number,
) {
  const sellers = [...new Set(rule.sellers.map(lower))];
  ctx.db
    .prepare(
      "INSERT INTO hire_rules (safe, mode, sellers, max_per_job, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(safe) DO UPDATE SET mode = excluded.mode, sellers = excluded.sellers, max_per_job = excluded.max_per_job, updated_at = excluded.updated_at",
    )
    .run(lower(safe), rule.mode, JSON.stringify(sellers), rule.maxPerJob === null ? null : rule.maxPerJob.toString(), at);
  ctx.db
    .prepare(
      "INSERT INTO hire_rules_more (safe, max_per_seller_day, arbiters, min_review) VALUES (?, ?, ?, ?) ON CONFLICT(safe) DO UPDATE SET max_per_seller_day = excluded.max_per_seller_day, arbiters = excluded.arbiters, min_review = excluded.min_review",
    )
    .run(lower(safe), rule.maxPerSellerPerDay == null ? null : rule.maxPerSellerPerDay.toString(), JSON.stringify([...new Set((rule.arbiters ?? []).map(lower))]), rule.minReviewSeconds ?? null);
}

/** What this account paid one seller through the escrow today (jobs funded, whatever happened to them after). */
export function paidToSellerToday(ctx: Ctx, safe: string, seller: string, token: string): bigint {
  const t = Math.floor(Date.now() / 1000);
  const rows = ctx.db
    .prepare("SELECT amount FROM invoices WHERE payer = ? AND payee = ? AND token = ? AND job_id IS NOT NULL AND created_at >= ?")
    .all(lower(safe), lower(seller), lower(token), t - (t % 86400)) as { amount: string }[];
  return rows.reduce((n, r) => n + BigInt(r.amount), 0n);
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
  if (rule.maxPerSellerPerDay !== null) {
    const today = paidToSellerToday(ctx, safe, job.payee, job.token);
    if (today + job.amount > rule.maxPerSellerPerDay)
      out.push({ code: "hire_max_per_seller", severity: "block", title: "Over today's limit for this seller", detail: `This account paid ${fmt(today, t.decimals)} ${t.symbol} to this seller today; the owner allows ${fmt(rule.maxPerSellerPerDay, t.decimals)} ${t.symbol} a day.` });
  }
  if (rule.arbiters.length && !rule.arbiters.some((a) => sameAddress(a, job.arbiter)))
    out.push({ code: "hire_arbiter_not_allowed", severity: "block", title: "Not an arbiter the owner allows", detail: "The owner lets this agent hire only with one of the arbiters on its list." });
  if (rule.minReviewSeconds !== null && job.reviewPeriod < rule.minReviewSeconds)
    out.push({ code: "hire_review_too_short", severity: "block", title: "Review window too short", detail: `The owner wants at least ${rule.minReviewSeconds} seconds to review a delivery; this job gives ${job.reviewPeriod}.` });
  return out;
}
