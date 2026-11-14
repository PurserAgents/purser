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

// Purser Shield: what one account's firewall catches protects every account.
//
// When the firewall blocks an attack, the attacker's side goes on one list that every account's firewall checks
// before it signs: the payee planted in hidden text, a wallet that forwards everything through delegated code and the
// contract it hands control to, a spender an approval would hand the account to, and a fingerprint of each sentence
// of injected instructions. Only the attacker's side is stored: addresses and one-way fingerprints. Never a balance,
// an owner, an amount, or what the account paid for, and the public feed counts accounts without naming them.
//
// Poisoning guard: an attacker could plant a well-known service's address in a page to get it flagged. So an address
// is never flagged when it is a Purser contract or account, on any owner's list, or already paid by several accounts.
// An owner who put a flagged address on their own list gets a warning instead of a block.
//
// Each account chooses what a match does: "block" (the default) refuses the payment; "warn" holds it until the owner
// releases or rejects it. Scheduled payouts never wait: a match always stops them, and accounts with a subscription or
// stream to a newly flagged payee get a watchdog event that freezes them where auto-freeze is on.

export const SHIELD = {
  trustedPayers: 3, // an address that this many accounts already paid successfully is never flagged
  minSentence: 24, // shorter sentences are too generic to fingerprint
};

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

/** Addresses the Shield never flags: Purser itself, accounts, addresses on an owner's list, payees with a record. */
export function trusted(ctx: Ctx, address: string): boolean {
  const a = lower(address);
  const dep = ctx.dep;
  if (dep && [dep.module, dep.factory, dep.recurring, dep.escrow, dep.passkey, dep.feeRecipient, dep.usdg, dep.weth].some((x) => x && sameAddress(x, a))) return true;
  if (ctx.db.prepare("SELECT 1 FROM accounts WHERE safe = ? LIMIT 1").get(a)) return true;
  if (ctx.db.prepare("SELECT 1 FROM account_sets WHERE kind IN ('allow','vault') AND lower(value) = ? AND on_flag = 1 LIMIT 1").get(a)) return true;
  const payers = ctx.db.prepare("SELECT COUNT(DISTINCT safe) AS n FROM receipts WHERE counterparty = ? AND direction = 'out' AND status = 'executed'").get(a) as { n: number };
  return payers.n >= SHIELD.trustedPayers;
}

export function threatAt(ctx: Ctx, address: string): ThreatRow | null {
  return (ctx.db.prepare("SELECT address, kind, hits, first_seen, last_seen FROM shield_threats WHERE address = ? AND active = 1").get(lower(address)) as ThreatRow | undefined) ?? null;
}

function printAt(ctx: Ctx, print: string): PrintRow | null {
  return (ctx.db.prepare("SELECT print, why, hits, first_seen, last_seen FROM shield_prints WHERE print = ? AND active = 1").get(print) as PrintRow | undefined) ?? null;
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
    const t = threatAt(ctx, a);
    if (!t) continue;
    hit(a, "Flagged by Purser Shield", `${a} is on the Purser Shield list as ${KIND_WORDS[t.kind]}. ${caughtWhere(ctx, a, t.hits, input.safe)}`, own.some((o) => sameAddress(o, a)));
  }
  for (const s of sentencePrints(input.trigger)) {
    const p = printAt(ctx, s.print);
    if (!p) continue;
    hit(s.print, "A known injected instruction", `What the agent read contains a sentence on the Purser Shield list (it ${p.why}): "${s.sentence.slice(0, 160)}". ${caughtWhere(ctx, s.print, p.hits, input.safe)}`, false);
  }
  return out;
}

/** Puts the attacker's side of a blocked verdict on the list. Returns the addresses that are newly flagged. */
export function recordThreats(ctx: Ctx, safe: string, verdictId: string, candidates: ThreatCandidate[], prints: { print: string; why: string }[], t: number): string[] {
  const fresh: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const a = lower(c.address);
    if (seen.has(a) || !/^0x[0-9a-f]{40}$/.test(a) || trusted(ctx, a)) continue;
    seen.add(a);
    const prev = ctx.db.prepare("SELECT active FROM shield_threats WHERE address = ?").get(a) as { active: number } | undefined;
    if (prev) {
      ctx.db.prepare("UPDATE shield_threats SET hits = hits + 1, last_seen = ?, active = 1 WHERE address = ?").run(t, a);
      if (!prev.active) fresh.push(a);
    } else {
      ctx.db.prepare("INSERT INTO shield_threats (address, kind, hits, first_seen, last_seen, first_verdict, active) VALUES (?, ?, 1, ?, ?, ?, 1)").run(a, c.kind, t, t, verdictId);
      fresh.push(a);
    }
    ctx.db.prepare("INSERT INTO shield_hits (item, safe, verdict_id, created_at) VALUES (?, ?, ?, ?)").run(a, lower(safe), verdictId, t);
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
 * A newly flagged address may already be paid on a schedule. Every account with an active subscription or a running
 * stream to it gets a watchdog event that freezes it where auto-freeze is on, because a frozen account cannot be
 * charged on chain. The engine's own payouts to it stop anyway: every payout passes the firewall, and a match on a
 * scheduled payout always stops it.
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
        detail: `This account has ${what} paying ${a}, which another agent's firewall just caught in an attack. Purser stops every payout to it.`,
        freeze: true,
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
  return `It was caught in ${attacks} aimed at ${others === 1 ? "another account" : `${others} other accounts`}. What one agent's firewall catches protects every agent.`;
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
    addresses: one("SELECT COUNT(*) AS n FROM shield_threats WHERE active = 1"),
    prints: one("SELECT COUNT(*) AS n FROM shield_prints WHERE active = 1"),
    attacksCaught: one("SELECT COUNT(*) AS n FROM verdicts WHERE decision = 'block'"),
    stoppedByShield: one("SELECT COUNT(DISTINCT verdict_id) AS n FROM shield_blocks"),
    accountsProtected: one("SELECT COUNT(*) AS n FROM accounts"),
    lastFlaggedAt: Math.max(one("SELECT MAX(last_seen) AS n FROM shield_threats"), one("SELECT MAX(last_seen) AS n FROM shield_prints")) || null,
  };
}

export function shieldFeed(ctx: Ctx, limit = 50) {
  const threats = (ctx.db.prepare("SELECT address, kind, hits, first_seen, last_seen FROM shield_threats WHERE active = 1 ORDER BY last_seen DESC LIMIT ?").all(limit) as ThreatRow[]).map((r) => threatView(ctx, r));
  const prints = (ctx.db.prepare("SELECT print, why, hits, first_seen, last_seen FROM shield_prints WHERE active = 1 ORDER BY last_seen DESC LIMIT ?").all(limit) as PrintRow[]).map((r) => printView(ctx, r));
  return { threats, prints };
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
  app.patch("/v1/accounts/:safe/shield", async (c) => {
    const safe = safeParam(c);
    await safeOwner(ctx, c, safe);
    const b = await body(c, z.object({ mode: z.enum(["block", "warn"]) }));
    ctx.db.prepare("INSERT INTO shield_settings (safe, mode) VALUES (?, ?) ON CONFLICT(safe) DO UPDATE SET mode = excluded.mode").run(safe, b.mode);
    await ctx.audit.append(`owner:${safe}`, "shield.mode", safe, { mode: b.mode });
    return send(c, { safe, mode: b.mode });
  });
});
