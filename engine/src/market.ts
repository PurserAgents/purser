/**
 * Phase 05: agents hire agents. A marketplace on top of the escrow invoices already in the engine:
 *
 *   listing   an agent's offer (what it does, the price of one job, how fast it delivers), made from scratch or from
 *             one of its storefront services
 *   hire      the buyer's agent picks a listing; the engine writes the invoice from the listing and the buyer's Safe
 *             funds PurserEscrow through a module call, so the account's rules, the firewall and the owner's hire
 *             rules apply (never around them); above the owner's approval threshold the payment waits for the owner
 *   deliver   the seller marks the job delivered with the hash of its result; the result goes to the buyer
 *   accept    the buyer releases the money; after the review window anyone (the engine's keeper) pays the seller out,
 *             and after the deadline with no delivery the buyer is refunded
 *   rate      only the buyer of a job that was paid out on chain, once, and never between two agents of one owner
 *   search    ranked on rating, completed jobs, price and delivery time
 */
import type { Context, Hono } from "hono";
import { encodeFunctionData, keccak256, toHex, type Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";
import { purserEscrowAbi, safeAbi } from "../../packages/sdk/src/abi.ts";
import type { HireRules, HireResult, Job, JobDetail, JobStatus, Listing, ListingStats, MarketSummary, PayResult, StoreService } from "../../packages/sdk/src/schema.ts";
import { accountRow, readRule } from "./accounts.ts";
import { registerRoutes } from "./api/registry.ts";
import { agent, body, param, safeOwner, safeParam, send, zAddr, zAmount } from "./api/http.ts";
import { chainNow, requireDep, type Ctx } from "./ctx.ts";
import { kvGet, kvSet } from "./db.ts";
import { registerTask } from "./engine.ts";
import { readHireRule, writeHireRule } from "./hireRules.ts";
import { onExtension } from "./indexer.ts";
import { createInvoice, escrowCallAsAgent, escrowDone, fundInvoice, invoiceRow, jobOf, relayEscrow, type InvoiceRow } from "./invoices.ts";
import { authAgent, authOwner } from "./keys.ts";
import { checkPolicy } from "./policy.ts";
import { checkSafe } from "./proof.ts";
import { getIntentRow } from "./receipts.ts";
import { listServices } from "./storefront.ts";
import { fail, id, lower, MAX_U128, now, parseJson, sameAddress, ZERO } from "./util.ts";

/** How long the owner has to approve a hire above the approval threshold. The seller's clock starts after it. */
export const APPROVAL_WINDOW = 24 * 3600;
const ESCROW_RELEASED = 4;

interface ListingRow {
  id: string;
  seller: string;
  title: string;
  description: string;
  token: string;
  price: string;
  delivery_seconds: number;
  review_seconds: number;
  arbiter: string | null;
  service_id: string | null;
  tags: string;
  active: number;
  created_at: number;
  updated_at: number;
}

interface JobRow {
  id: string;
  listing_id: string;
  invoice_id: string;
  buyer: string;
  seller: string;
  title: string;
  brief: string;
  result: string | null;
  intent_id: string | null;
  same_owner: number;
  funded_at: number | null;
  delivered_at: number | null;
  finished_at: number | null;
  stars: number | null;
  review: string | null;
  rated_at: number | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------------------------------- views

const publicName = (ctx: Ctx, safe: string) => {
  const r = accountRow(ctx, safe);
  return r?.public ? r.name : null;
};
const sellerName = (ctx: Ctx, safe: string) => accountRow(ctx, safe)?.name ?? null;

function statusOf(ctx: Ctx, inv: InvoiceRow, j: JobRow): JobStatus {
  if (inv.status !== "open") return inv.status;
  const it = j.intent_id ? getIntentRow(ctx, j.intent_id) : undefined;
  switch (it?.status) {
    case "blocked":
      return "blocked";
    case "failed":
    case "rejected":
      return "cancelled";
    case undefined:
      return "cancelled";
    default: {
      // queued, approved, needs_cosign, held, checking, submitted, ready: the money has not moved yet; once the signed
      // intent's deadline passes without the owner's approval it can never run
      const deadline = Number(parseJson<{ intent?: { deadline?: string } }>(it!.payload, {}).intent?.deadline ?? 0);
      return deadline && deadline < now() && it!.status !== "submitted" ? "cancelled" : "awaiting_owner";
    }
  }
}

function jobView(ctx: Ctx, j: JobRow): Job {
  const inv = invoiceRow(ctx, j.invoice_id);
  return {
    id: j.id,
    listingId: j.listing_id,
    title: j.title,
    buyer: j.buyer as Address,
    buyerName: publicName(ctx, j.buyer),
    seller: j.seller as Address,
    sellerName: sellerName(ctx, j.seller),
    arbiter: (inv.arbiter as Address) ?? null,
    money: ctx.tokens.money(inv.token, BigInt(inv.amount)),
    status: statusOf(ctx, inv, j),
    invoiceId: inv.id,
    escrowJobId: inv.job_id,
    deliverBy: inv.deadline,
    reviewUntil: inv.review_until,
    deliveryHash: (inv.delivery_hash as `0x${string}`) ?? null,
    fundedAt: j.funded_at,
    deliveredAt: j.delivered_at,
    finishedAt: j.finished_at,
    rating: j.rated_at ? { stars: j.stars!, review: j.review, ratedAt: j.rated_at } : null,
    sameOwner: !!j.same_owner,
    intentId: j.intent_id,
    createdAt: j.created_at,
    updatedAt: Math.max(j.updated_at, inv.updated_at),
  };
}

const detailView = (ctx: Ctx, j: JobRow): JobDetail => ({ ...jobView(ctx, j), brief: j.brief, result: j.result });

function jobRow(ctx: Ctx, jid: string): JobRow {
  return (ctx.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jid) as JobRow | undefined) ?? fail(404, "not_found", "No such job.");
}

function listingRow(ctx: Ctx, lid: string): ListingRow {
  return (ctx.db.prepare("SELECT * FROM listings WHERE id = ?").get(lid) as ListingRow | undefined) ?? fail(404, "not_found", "No such listing.");
}

interface StatRow {
  listing_id: string;
  seller: string;
  status: string;
  funded_at: number | null;
  delivered_at: number | null;
  stars: number | null;
  amount: string;
}

/** Every job between two different owners, with its escrow status. The source of all public numbers. */
function statRows(ctx: Ctx, where = "", args: unknown[] = []): StatRow[] {
  return ctx.db
    .prepare(`SELECT j.listing_id, j.seller, i.status, j.funded_at, j.delivered_at, j.stars, i.amount FROM jobs j JOIN invoices i ON i.id = j.invoice_id WHERE j.same_owner = 0 ${where}`)
    .all(...args) as StatRow[];
}

function statsOf(rows: StatRow[]): ListingStats {
  const completed = rows.filter((r) => r.status === "released").length;
  const stars = rows.filter((r) => r.stars !== null).map((r) => r.stars!);
  const times = rows
    .filter((r) => r.funded_at !== null && r.delivered_at !== null)
    .map((r) => r.delivered_at! - r.funded_at!)
    .sort((a, b) => a - b);
  return {
    completed,
    refunded: rows.filter((r) => r.status === "refunded").length,
    disputed: rows.filter((r) => r.status === "disputed" || r.status === "resolved").length,
    open: rows.filter((r) => r.status === "funded" || r.status === "delivered").length,
    ratings: stars.length,
    rating: stars.length ? Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 100) / 100 : null,
    medianDeliverySeconds: times.length ? times[Math.floor((times.length - 1) / 2)] : null,
  };
}

function listingView(ctx: Ctx, r: ListingRow, stats?: ListingStats, score: number | null = null): Listing {
  return {
    id: r.id,
    seller: r.seller as Address,
    sellerName: sellerName(ctx, r.seller),
    title: r.title,
    description: r.description,
    price: ctx.tokens.money(r.token, BigInt(r.price)),
    deliverySeconds: r.delivery_seconds,
    reviewSeconds: r.review_seconds,
    arbiter: (r.arbiter as Address) ?? null,
    serviceId: r.service_id,
    tags: parseJson<string[]>(r.tags, []),
    active: !!r.active,
    stats: stats ?? statsOf(statRows(ctx, "AND j.listing_id = ?", [r.id])),
    score,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------------------------------- search

export type MarketSort = "best" | "price" | "rating" | "fastest" | "jobs";

export interface MarketQuery {
  q?: string;
  sort?: MarketSort;
  maxPrice?: bigint;
  maxHours?: number;
  minRating?: number;
  seller?: string;
  limit?: number;
}

/** A rating that counts for more as it is backed by more paid jobs: the average pulled toward 3.5 by two votes. */
const shrunk = (s: ListingStats) => (s.rating === null ? 3.5 : (s.rating * s.ratings + 3.5 * 2) / (s.ratings + 2));

/**
 * Search ranked on results. "best" weighs the rating (35%), completed jobs (25%), price against the cheapest match
 * (20%) and delivery time against the fastest match (20%), times how often jobs end paid rather than refunded or
 * disputed. Only jobs between two different owners count.
 */
export function searchListings(ctx: Ctx, q: MarketQuery = {}): Listing[] {
  const rows = ctx.db.prepare("SELECT * FROM listings WHERE active = 1 ORDER BY created_at DESC LIMIT 2000").all() as ListingRow[];
  const byListing = new Map<string, StatRow[]>();
  for (const s of statRows(ctx)) byListing.set(s.listing_id, [...(byListing.get(s.listing_id) ?? []), s]);
  const words = (q.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const items = rows
    .map((r) => ({ r, s: statsOf(byListing.get(r.id) ?? []) }))
    .filter(({ r, s }) => {
      if (q.seller && !sameAddress(q.seller, r.seller)) return false;
      if (q.maxPrice !== undefined && BigInt(r.price) > q.maxPrice) return false;
      if (q.maxHours !== undefined && r.delivery_seconds > q.maxHours * 3600) return false;
      if (q.minRating !== undefined && (s.rating === null || s.rating < q.minRating)) return false;
      if (!words.length) return true;
      const text = `${r.title} ${r.description} ${parseJson<string[]>(r.tags, []).join(" ")} ${sellerName(ctx, r.seller) ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  const cheapest = items.reduce((m, { r }) => (BigInt(r.price) < m ? BigInt(r.price) : m), MAX_U128);
  const fastest = items.reduce((m, { r }) => Math.min(m, r.delivery_seconds), Number.MAX_SAFE_INTEGER);
  const scored = items.map(({ r, s }) => {
    const rating = shrunk(s) / 5;
    const jobs = Math.min(1, Math.log10(1 + s.completed) / 2);
    const price = BigInt(r.price) > 0n ? Number((cheapest * 10_000n) / BigInt(r.price)) / 10_000 : 1;
    const speed = r.delivery_seconds > 0 ? fastest / r.delivery_seconds : 1;
    const reliable = (s.completed + 1) / (s.completed + s.refunded + s.disputed + 1);
    const score = Math.round((0.35 * rating + 0.25 * jobs + 0.2 * price + 0.2 * speed) * reliable * 1000) / 1000;
    return { r, s, score };
  });
  const sort = q.sort ?? "best";
  scored.sort((a, b) => {
    if (sort === "price") return Number(BigInt(a.r.price) - BigInt(b.r.price)) || b.score - a.score;
    if (sort === "rating") return shrunk(b.s) - shrunk(a.s) || b.s.ratings - a.s.ratings || b.score - a.score;
    if (sort === "fastest") return a.r.delivery_seconds - b.r.delivery_seconds || b.score - a.score;
    if (sort === "jobs") return b.s.completed - a.s.completed || b.score - a.score;
    return b.score - a.score || b.r.created_at - a.r.created_at;
  });
  return scored.slice(0, Math.min(200, Math.max(1, q.limit ?? 50))).map(({ r, s, score }) => listingView(ctx, r, s, score));
}

export function marketSummary(ctx: Ctx): MarketSummary {
  const dep = requireDep(ctx);
  const l = ctx.db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT seller) AS s FROM listings WHERE active = 1").get() as { n: number; s: number };
  const rows = statRows(ctx);
  const paid = rows.filter((r) => r.status === "released").reduce((a, r) => a + BigInt(r.amount), 0n);
  return { listings: l.n, sellers: l.s, jobsCompleted: rows.filter((r) => r.status === "released").length, paidOut: ctx.tokens.money(dep.usdg, paid), ratings: rows.filter((r) => r.stars !== null).length };
}

export function listJobs(ctx: Ctx, safe: string, role?: "buyer" | "seller"): Job[] {
  const s = lower(safe);
  const rows = (
    role === "buyer"
      ? ctx.db.prepare("SELECT * FROM jobs WHERE buyer = ? ORDER BY created_at DESC LIMIT 200").all(s)
      : role === "seller"
        ? ctx.db.prepare("SELECT * FROM jobs WHERE seller = ? ORDER BY created_at DESC LIMIT 200").all(s)
        : ctx.db.prepare("SELECT * FROM jobs WHERE buyer = ? OR seller = ? ORDER BY created_at DESC LIMIT 200").all(s, s)
  ) as JobRow[];
  return rows.map((r) => jobView(ctx, r));
}

export async function hireRulesView(ctx: Ctx, safe: string): Promise<HireRules> {
  const dep = requireDep(ctx);
  const r = readHireRule(ctx, safe);
  let approvalAbove: HireRules["approvalAbove"] = null;
  try {
    const rule = await readRule(ctx, safe as Address, dep.usdg);
    if (rule.enabled && rule.approvalAbove < MAX_U128) approvalAbove = ctx.tokens.money(dep.usdg, rule.approvalAbove);
  } catch {
    /* no node: the approval threshold is unknown */
  }
  return {
    safe: lower(safe),
    mode: r.mode,
    sellers: r.sellers,
    maxPerJob: r.maxPerJob === null ? null : ctx.tokens.money(dep.usdg, r.maxPerJob),
    approvalAbove,
    updatedAt: r.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------------- actions

async function owners(ctx: Ctx, safe: string): Promise<string[]> {
  return ((await ctx.chain.pub.readContract({ address: safe as Address, abi: safeAbi, functionName: "getOwners" })) as string[]).map(lower);
}

/** The buyer's agent hires a listing: invoice from the listing, escrow funded from the buyer's Safe inside its rules. */
export async function hire(ctx: Ctx, auth: { safe: Address; session: PrivateKeyAccount | null }, input: { listingId: string; brief: string; trigger?: string | null }): Promise<HireResult> {
  const dep = requireDep(ctx);
  const l = listingRow(ctx, input.listingId);
  const buyer = lower(auth.safe);
  if (!l.active) fail(410, "inactive", "This listing is paused.");
  if (sameAddress(l.seller, buyer)) fail(400, "bad_request", "An agent cannot hire itself.");
  if (l.arbiter && sameAddress(l.arbiter, buyer)) fail(400, "bad_request", "The buyer cannot be the job's arbiter.");
  // checked fresh, never from the cache: a seller that stopped being a Purser Safe gets no hire
  if (!(await checkSafe(ctx, l.seller, { fresh: true })).ok) fail(409, "seller_not_account", "The seller is no longer a Purser account.");
  const amount = BigInt(l.price);
  // an amount above the owner's approval threshold waits for the owner: give the owner a day and start the seller's
  // clock after it, so a late approval never eats the seller's delivery time
  const policy = await checkPolicy(ctx, buyer, [{ token: l.token as Address, amount, to: dep.escrow }], { kind: "call" });
  const waits = policy.needsApproval || policy.needsCosign;
  const t = await chainNow(ctx);
  const deliverBy = t + (waits ? APPROVAL_WINDOW : 0) + l.delivery_seconds;
  const [ob, os] = await Promise.all([owners(ctx, buyer), owners(ctx, l.seller)]);
  const sameOwner = ob.some((o) => os.includes(o));
  const inv = createInvoice(ctx, { payee: l.seller, payer: buyer, arbiter: l.arbiter, token: l.token, amount, description: `Hire: ${l.title}`.slice(0, 500), deadline: deliverBy, reviewPeriod: l.review_seconds });
  const jid = id("job");
  ctx.db
    .prepare("INSERT INTO jobs (id, listing_id, invoice_id, buyer, seller, title, brief, same_owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(jid, l.id, inv.id, buyer, lower(l.seller), l.title, input.brief, sameOwner ? 1 : 0, now(), now());
  const res = await fundInvoice(ctx, auth, inv, { memo: `Hire: ${l.title.slice(0, 80)}`, trigger: input.trigger, deadline: BigInt(t + (waits ? APPROVAL_WINDOW : 15 * 60)) });
  ctx.db.prepare("UPDATE jobs SET intent_id = ?, updated_at = ? WHERE id = ?").run(res.intent.id, now(), jid);
  if (res.intent.status === "executed") ctx.db.prepare("UPDATE jobs SET funded_at = COALESCE(funded_at, ?) WHERE id = ?").run(t, jid);
  const job = jobView(ctx, jobRow(ctx, jid));
  emitJob(ctx, job);
  await ctx.audit.append(`agent:${buyer}`, "job.hired", buyer, { job: jid, listing: l.id, seller: l.seller, amount: l.price, intent: res.intent.id, status: job.status });
  return { ...res, job };
}

function emitJob(ctx: Ctx, job: Job) {
  ctx.bus.emit("invoice", job.buyer, { event: "job", job });
  ctx.bus.emit("invoice", job.seller, { event: "job", job });
}

/** The seller delivers: the hash of the result goes on chain, the result itself to the buyer. */
export async function deliver(ctx: Ctx, auth: { safe: Address; session: PrivateKeyAccount | null }, jid: string, result: string): Promise<{ job: JobDetail; result: PayResult }> {
  const j = jobRow(ctx, jid);
  if (!sameAddress(j.seller, auth.safe)) fail(403, "not_seller", "Only the seller delivers this job.");
  const inv = invoiceRow(ctx, j.invoice_id);
  if (inv.status !== "funded") fail(409, "wrong_state", inv.status === "open" ? "The job is not funded yet. Wait until the money is in escrow." : `The job is ${inv.status}.`);
  const hash = keccak256(toHex(result));
  // stored first so the buyer can read it the moment the delivery is on chain; cleared if the chain refuses
  ctx.db.prepare("UPDATE jobs SET result = ?, updated_at = ? WHERE id = ?").run(result, now(), jid);
  let res: PayResult;
  try {
    res = escrowDone(await escrowCallAsAgent(ctx, auth, encodeDeliver(jobOf(inv), hash), `Delivered: ${j.title.slice(0, 80)}`));
  } catch (e) {
    ctx.db.prepare("UPDATE jobs SET result = NULL WHERE id = ? AND delivered_at IS NULL").run(jid);
    throw e;
  }
  const detail = detailView(ctx, jobRow(ctx, jid));
  emitJob(ctx, detail);
  await ctx.audit.append(`agent:${lower(auth.safe)}`, "job.delivered", auth.safe, { job: jid, hash });
  return { job: detail, result: res };
}

const encodeDeliver = (job: bigint, hash: `0x${string}`) => encodeFunctionData({ abi: purserEscrowAbi, functionName: "deliver", args: [job, hash] });
const encodeEscrow = (fn: "release" | "dispute", args: readonly [bigint]) => encodeFunctionData({ abi: purserEscrowAbi, functionName: fn, args });

/** The buyer accepts the delivered work: the escrow pays the seller in full. A rating can come with it. */
export async function accept(ctx: Ctx, auth: { safe: Address; session: PrivateKeyAccount | null }, jid: string, rating?: { stars: number; review?: string | null }): Promise<{ job: Job; result: PayResult }> {
  const j = jobRow(ctx, jid);
  if (!sameAddress(j.buyer, auth.safe)) fail(403, "not_buyer", "Only the buyer accepts this job.");
  const inv = invoiceRow(ctx, j.invoice_id);
  if (inv.status !== "delivered") fail(409, "not_delivered", inv.status === "funded" ? "Nothing was delivered yet." : `The job is ${inv.status}.`);
  const res = escrowDone(await escrowCallAsAgent(ctx, auth, encodeEscrow("release", [jobOf(inv)]), `Accepted: ${j.title.slice(0, 80)}`));
  await ctx.audit.append(`agent:${lower(auth.safe)}`, "job.accepted", auth.safe, { job: jid });
  if (rating && !j.same_owner) await rate(ctx, auth.safe, jid, rating);
  const job = jobView(ctx, jobRow(ctx, jid));
  emitJob(ctx, job);
  return { job, result: res };
}

/** The buyer disputes a delivery inside the review window. With no arbiter on the job, the buyer is refunded. */
export async function dispute(ctx: Ctx, auth: { safe: Address; session: PrivateKeyAccount | null }, jid: string): Promise<{ job: Job; result: PayResult }> {
  const j = jobRow(ctx, jid);
  if (!sameAddress(j.buyer, auth.safe)) fail(403, "not_buyer", "Only the buyer disputes this job.");
  const inv = invoiceRow(ctx, j.invoice_id);
  if (inv.status !== "delivered") fail(409, "not_delivered", `The job is ${inv.status}.`);
  const res = escrowDone(await escrowCallAsAgent(ctx, auth, encodeEscrow("dispute", [jobOf(inv)]), `Disputed: ${j.title.slice(0, 80)}`));
  const job = jobView(ctx, jobRow(ctx, jid));
  emitJob(ctx, job);
  await ctx.audit.append(`agent:${lower(auth.safe)}`, "job.disputed", auth.safe, { job: jid });
  return { job, result: res };
}

/**
 * A rating: only the buyer of a job the escrow paid out (read from the chain, not from the engine's own record),
 * once, and never between two agents with a shared owner.
 */
export async function rate(ctx: Ctx, buyer: string, jid: string, r: { stars: number; review?: string | null }): Promise<Job> {
  const dep = requireDep(ctx);
  const j = jobRow(ctx, jid);
  if (!sameAddress(j.buyer, buyer)) fail(403, "not_buyer", "Only the agent that paid for this job can rate it.");
  if (j.same_owner) fail(403, "same_owner", "The buyer and the seller have the same owner, so this job cannot be rated.");
  if (j.rated_at) fail(409, "already_rated", "This job was rated already. A job is rated once.");
  const inv = invoiceRow(ctx, j.invoice_id);
  if (!inv.job_id) fail(409, "not_paid", "Only a job that was paid out can be rated. This one was never funded.");
  const onChain = await ctx.chain.pub.readContract({ address: dep.escrow, abi: purserEscrowAbi, functionName: "getJob", args: [BigInt(inv.job_id!)] });
  if (Number(onChain.status) !== ESCROW_RELEASED || !sameAddress(onChain.payer, j.buyer) || !sameAddress(onChain.payee, j.seller))
    fail(409, "not_paid", "Only a job the escrow paid out to the seller can be rated.");
  const stars = Math.round(r.stars);
  if (stars < 1 || stars > 5) fail(400, "bad_request", "stars: from 1 to 5");
  const t = now();
  const done = ctx.db.prepare("UPDATE jobs SET stars = ?, review = ?, rated_at = ?, updated_at = ? WHERE id = ? AND rated_at IS NULL").run(stars, r.review?.trim() || null, t, t, jid);
  if (!done.changes) fail(409, "already_rated", "This job was rated already. A job is rated once.");
  await ctx.audit.append(`agent:${lower(buyer)}`, "job.rated", buyer, { job: jid, stars });
  const job = jobView(ctx, jobRow(ctx, jid));
  emitJob(ctx, job);
  return job;
}

// ---------------------------------------------------------------------------------------------------- escrow events

onExtension(async (ctx, source, ev) => {
  if (source !== "escrow") return;
  const a = ev.args as Record<string, unknown>;
  const inv = ctx.db.prepare("SELECT id FROM invoices WHERE job_id = ?").get((a.id as bigint).toString()) as { id: string } | undefined;
  if (!inv) return;
  const j = ctx.db.prepare("SELECT id FROM jobs WHERE invoice_id = ?").get(inv.id) as { id: string } | undefined;
  if (!j) return;
  const t = await chainNow(ctx);
  const col = ev.eventName === "JobFunded" ? "funded_at" : ev.eventName === "JobDelivered" ? "delivered_at" : ["JobReleased", "JobRefunded", "JobResolved"].includes(ev.eventName) ? "finished_at" : null;
  if (col) ctx.db.prepare(`UPDATE jobs SET ${col} = COALESCE(${col}, ?), updated_at = ? WHERE id = ?`).run(t, now(), j.id);
  if (ev.eventName === "JobRefunded") ctx.db.prepare("UPDATE jobs SET result = NULL WHERE id = ? AND delivered_at IS NULL").run(j.id);
  emitJob(ctx, jobView(ctx, jobRow(ctx, j.id)));
});

// ---------------------------------------------------------------------------------------------------- keeper

/**
 * Pays out by rule without anyone asking: the seller after the review window ends with no dispute, the buyer after the
 * deadline passes with nothing delivered. Anyone may call these on the escrow; the engine does it for every job it
 * knows, invoices included. A refusal (the chain's clock is a block behind) is retried a minute later.
 */
export async function runKeeper(ctx: Ctx): Promise<{ claimed: string[]; refunded: string[] }> {
  const out = { claimed: [] as string[], refunded: [] as string[] };
  if (!ctx.dep || !ctx.chain.broadcast || !ctx.chain.accounts.relayer) return out;
  const t = await chainNow(ctx);
  const due = ctx.db
    .prepare("SELECT * FROM invoices WHERE job_id IS NOT NULL AND ((status = 'delivered' AND review_until < ?) OR (status = 'funded' AND deadline < ?)) ORDER BY updated_at LIMIT 20")
    .all(t, t) as InvoiceRow[];
  for (const r of due) {
    const key = `keeper:${r.id}`;
    if (Number(kvGet(ctx.db, key) ?? 0) > now()) continue;
    const claim = r.status === "delivered";
    try {
      await relayEscrow(ctx, encodeFunctionData({ abi: purserEscrowAbi, functionName: claim ? "claim" : "refund", args: [BigInt(r.job_id!)] }), claim ? r.payee : r.payer);
      (claim ? out.claimed : out.refunded).push(r.id);
      await ctx.audit.append("engine", claim ? "escrow.claimed" : "escrow.refunded", r.payer, { invoice: r.id, job: r.job_id });
    } catch {
      kvSet(ctx.db, key, String(now() + 60));
    }
  }
  return out;
}

registerTask({ name: "escrow-keeper", every: 15000, run: runKeeper });

// ---------------------------------------------------------------------------------------------------- routes

const zStars = z.number().int().min(1).max(5);
const zReview = z.string().max(280).optional();

/** An agent of one of the given accounts (its API key), or a signed-in owner of one of them. */
async function party(ctx: Ctx, c: Context, safes: string[]): Promise<{ safe: Address; agent: ReturnType<typeof authAgent> | null }> {
  const h = c.req.header("authorization") ?? "";
  if (/^Bearer\s+own_/i.test(h)) {
    authOwner(ctx, h);
    for (const s of safes) {
      try {
        await safeOwner(ctx, c, s);
        return { safe: lower(s), agent: null };
      } catch {
        /* next */
      }
    }
    return fail(403, "not_party", "Only the two parties of this job (or their owners) can see this.");
  }
  const a = agent(ctx, c, "invoices");
  if (!safes.some((s) => sameAddress(s, a.safe))) fail(403, "not_party", "Only the two parties of this job can see this.");
  return { safe: lower(a.safe), agent: a };
}

const statusCode = (s: string) => (s === "executed" ? 201 : s === "blocked" ? 422 : s === "failed" ? 400 : 202);

registerRoutes((app: Hono, ctx: Ctx) => {
  app.get("/v1/market", (c) => send(c, marketSummary(ctx)));
  app.get("/v1/market/listings", (c) => {
    const sort = c.req.query("sort") as MarketSort | undefined;
    const num = (k: string) => (c.req.query(k) !== undefined && c.req.query(k) !== "" && Number.isFinite(Number(c.req.query(k))) ? Number(c.req.query(k)) : undefined);
    const maxPrice = c.req.query("maxPrice");
    return send(c, {
      items: searchListings(ctx, {
        q: c.req.query("q")?.slice(0, 120),
        sort: sort && ["best", "price", "rating", "fastest", "jobs"].includes(sort) ? sort : "best",
        maxPrice: maxPrice && /^\d+$/.test(maxPrice) ? BigInt(maxPrice) : undefined,
        maxHours: num("maxHours"),
        minRating: num("minRating"),
        seller: c.req.query("seller"),
        limit: num("limit"),
      }),
      next: null,
    });
  });
  app.get("/v1/market/listings/:id", (c) => {
    const r = listingRow(ctx, param(c, "id"));
    const rated = ctx.db.prepare("SELECT * FROM jobs WHERE listing_id = ? AND rated_at IS NOT NULL ORDER BY rated_at DESC LIMIT 20").all(r.id) as JobRow[];
    const services: StoreService[] = listServices(ctx, r.seller).filter((s) => s.active);
    return send(c, {
      ...listingView(ctx, r),
      sellerStats: statsOf(statRows(ctx, "AND j.seller = ?", [r.seller])),
      ratings: rated.map((j) => ({ jobId: j.id, buyer: j.buyer, buyerName: publicName(ctx, j.buyer), stars: j.stars, review: j.review, ratedAt: j.rated_at, money: jobView(ctx, j).money })),
      services,
    });
  });
  app.get("/v1/accounts/:safe/listings", (c) => {
    const rows = ctx.db.prepare("SELECT * FROM listings WHERE seller = ? ORDER BY created_at DESC").all(safeParam(c)) as ListingRow[];
    return send(c, { items: rows.map((r) => listingView(ctx, r)), next: null });
  });

  /** An agent lists work it sells, from scratch or from one of its storefront services. */
  app.post("/v1/market/listings", async (c) => {
    const auth = agent(ctx, c, "sell");
    const dep = requireDep(ctx);
    const b = await body(
      c,
      z.object({
        serviceId: z.string().optional(),
        title: z.string().min(1).max(80).optional(),
        description: z.string().max(1000).optional(),
        price: zAmount.optional(),
        deliverySeconds: z.number().int().min(60).max(30 * 86400),
        reviewSeconds: z.number().int().min(60).max(14 * 86400).default(86400),
        arbiter: zAddr.nullable().default(null),
        tags: z.array(z.string().min(1).max(24)).max(6).default([]),
      }),
    );
    let title = b.title;
    let description = b.description;
    let price = b.price;
    if (b.serviceId) {
      const s = listServices(ctx, auth.safe).find((x) => x.id === b.serviceId) ?? fail(404, "not_found", "No storefront service with this id on this account.");
      if (!sameAddress(s.pricing.price.token.address, dep.usdg)) fail(400, "bad_request", "Listings are priced in USDG; this service is not.");
      title ??= s.name;
      description ??= s.description;
      price ??= s.pricing.price.amount;
    }
    if (!title) fail(400, "bad_request", "title: required (or a serviceId to copy it from)");
    if (!price || BigInt(price) === 0n) fail(400, "bad_request", "price: above zero, in USDG base units (6 decimals)");
    if (b.arbiter && (sameAddress(b.arbiter, auth.safe) || sameAddress(b.arbiter, ZERO))) fail(400, "bad_request", "arbiter: a third party, not the seller");
    const lid = id("lst");
    const t = now();
    ctx.db
      .prepare("INSERT INTO listings (id, seller, title, description, token, price, delivery_seconds, review_seconds, arbiter, service_id, tags, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
      .run(lid, lower(auth.safe), title, description ?? "", lower(dep.usdg), price, b.deliverySeconds, b.reviewSeconds, b.arbiter, b.serviceId ?? null, JSON.stringify(b.tags.map((x) => x.toLowerCase())), t, t);
    await ctx.audit.append(`agent:${lower(auth.safe)}`, "listing.created", auth.safe, { listing: lid, title, price });
    return send(c, listingView(ctx, listingRow(ctx, lid)), 201);
  });
  app.patch("/v1/market/listings/:id", async (c) => {
    const auth = agent(ctx, c, "sell");
    const r = listingRow(ctx, param(c, "id"));
    if (!sameAddress(r.seller, auth.safe)) fail(403, "not_yours", "This listing belongs to another account.");
    const b = await body(c, z.object({ active: z.boolean().optional(), price: zAmount.optional(), description: z.string().max(1000).optional(), deliverySeconds: z.number().int().min(60).max(30 * 86400).optional() }));
    if (b.price !== undefined && BigInt(b.price) === 0n) fail(400, "bad_request", "price must be above zero");
    ctx.db
      .prepare("UPDATE listings SET active = COALESCE(?, active), price = COALESCE(?, price), description = COALESCE(?, description), delivery_seconds = COALESCE(?, delivery_seconds), updated_at = ? WHERE id = ?")
      .run(b.active === undefined ? null : b.active ? 1 : 0, b.price ?? null, b.description ?? null, b.deliverySeconds ?? null, now(), r.id);
    return send(c, listingView(ctx, listingRow(ctx, r.id)));
  });

  app.post("/v1/market/hire", async (c) => {
    const auth = agent(ctx, c, "invoices");
    const b = await body(c, z.object({ listingId: z.string().min(1), brief: z.string().min(1).max(4000), context: z.string().max(20000).optional() }));
    const r = await hire(ctx, auth, { listingId: b.listingId, brief: b.brief, trigger: b.context ?? b.brief });
    return send(c, r, statusCode(r.intent.status));
  });
  app.get("/v1/market/jobs/:id", (c) => send(c, jobView(ctx, jobRow(ctx, param(c, "id")))));
  app.get("/v1/market/jobs/:id/detail", async (c) => {
    const j = jobRow(ctx, param(c, "id"));
    await party(ctx, c, [j.buyer, j.seller]);
    return send(c, detailView(ctx, j));
  });
  app.post("/v1/market/jobs/:id/deliver", async (c) => {
    const auth = agent(ctx, c, "invoices");
    const b = await body(c, z.object({ result: z.string().min(1).max(20000) }));
    return send(c, await deliver(ctx, auth, param(c, "id"), b.result));
  });
  app.post("/v1/market/jobs/:id/accept", async (c) => {
    const auth = agent(ctx, c, "invoices");
    const b = await body(c, z.object({ stars: zStars.optional(), review: zReview }));
    return send(c, await accept(ctx, auth, param(c, "id"), b.stars ? { stars: b.stars, review: b.review } : undefined));
  });
  app.post("/v1/market/jobs/:id/dispute", async (c) => {
    const auth = agent(ctx, c, "invoices");
    return send(c, await dispute(ctx, auth, param(c, "id")));
  });
  app.post("/v1/market/jobs/:id/rate", async (c) => {
    const j = jobRow(ctx, param(c, "id"));
    const who = await party(ctx, c, [j.buyer]);
    const b = await body(c, z.object({ stars: zStars, review: zReview }));
    return send(c, await rate(ctx, who.safe, j.id, b));
  });
  app.get("/v1/accounts/:safe/jobs", (c) => {
    const role = c.req.query("role");
    return send(c, { items: listJobs(ctx, safeParam(c), role === "buyer" || role === "seller" ? role : undefined), next: null });
  });
  app.get("/v1/accounts/:safe/hire-rules", async (c) => send(c, await hireRulesView(ctx, safeParam(c))));
  app.put("/v1/accounts/:safe/hire-rules", async (c) => {
    const safe = safeParam(c);
    const who = await safeOwner(ctx, c, safe);
    const b = await body(c, z.object({ mode: z.enum(["any", "listed", "off"]), sellers: z.array(zAddr).max(200).default([]), maxPerJob: zAmount.nullable().default(null) }));
    writeHireRule(ctx, safe, { mode: b.mode, sellers: b.sellers, maxPerJob: b.maxPerJob === null ? null : BigInt(b.maxPerJob) }, now());
    await ctx.audit.append(`owner:${lower(who)}`, "hire_rules.set", safe, { mode: b.mode, sellers: b.sellers.length, maxPerJob: b.maxPerJob });
    return send(c, await hireRulesView(ctx, safe));
  });
});
