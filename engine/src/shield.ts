import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import type { Address } from "viem";
import type { ShieldMode, ShieldPrint, ShieldStats, ShieldThreat, VerdictReason } from "../../packages/sdk/src/schema.ts";
import { setsOf } from "./accounts.ts";
import { registerRoutes } from "./api/registry.ts";
import { body, safeOwner, safeParam, send } from "./api/http.ts";
import { chainNow, type Ctx } from "./ctx.ts";
import { fail, lower, sameAddress } from "./util.ts";
import { react } from "./watchdog.ts";

// Purser Shield: what an account's firewall catches protects that account, and every account once 3 accounts agree.
//
// When the firewall blocks an attack, the attacker's side goes on one list that every account's firewall checks
// before it signs: the payee planted in hidden text, a wallet that forwards everything through delegated code and the
// contract it hands control to, a spender an approval would hand the account to, and a fingerprint of each sentence
// of injected instructions. Only the attacker's side is stored: addresses and one-way fingerprints. Never a balance,
// an owner, an amount, or what the account paid for, and the public feed counts accounts without naming them.
//
// Poisoning guard: an attacker could plant a well-known service's address in a page to get it flagged. So:
// - only a block on a real account, signed by its own agent key, reports anything (never a request that fails as
//   "not an account" or "wrong agent key");
// - an entry protects only the account that reported it until enough independent accounts in good standing reported
//   it; then it protects every account. Good standing: at least $25 paid out in listed tokens to at least three
//   different payees, the first of those payments at least 30 days old, and at least $5 of it spent where the account
//   cannot take it back: model credit used up by calls (credit not used can be withdrawn), or payments to another
//   account that shares no owner with it and never paid it or its owners' accounts back. Independent:
//   accounts that share an owner (any owner they were ever seen with) or paid each other are one group, and each group
//   counts once. A reporter that itself paid or was paid by the
//   address does not count for it. Entries not seen again for a while stop counting, and an owner can take back
//   their account's report;
// - Purser accounts are reported like any address: a Safe is cheap to make, so exempting accounts would give every
//   attacker a payee the list can never name. Under the rules above, listing an honest account for everyone takes
//   three independent accounts in good standing each caught by an attack that plants it.
// - an address is never flagged when it is a Purser contract, on the reporting account's own list, or
//   paid at least $1 each by enough independent accounts in good standing. One owner's accounts are one group, so
//   an owner cannot vouch for its own counterparties. An owner who put a flagged address on their own list gets a
//   warning instead.
//
// Each account chooses what a match does: "block" (the default) refuses the payment; "warn" holds it until the owner
// releases or rejects it. Scheduled payouts never wait: a match always stops them, and accounts with a subscription or
// stream to a newly flagged payee are told (never frozen because of a list entry).

export const SHIELD = {
  trustedPayers: 3, // an address this many independent accounts in good standing paid is never flagged
  trustedPaidUsdMicro: 1_000_000n, // each of them paid it at least $1
  reportersForAll: 3, // an entry protects every account once this many independent accounts in good standing reported it
  standingUsdMicro: 25_000_000n, // good standing: at least $25 paid out in listed tokens
  standingPayees: 3, // to at least this many different payees
  standingAgeDays: 30, // the first of those payments at least this old
  standingSpentMicro: 5_000_000n, // and at least $5 of it where the account cannot take it back
  ttlDays: 30, // an entry no account reported for this long stops counting
  minSentence: 24, // shorter sentences are too generic to fingerprint
};

/** Block reasons that mean the request did not come from a real account's own agent: such a block reports nothing. */
export const NOT_GENUINE = new Set(["not_account", "wrong_agent_key", "bad_cosign", "firewall_key", "no_simulation"]);

type ThreatKind = ShieldThreat["kind"];

export interface ThreatCandidate {
  address: string;
  kind: ThreatKind;
}

interface ThreatRow {
  address: string;
  kind: ThreatKind;
  hits: number;
  first_seen: number;
  last_seen: number;
}

interface PrintRow {
  print: string;
  why: string;
  hits: number;
  first_seen: number;
  last_seen: number;
}

export const KIND_WORDS: Record<ThreatKind, string> = {
  planted_payee: "a payee planted in hidden text",
  forwarding_wallet: "a wallet that forwards what it receives through delegated code",
  forwarding_code: "the contract that forwarding wallets hand control to",
  spender: "a spender an approval would have handed the account to",
};

// ---------------------------------------------------------------------------------------------------- fingerprints

/** The text as a person would read it: no tags, comments, zero-width or direction characters. */
export function plainText(text: string): string {
  return text
    .replace(/<!--|-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[​-‍⁠﻿‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences long enough to be specific, each with its one-way fingerprint. Addresses and numbers are masked so the
 *  same planted sentence matches when only the address or the amount changes. */
export function sentencePrints(text: string | null | undefined): { sentence: string; print: string }[] {
  if (!text) return [];
  const out: { sentence: string; print: string }[] = [];
  const seen = new Set<string>();
  for (const s of plainText(text).split(/(?<=[.!?])\s+|\n+/)) {
    const norm = s
      .toLowerCase()
      .replace(/0x[0-9a-f]{40}/g, " addr ")
      .replace(/[0-9]+([.,][0-9]+)?/g, " n ")
      .replace(/[^a-z]+/g, " ")
      .trim();
    if (norm.length < SHIELD.minSentence || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ sentence: s.trim(), print: createHash("sha256").update(norm).digest("hex").slice(0, 24) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- the list

/**
 * Addresses the Shield never flags: Purser itself, accounts (rows exist only for real Safes), payees several accounts
 * paid. One owner's list does not protect an address for everyone; it only means that owner is warned, not blocked.
 */
export function trusted(ctx: Ctx, address: string): boolean {
  const a = lower(address);
  const dep = ctx.dep;
  if (dep && [dep.module, dep.factory, dep.recurring, dep.escrow, dep.passkey, dep.feeRecipient, dep.usdg, dep.weth].some((x) => x && sameAddress(x, a))) return true;
  // Purser's own payees and keys: the models address (every top-up goes there) and the engine's keys
  const own = [process.env.PURSER_MODELS_PAYTO, ...Object.values(ctx.chain.accounts).map((k) => k?.address)];
  if (own.some((x) => x && sameAddress(x, a))) return true;
  const payers = (
    ctx.db
      .prepare(
        `SELECT r.safe FROM receipts r JOIN accounts a ON a.safe = r.safe WHERE r.counterparty = ? AND r.direction = 'out' AND r.status = 'executed'
         GROUP BY r.safe HAVING SUM(CAST(r.usd_micro AS INTEGER)) >= ?`,
      )
      .all(a, SHIELD.trustedPaidUsdMicro) as { safe: string }[]
  )
    .map((r) => r.safe)
    .filter((s) => inStanding(ctx, s));
  return groups(ctx, payers) >= SHIELD.trustedPayers;
}

/**
 * Good standing: at least $25 paid out in listed tokens to at least three payees, the first payment 30 days old, and at
 * least $5 of it spent where the account cannot take it back. Only two things count as that: model credit used up by
 * calls (unused credit can be withdrawn, so a top-up alone does not count), and payments to another account that shares
 * no owner with this one and never paid this account, or any account of its owners, back.
 */
export function inStanding(ctx: Ctx, safe: string): boolean {
  const s = lower(safe);
  const r = ctx.db
    .prepare(
      "SELECT COALESCE(SUM(CAST(usd_micro AS INTEGER)), 0) AS paid, MIN(created_at) AS first, COUNT(DISTINCT counterparty) AS payees FROM receipts WHERE safe = ? AND direction = 'out' AND status = 'executed' AND CAST(usd_micro AS INTEGER) > 0",
    )
    .get(s) as { paid: number; first: number | null; payees: number };
  if (BigInt(r.paid) < SHIELD.standingUsdMicro || r.payees < SHIELD.standingPayees) return false;
  if (r.first === null || r.first > Math.floor(Date.now() / 1000) - SHIELD.standingAgeDays * 86400) return false;
  const used = BigInt((ctx.db.prepare("SELECT COALESCE(SUM(CAST(cost_micro AS INTEGER)), 0) AS n FROM model_calls WHERE safe = ? AND provider = 'purser'").get(s) as { n: number }).n);
  if (used >= SHIELD.standingSpentMicro) return true;
  const mine = new Set(ownersOf(ctx, s));
  // this account and every account that shares an owner with it: money paid back to any of them came back
  const family = new Set([s, ...(ctx.db.prepare("SELECT safe FROM accounts").all() as { safe: string }[]).map((x) => x.safe).filter((x) => ownersOf(ctx, x).some((o) => mine.has(o)))]);
  const toAccounts = ctx.db
    .prepare(
      `SELECT r.counterparty AS cp, SUM(CAST(r.usd_micro AS INTEGER)) AS micro FROM receipts r JOIN accounts a ON a.safe = r.counterparty
       WHERE r.safe = ? AND r.direction = 'out' AND r.status = 'executed' GROUP BY r.counterparty`,
    )
    .all(s) as { cp: string; micro: number }[];
  let spent = used;
  for (const x of toAccounts) {
    if (family.has(x.cp)) continue;
    const back = [...family].some((f) => ctx.db.prepare("SELECT 1 FROM receipts WHERE safe = ? AND counterparty = ? AND direction = 'out' AND status = 'executed' LIMIT 1").get(x.cp, f));
    if (!back) spent += BigInt(x.micro);
  }
  return spent >= SHIELD.standingSpentMicro;
}

/** Every owner an account was ever seen with: its row and what the indexer remembered. */
export function ownersOf(ctx: Ctx, safe: string): string[] {
  const row = ctx.db.prepare("SELECT owners FROM accounts WHERE safe = ?").get(lower(safe)) as { owners: string } | undefined;
  const seen = ctx.db.prepare("SELECT value FROM kv WHERE key = ?").get(`owners_seen:${lower(safe)}`) as { value: string } | undefined;
  return [...new Set([...(JSON.parse(row?.owners ?? "[]") as string[]), ...(JSON.parse(seen?.value ?? "[]") as string[])].map((o) => o.toLowerCase()))];
}

/**
 * How many independent groups these accounts form. Accounts that share an owner, or paid each other, are one group:
 * one owner's many accounts, or accounts funded from one another, count once.
 */
export function groups(ctx: Ctx, safes: string[]): number {
  const list = [...new Set(safes.map(lower))];
  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owners = list.map((s) => new Set(ownersOf(ctx, s)));
  const linked = (x: string, y: string) => !!ctx.db.prepare("SELECT 1 FROM receipts WHERE (safe = ? AND counterparty = ?) OR (safe = ? AND counterparty = ?) LIMIT 1").get(x, y, y, x);
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      if ([...owners[i]].some((o) => owners[j].has(o)) || linked(list[i], list[j])) parent[find(i)] = find(j);
  return new Set(list.map((_, i) => find(i))).size;
}

const freshSince = () => Math.floor(Date.now() / 1000) - SHIELD.ttlDays * 86400;

/**
 * Accounts whose report of an item counts for others: in good standing, and never paid by or paying the address
 * themselves (an owner cannot list its own counterparty, or a wallet it funded).
 */
export function reporters(ctx: Ctx, item: string): string[] {
  return (
    ctx.db
      .prepare(
        `SELECT DISTINCT h.safe FROM shield_hits h JOIN accounts a ON a.safe = h.safe
         WHERE h.item = ? AND h.created_at >= ? AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.safe = h.safe AND r.counterparty = h.item)`,
      )
      .all(item, freshSince()) as { safe: string }[]
  )
    .map((r) => r.safe)
    .filter((s) => inStanding(ctx, s));
}

/** Independent groups of reporters: what decides whether an entry protects every account. */
export const reporterGroups = (ctx: Ctx, item: string) => groups(ctx, reporters(ctx, item));

/** Does this entry count for every account (null: the public view) or for this one account? */
function counts(ctx: Ctx, item: string, safe: string | null): boolean {
  if (reporterGroups(ctx, item) >= SHIELD.reportersForAll) return true;
  return !!safe && !!ctx.db.prepare("SELECT 1 FROM shield_hits WHERE item = ? AND safe = ? AND created_at >= ? LIMIT 1").get(item, lower(safe), freshSince());
}

/** The list entry for an address as it applies to `safe` (null: only entries that protect every account). */
export function threatAt(ctx: Ctx, address: string, safe: string | null = null): ThreatRow | null {
  const r = ctx.db.prepare("SELECT address, kind, hits, first_seen, last_seen FROM shield_threats WHERE address = ? AND active = 1 AND last_seen >= ?").get(lower(address), freshSince()) as ThreatRow | undefined;
  return r && counts(ctx, r.address, safe) ? r : null;
}

function printAt(ctx: Ctx, print: string, safe: string | null = null): PrintRow | null {
  const r = ctx.db.prepare("SELECT print, why, hits, first_seen, last_seen FROM shield_prints WHERE print = ? AND active = 1 AND last_seen >= ?").get(print, freshSince()) as PrintRow | undefined;
  return r && counts(ctx, r.print, safe) ? r : null;
}

export function shieldMode(ctx: Ctx, safe: string): ShieldMode {
  const r = ctx.db.prepare("SELECT mode FROM shield_settings WHERE safe = ?").get(lower(safe)) as { mode: ShieldMode } | undefined;
  return r?.mode ?? "block";
}

export interface ShieldCheck {
  reasons: VerdictReason[];
  /** the payment should wait for the owner (warn mode) instead of going out */
  hold: boolean;
  /** what matched, for counting a stop */
  matched: string[];
}

/**
 * Checks everything a payment touches against the shared list. `addresses` are the payee, the delegated code behind
 * it, every recipient of value and every spender of an approval; `trigger` is the text the agent read.
 */
export function shieldCheck(ctx: Ctx, input: { safe: string; addresses: string[]; trigger?: string | null; agreed?: boolean; ownerApproved?: boolean }): ShieldCheck {
  const out: ShieldCheck = { reasons: [], hold: false, matched: [] };
  const mode = shieldMode(ctx, input.safe);
  const own = setsOf(ctx, input.safe, "allow");
  const hit = (matchedOn: string, title: string, detail: string, onOwnersList: boolean) => {
    if (othersFor(ctx, matchedOn, input.safe) > 0) out.matched.push(matchedOn); // counted as the Shield's stop only when another account was hit
    if (onOwnersList) {
      out.reasons.push({ code: "shield_listed", severity: "warn", title: "Flagged by Purser Shield, but on your list", detail: `${detail} You put this address on your own list, so the payment is not stopped.` });
    } else if (input.agreed || mode === "block") {
      out.reasons.push({ code: "shield", severity: "block", title, detail });
    } else if (input.ownerApproved) {
      out.reasons.push({ code: "shield_released", severity: "warn", title: `${title}, released by the owner`, detail });
    } else {
      out.hold = true;
      out.reasons.push({ code: "shield_hold", severity: "warn", title: `${title}: waiting for the owner`, detail: `${detail} This account is set to warn, so the payment waits until the owner releases or rejects it.` });
    }
  };
  const seen = new Set<string>();
  for (const x of input.addresses) {
    const a = lower(x);
    if (!/^0x[0-9a-f]{40}$/.test(a) || seen.has(a)) continue;
    seen.add(a);
    const t = threatAt(ctx, a, input.safe);
    if (!t) continue;
    hit(a, "Flagged by Purser Shield", `${a} is on the Purser Shield list as ${KIND_WORDS[t.kind]}. ${caughtWhere(ctx, a, t.hits, input.safe)}`, own.some((o) => sameAddress(o, a)));
  }
  for (const s of sentencePrints(input.trigger)) {
    const p = printAt(ctx, s.print, input.safe);
    if (!p) continue;
    hit(s.print, "A known injected instruction", `What the agent read contains a sentence on the Purser Shield list (it ${p.why}): "${s.sentence.slice(0, 160)}". ${caughtWhere(ctx, s.print, p.hits, input.safe)}`, false);
  }
  return out;
}

/**
 * Puts the attacker's side of a blocked verdict on the list, as this account's report. Returns the addresses that
 * now protect every account and did not before (so schedules to them can be looked at).
 */
export function recordThreats(ctx: Ctx, safe: string, verdictId: string, candidates: ThreatCandidate[], prints: { print: string; why: string }[], t: number): string[] {
  const fresh: string[] = [];
  const seen = new Set<string>();
  const own = setsOf(ctx, safe, "allow");
  for (const c of candidates) {
    const a = lower(c.address);
    if (seen.has(a) || !/^0x[0-9a-f]{40}$/.test(a) || trusted(ctx, a) || own.some((o) => sameAddress(o, a))) continue;
    seen.add(a);
    const wasForAll = !!threatAt(ctx, a);
    const prev = ctx.db.prepare("SELECT active FROM shield_threats WHERE address = ?").get(a) as { active: number } | undefined;
    if (prev) ctx.db.prepare("UPDATE shield_threats SET hits = hits + 1, last_seen = ?, active = 1 WHERE address = ?").run(t, a);
    else ctx.db.prepare("INSERT INTO shield_threats (address, kind, hits, first_seen, last_seen, first_verdict, active) VALUES (?, ?, 1, ?, ?, ?, 1)").run(a, c.kind, t, t, verdictId);
    ctx.db.prepare("INSERT INTO shield_hits (item, safe, verdict_id, created_at) VALUES (?, ?, ?, ?)").run(a, lower(safe), verdictId, t);
    if (!wasForAll && threatAt(ctx, a)) fresh.push(a);
  }
  const seenPrints = new Set<string>();
  for (const p of prints) {
    if (seenPrints.has(p.print)) continue;
    seenPrints.add(p.print);
    const prev = ctx.db.prepare("SELECT 1 FROM shield_prints WHERE print = ?").get(p.print);
    if (prev) ctx.db.prepare("UPDATE shield_prints SET hits = hits + 1, last_seen = ?, active = 1 WHERE print = ?").run(t, p.print);
    else ctx.db.prepare("INSERT INTO shield_prints (print, why, hits, first_seen, last_seen, first_verdict, active) VALUES (?, ?, 1, ?, ?, ?, 1)").run(p.print, p.why, t, t, verdictId);
    ctx.db.prepare("INSERT INTO shield_hits (item, safe, verdict_id, created_at) VALUES (?, ?, ?, ?)").run(p.print, lower(safe), verdictId, t);
  }
  return fresh;
}

/** Counts a payment the Shield stopped or held on another account. */
export function recordShieldStop(ctx: Ctx, safe: string, verdictId: string, items: string[], t: number) {
  for (const it of new Set(items)) ctx.db.prepare("INSERT OR IGNORE INTO shield_blocks (verdict_id, item, safe, created_at) VALUES (?, ?, ?, ?)").run(verdictId, it, lower(safe), t);
}

/**
 * An address that now protects every account may already be paid on a schedule. Every account with an active
 * subscription or a running stream to it is told. The engine's payouts to it stop: every payout passes the firewall,
 * and a match on a scheduled payout always stops it. A list entry never freezes an account; the owner decides.
 */
export async function protectSchedules(ctx: Ctx, address: string) {
  const a = lower(address);
  const t = await chainNow(ctx);
  const subs = ctx.db.prepare("SELECT safe, COUNT(*) AS n FROM subscriptions WHERE payee = ? AND active = 1 AND charges_left > 0 GROUP BY safe").all(a) as { safe: string; n: number }[];
  const streams = ctx.db.prepare("SELECT safe, COUNT(*) AS n FROM streams WHERE payee = ? AND stopped = 0 AND end_at > ? GROUP BY safe").all(a, t) as { safe: string; n: number }[];
  const bySafe = new Map<string, { subs: number; streams: number }>();
  for (const s of subs) bySafe.set(s.safe, { subs: s.n, streams: 0 });
  for (const s of streams) bySafe.set(s.safe, { subs: bySafe.get(s.safe)?.subs ?? 0, streams: s.n });
  for (const [safe, n] of bySafe) {
    const what = [n.subs ? `${n.subs} subscription${n.subs === 1 ? "" : "s"}` : "", n.streams ? `${n.streams} stream${n.streams === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    await react(ctx, safe as Address, [
      {
        kind: "shield",
        severity: "critical",
        title: "A payee you pay on a schedule was flagged by Purser Shield",
        detail: `This account has ${what} paying ${a}, which other agents' firewalls caught in attacks. Purser stops the scheduled payouts to it; nothing else changes until you look.`,
        freeze: false,
      },
    ]).catch(() => undefined);
  }
  return bySafe.size;
}

// ---------------------------------------------------------------------------------------------------- public view

function othersFor(ctx: Ctx, item: string, safe: string): number {
  return (ctx.db.prepare("SELECT COUNT(DISTINCT safe) AS n FROM shield_hits WHERE item = ? AND safe <> ?").get(item, lower(safe)) as { n: number }).n;
}

/** Where the list entry came from, in words, from this account's point of view. */
function caughtWhere(ctx: Ctx, item: string, hits: number, safe: string): string {
  const others = othersFor(ctx, item, safe);
  const attacks = hits === 1 ? "one attack" : `${hits} attacks`;
  if (others === 0) return `This account's own firewall caught it in an earlier attack; it stays refused.`;
  return `It was caught in ${attacks} aimed at ${others === 1 ? "another account" : `${others} other accounts`}. Once 3 independent accounts with a payment history report an attacker, every account refuses it.`;
}

function accountsAimedAt(ctx: Ctx, item: string): number {
  return (ctx.db.prepare("SELECT COUNT(DISTINCT safe) AS n FROM shield_hits WHERE item = ?").get(item) as { n: number }).n;
}

function stoppedElsewhere(ctx: Ctx, item: string): number {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM shield_blocks WHERE item = ?").get(item) as { n: number }).n;
}

const threatView = (ctx: Ctx, r: ThreatRow): ShieldThreat => ({
  address: r.address as Address,
  kind: r.kind,
  what: KIND_WORDS[r.kind],
  attacks: r.hits,
  accounts: accountsAimedAt(ctx, r.address),
  stoppedElsewhere: stoppedElsewhere(ctx, r.address),
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
});

const printView = (ctx: Ctx, r: PrintRow): ShieldPrint => ({
  print: r.print,
  why: r.why,
  attacks: r.hits,
  accounts: accountsAimedAt(ctx, r.print),
  stoppedElsewhere: stoppedElsewhere(ctx, r.print),
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
});

export function shieldStats(ctx: Ctx): ShieldStats {
  const one = (sql: string) => (ctx.db.prepare(sql).get() as { n: number | null }).n ?? 0;
  return {
    addresses: forAll(ctx, "threats").length,
    prints: forAll(ctx, "prints").length,
    attacksCaught: one("SELECT COUNT(*) AS n FROM verdicts WHERE decision = 'block'"),
    stoppedByShield: one("SELECT COUNT(DISTINCT verdict_id) AS n FROM shield_blocks"),
    accountsProtected: one("SELECT COUNT(*) AS n FROM accounts"),
    lastFlaggedAt: Math.max(one("SELECT MAX(last_seen) AS n FROM shield_threats"), one("SELECT MAX(last_seen) AS n FROM shield_prints")) || null,
  };
}

/** Entries that protect every account (the public list); one account's own report is not shown. */
function forAll(ctx: Ctx, which: "threats"): ThreatRow[];
function forAll(ctx: Ctx, which: "prints"): PrintRow[];
function forAll(ctx: Ctx, which: "threats" | "prints"): (ThreatRow | PrintRow)[] {
  const rows =
    which === "threats"
      ? (ctx.db.prepare("SELECT address, kind, hits, first_seen, last_seen FROM shield_threats WHERE active = 1 AND last_seen >= ? ORDER BY last_seen DESC").all(freshSince()) as ThreatRow[])
      : (ctx.db.prepare("SELECT print, why, hits, first_seen, last_seen FROM shield_prints WHERE active = 1 AND last_seen >= ? ORDER BY last_seen DESC").all(freshSince()) as PrintRow[]);
  return rows.filter((r) => reporterGroups(ctx, "address" in r ? r.address : r.print) >= SHIELD.reportersForAll);
}

export function shieldFeed(ctx: Ctx, limit = 50) {
  const threats = forAll(ctx, "threats").slice(0, limit).map((r) => threatView(ctx, r));
  const prints = forAll(ctx, "prints").slice(0, limit).map((r) => printView(ctx, r));
  return { threats, prints };
}

/** The owner takes back this account's report of an address or a fingerprint. An entry nobody reports any more ends. */
export function withdrawReport(ctx: Ctx, safe: string, item: string): boolean {
  const it = item.toLowerCase();
  const n = ctx.db.prepare("DELETE FROM shield_hits WHERE item = ? AND safe = ?").run(it, lower(safe)).changes;
  if (!ctx.db.prepare("SELECT 1 FROM shield_hits WHERE item = ? LIMIT 1").get(it)) {
    ctx.db.prepare("UPDATE shield_threats SET active = 0 WHERE address = ?").run(it);
    ctx.db.prepare("UPDATE shield_prints SET active = 0 WHERE print = ?").run(it);
  }
  return n > 0;
}

registerRoutes((app: Hono, ctx: Ctx) => {
  app.get("/v1/shield", (c) => send(c, { stats: shieldStats(ctx), ...shieldFeed(ctx) }));
  app.get("/v1/shield/address/:address", (c) => {
    const address = c.req.param("address");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) fail(400, "bad_address", "Not an address.");
    const t = threatAt(ctx, address);
    return send(c, { address: lower(address), flagged: !!t, threat: t ? threatView(ctx, t) : null });
  });
  app.get("/v1/accounts/:safe/shield", (c) => {
    const safe = safeParam(c);
    const held = ctx.db
      .prepare("SELECT i.id, i.summary, i.to_addr AS \"to\", i.created_at AS createdAt, v.reasons FROM intents i LEFT JOIN verdicts v ON v.id = i.verdict_id WHERE i.safe = ? AND i.status = 'held' ORDER BY i.created_at DESC")
      .all(safe) as { id: string; summary: string; to: string; createdAt: number; reasons: string | null }[];
    return send(c, {
      safe,
      mode: shieldMode(ctx, safe),
      held: held.map((h) => {
        const reason = (JSON.parse(h.reasons ?? "[]") as VerdictReason[]).find((r) => r.code === "shield_hold");
        return { id: h.id, summary: h.summary, to: h.to, createdAt: h.createdAt, why: reason?.detail ?? null };
      }),
    });
  });
  app.delete("/v1/accounts/:safe/shield/reports/:item", async (c) => {
    const safe = safeParam(c);
    await safeOwner(ctx, c, safe);
    const item = c.req.param("item");
    if (!/^(0x[0-9a-fA-F]{40}|[0-9a-f]{24})$/.test(item)) fail(400, "bad_item", "An address or a fingerprint.");
    if (!withdrawReport(ctx, safe, item)) fail(404, "not_found", "This account has not reported that.");
    await ctx.audit.append(`owner:${safe}`, "shield.withdrawn", safe, { item: item.toLowerCase() });
    return send(c, { ok: true });
  });
  app.patch("/v1/accounts/:safe/shield", async (c) => {
    const safe = safeParam(c);
    await safeOwner(ctx, c, safe);
    const b = await body(c, z.object({ mode: z.enum(["block", "warn"]) }));
    ctx.db.prepare("INSERT INTO shield_settings (safe, mode) VALUES (?, ?) ON CONFLICT(safe) DO UPDATE SET mode = excluded.mode").run(safe, b.mode);
    await ctx.audit.append(`owner:${safe}`, "shield.mode", safe, { mode: b.mode });
    return send(c, { safe, mode: b.mode });
  });
});
