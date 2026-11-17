/**
 * Purser in your pocket: the owner's phone.
 *
 * - Pairing: a signed-in owner (wallet session) asks for a short code; the phone enters it and gets a device token.
 *   The device token can read the owner's agents, receive notifications and freeze an agent. It can never move
 *   money or unfreeze: approvals are signed by the phone's passkey and checked on chain, unfreezing is the wallet's.
 * - Notifications: Web Push (RFC 8291 encryption, RFC 8292 VAPID), built on node:crypto, no third party.
 * - Freeze from the phone: sent with the watchdog key, only for accounts whose owner allowed the watchdog to freeze.
 * - A daily statement at 08:00 in the phone's time zone: what each agent spent, earned and was stopped from doing,
 *   and a weekly report on Monday morning.
 * - Face ID actions the engine checks itself: releasing or rejecting a payment Purser Shield held, and unlocking the
 *   app. The phone signs a single-use challenge with the passkey it registered at pairing; the engine verifies the
 *   WebAuthn assertion (P-256) against that public key before it does anything.
 * - Quiet hours per phone: only payments waiting for the owner and watchdog freezes get through.
 *
 * Switch: PURSER_POCKET=off turns all of it off (routes answer 404, nothing is sent).
 */
import { createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, randomInt, sign, verify, createCipheriv, type KeyObject } from "node:crypto";
import type { Hono } from "hono";
import { encodeFunctionData, type Address } from "viem";
import { z } from "zod";
import { purserModuleAbi } from "../../packages/sdk/src/abi.ts";
import type { EngineEvent, Intent, Money, Verdict, WatchdogEvent } from "../../packages/sdk/src/schema.ts";
import { accountRow, listAccounts, readAccount, readChainAccount } from "./accounts.ts";
import { registerRoutes } from "./api/registry.ts";
import { body, owner, param, send, zAddr } from "./api/http.ts";
import { getApproval } from "./approvals.ts";
import { explainRevert } from "./chain.ts";
import { chainNow, requireDep, type Ctx } from "./ctx.ts";
import { kvGet, kvSet } from "./db.ts";
import { registerTask } from "./engine.ts";
import { ingestReceipt } from "./indexer.ts";
import { guardedFetch } from "./netguard.ts";
import { rejectHeld, releaseHeld } from "./intents.ts";
import { getIntentRow, intentFromRow, listReceipts, receiptFromRow, type IntentRow, type ReceiptRow } from "./receipts.ts";
import { fail, id, lower, now, parseJson, sameAddress, usd } from "./util.ts";

export const pocketOn = () => (process.env.PURSER_POCKET ?? "on").toLowerCase() !== "off";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pocket_codes (code TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL, device_id TEXT);
CREATE TABLE IF NOT EXISTS pocket_devices (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tz TEXT NOT NULL DEFAULT 'UTC',
  prefs TEXT NOT NULL DEFAULT '{}',
  passkey TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pocket_devices_owner ON pocket_devices(owner);
CREATE TABLE IF NOT EXISTS pocket_push (endpoint TEXT PRIMARY KEY, device_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pocket_statements (device_id TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (device_id, day));
CREATE TABLE IF NOT EXISTS pocket_challenges (nonce TEXT PRIMARY KEY, device_id TEXT NOT NULL, purpose TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
`;

const ready = new WeakSet<Ctx>();
function ensure(ctx: Ctx) {
  if (ready.has(ctx)) return;
  ctx.db.exec(SCHEMA);
  ready.add(ctx);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

// ------------------------------------------------------------------------------------------------ preferences

export interface PocketPrefs {
  approvals: boolean; // a payment waits for you (always on in the app; kept for completeness)
  blocked: boolean; // the firewall, the rules or the Shield stopped a payment
  watchdog: boolean; // the watchdog found something or froze an agent
  budget: boolean; // a daily budget was reached, a balance ran low
  statement: boolean; // the daily statement at 08:00
  weekly: boolean; // the weekly report, Monday 08:00
  quiet: boolean; // quiet hours: only payments waiting for the owner and watchdog freezes are sent
  quietFrom: number; // minutes after local midnight
  quietTo: number;
  lock: boolean; // the app asks for Face ID when it opens
}
export type NoteKind = "approvals" | "blocked" | "watchdog" | "budget" | "statement" | "weekly";
const DEFAULT_PREFS: PocketPrefs = { approvals: true, blocked: true, watchdog: true, budget: true, statement: true, weekly: true, quiet: false, quietFrom: 22 * 60, quietTo: 7 * 60, lock: false };

/** True while the phone's quiet hours run (they may pass midnight). */
export function inQuietHours(prefs: PocketPrefs, tz: string, t: number): boolean {
  if (!prefs.quiet || prefs.quietFrom === prefs.quietTo) return false;
  const m = Math.floor(localClock(t, tz).sinceMidnight / 60);
  return prefs.quietFrom < prefs.quietTo ? m >= prefs.quietFrom && m < prefs.quietTo : m >= prefs.quietFrom || m < prefs.quietTo;
}
const prefsOf = (raw: string | null | undefined): PocketPrefs => ({ ...DEFAULT_PREFS, ...parseJson<Partial<PocketPrefs>>(raw ?? "{}", {}) });

interface DeviceRow {
  id: string;
  owner: string;
  token_hash: string;
  name: string;
  tz: string;
  prefs: string;
  passkey: string | null;
  created_at: number;
  last_seen: number;
  revoked: number;
}

export interface PocketDevice {
  id: string;
  name: string;
  tz: string;
  prefs: PocketPrefs;
  push: boolean;
  /** this phone made a Face ID key when it was paired */
  passkey: boolean;
  createdAt: number;
  lastSeen: number;
}

function deviceView(ctx: Ctx, r: DeviceRow): PocketDevice {
  const push = !!ctx.db.prepare("SELECT 1 FROM pocket_push WHERE device_id = ?").get(r.id);
  return { id: r.id, name: r.name, tz: r.tz, prefs: prefsOf(r.prefs), push, passkey: !!r.passkey, createdAt: r.created_at, lastSeen: r.last_seen };
}

/** The phone behind a device token (Authorization: Bearer dev_...). */
export function authDevice(ctx: Ctx, header: string | undefined): DeviceRow {
  ensure(ctx);
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token?.startsWith("dev_")) fail(401, "unauthorized", "This phone is not paired. Pair it from the dashboard on your computer.");
  const row = ctx.db.prepare("SELECT * FROM pocket_devices WHERE token_hash = ? AND revoked = 0").get(sha256(token!)) as DeviceRow | undefined;
  if (!row) fail(401, "unauthorized", "This phone was unpaired. Pair it again from the dashboard on your computer.");
  const t = now();
  if (t - row!.last_seen > 60) ctx.db.prepare("UPDATE pocket_devices SET last_seen = ? WHERE id = ?").run(t, row!.id);
  return row!;
}

// ------------------------------------------------------------------------------------------------ pairing

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const CODE_TTL = 600;

export function newPairCode(ctx: Ctx, ownerAddr: string): { code: string; expires: number } {
  ensure(ctx);
  const t = now();
  ctx.db.prepare("DELETE FROM pocket_codes WHERE expires < ?").run(t - 3600);
  let code = "";
  for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  ctx.db.prepare("INSERT INTO pocket_codes (code, owner, expires) VALUES (?, ?, ?)").run(code, lower(ownerAddr), t + CODE_TTL);
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires: t + CODE_TTL };
}

const normCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

// Wrong codes are counted; past the limit claims are refused for a minute (a code has 31^8 possibilities and lives 10 minutes).
let claimFails: number[] = [];

export function claimPairCode(ctx: Ctx, input: { code: string; name: string; tz: string; passkey?: { x: string; y: string; credentialId: string } | null }) {
  ensure(ctx);
  const t = now();
  claimFails = claimFails.filter((x) => t - x < 60);
  if (claimFails.length >= 30) fail(429, "too_many", "Too many wrong codes. Wait a minute and try again.");
  const row = ctx.db.prepare("SELECT * FROM pocket_codes WHERE code = ?").get(normCode(input.code)) as { code: string; owner: string; expires: number; device_id: string | null } | undefined;
  if (!row || row.expires < t || row.device_id) {
    claimFails.push(t);
    fail(400, "bad_code", row && row.device_id ? "This code was already used. Make a new one on your computer." : row ? "This code expired. Make a new one on your computer." : "That code is not right. Check it on your computer and try again.");
  }
  const token = `dev_${randomBytes(24).toString("base64url")}`;
  const did = id("dev");
  ctx.db
    .prepare("INSERT INTO pocket_devices (id, owner, token_hash, name, tz, prefs, passkey, created_at, last_seen) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)")
    .run(did, row!.owner, sha256(token), input.name.slice(0, 60) || "Phone", safeTz(input.tz), input.passkey ? JSON.stringify(input.passkey) : null, t, t);
  ctx.db.prepare("UPDATE pocket_codes SET device_id = ? WHERE code = ?").run(did, row!.code);
  void ctx.audit.append(`owner:${row!.owner}`, "pocket.paired", null, { device: did });
  return { token, deviceId: did, owner: row!.owner as Address };
}

function safeTz(tz: string | undefined): string {
  try {
    if (tz) {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
      return tz;
    }
  } catch {
    /* fall through */
  }
  return "UTC";
}

// ------------------------------------------------------------------------------------------------ web push

interface Vapid {
  publicKey: string; // base64url, 65 bytes uncompressed P-256 point
  key: KeyObject;
}
let vapidCache: { ctx: Ctx; v: Vapid } | null = null;

/** The engine's VAPID key: from PURSER_VAPID_JSON ({"jwk": {...}}) on a host, else made once and kept in the database. */
export function vapid(ctx: Ctx): Vapid {
  if (vapidCache?.ctx === ctx) return vapidCache.v;
  let jwk: Record<string, string> | null = null;
  if (process.env.PURSER_VAPID_JSON) jwk = (JSON.parse(process.env.PURSER_VAPID_JSON) as { jwk: Record<string, string> }).jwk;
  if (!jwk) {
    const stored = kvGet(ctx.db, "pocket:vapid");
    if (stored) jwk = JSON.parse(stored) as Record<string, string>;
  }
  if (!jwk) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    jwk = privateKey.export({ format: "jwk" }) as Record<string, string>;
    kvSet(ctx.db, "pocket:vapid", JSON.stringify(jwk));
  }
  const key = createPrivateKey({ key: jwk, format: "jwk" });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]));
  const v = { publicKey, key };
  vapidCache = { ctx, v };
  return v;
}

function vapidSubject(ctx: Ctx): string {
  return ctx.cfg.publicUrl.startsWith("https://") ? new URL(ctx.cfg.publicUrl).origin : "https://purseragents.fun";
}

function vapidJwt(ctx: Ctx, endpoint: string): string {
  const v = vapid(ctx);
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: now() + 12 * 3600, sub: vapidSubject(ctx) })));
  const sig = sign("sha256", Buffer.from(`${header}.${claims}`), { key: v.key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64u(sig)}`;
}

/** RFC 8291 aes128gcm: one record, the whole payload. */
export function encryptPush(payload: Buffer, uaPublicB64: string, authB64: string, salt: Buffer = randomBytes(16), asPrivate?: Buffer) {
  const uaPublic = Buffer.from(uaPublicB64, "base64url");
  const authSecret = Buffer.from(authB64, "base64url");
  const ecdh = createECDH("prime256v1");
  if (asPrivate) ecdh.setPrivateKey(asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

export interface PushNote {
  title: string;
  body: string;
  url: string;
  tag?: string;
  kind: NoteKind;
  /** sent during quiet hours too: a payment waits for the owner, or the watchdog froze an agent */
  urgent?: boolean;
}

/** The owner's agent accounts as the engine knows them (no chain read). */
function ownerSafes(ctx: Ctx, ownerAddr: string): string[] {
  const rows = ctx.db.prepare("SELECT safe, owners FROM accounts").all() as { safe: string; owners: string }[];
  return rows.filter((r) => parseJson<string[]>(r.owners, []).some((o) => sameAddress(o, ownerAddr))).map((r) => r.safe);
}

/** Payments waiting for this owner: above the approval amount, or held by Purser Shield. The number on the app icon. */
export function waitingCount(ctx: Ctx, ownerAddr: string): number {
  const safes = ownerSafes(ctx, ownerAddr);
  if (!safes.length) return 0;
  return (ctx.db.prepare(`SELECT COUNT(*) AS n FROM intents WHERE status IN ('queued', 'held') AND safe IN (${safes.map(() => "?").join(",")})`).get(...safes) as { n: number }).n;
}

/** Sends to one subscription. Returns the push service's HTTP status, or null when it did not answer. */
async function pushTo(ctx: Ctx, sub: { endpoint: string; p256dh: string; auth: string }, note: PushNote, badge: number): Promise<number | null> {
  const body = encryptPush(Buffer.from(JSON.stringify({ title: note.title, body: note.body, url: note.url, tag: note.tag ?? null, badge })), sub.p256dh, sub.auth);
  try {
    const res = await guardedFetch(ctx, sub.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-encoding": "aes128gcm",
        ttl: "86400",
        urgency: note.kind === "approvals" || note.kind === "watchdog" ? "high" : "normal",
        ...(note.tag ? { topic: note.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
        authorization: `vapid t=${vapidJwt(ctx, sub.endpoint)}, k=${vapid(ctx).publicKey}`,
      },
      body,
      timeoutMs: 8000,
      maxBytes: 64_000,
    });
    if (res.status === 404 || res.status === 410) ctx.db.prepare("DELETE FROM pocket_push WHERE endpoint = ?").run(sub.endpoint);
    return res.status;
  } catch {
    return null;
  }
}

/** Sends a note to every paired phone of an owner that wants this kind and is not in its quiet hours. */
export async function notifyOwner(ctx: Ctx, ownerAddr: string, note: PushNote, onlyDevice?: string, t = now()): Promise<number> {
  ensure(ctx);
  const devices = (ctx.db.prepare("SELECT * FROM pocket_devices WHERE owner = ? AND revoked = 0").all(lower(ownerAddr)) as DeviceRow[]).filter((d) => {
    const prefs = prefsOf(d.prefs);
    return (!onlyDevice || d.id === onlyDevice) && prefs[note.kind] && (note.urgent || !inQuietHours(prefs, d.tz, t));
  });
  if (!devices.length) return 0;
  const badge = waitingCount(ctx, ownerAddr);
  let sent = 0;
  for (const d of devices) {
    const subs = ctx.db.prepare("SELECT endpoint, p256dh, auth FROM pocket_push WHERE device_id = ?").all(d.id) as { endpoint: string; p256dh: string; auth: string }[];
    for (const s of subs) {
      const code = await pushTo(ctx, s, note, badge);
      if (code !== null && code >= 200 && code < 300) sent++;
    }
  }
  return sent;
}

// ------------------------------------------------------------------------------------------------ what gets sent

const ownersOf = (ctx: Ctx, safe: string): string[] => parseJson<string[]>(accountRow(ctx, safe)?.owners ?? "[]", []).map(lower);
const nameOf = (ctx: Ctx, safe: string) => accountRow(ctx, safe)?.name ?? "An agent";

function amountText(m: { usd: string | null; display: string } | null | undefined): string {
  if (!m) return "";
  return m.usd !== null ? `$${Number(m.usd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : m.display;
}

/** Maps an engine event to a phone notification, or null when it is not one worth a buzz. */
export function noteFor(ctx: Ctx, e: EngineEvent): PushNote | null {
  if (!e.safe) return null;
  const name = nameOf(ctx, e.safe);
  const d = e.data as Record<string, unknown>;
  if (e.type === "approval" && d.event === "queued" && typeof d.intentId === "string") {
    let a;
    try {
      a = getApproval(ctx, d.intentId);
    } catch {
      return null;
    }
    const amount = amountText(a.money);
    return { kind: "approvals", urgent: true, title: `${name} wants to pay${amount ? ` ${amount}` : ""}`, body: `${a.summary}. Approve or reject with Face ID.`, url: `/pocket?approve=${a.id}`, tag: `ap-${a.id}` };
  }
  if (e.type === "intent" && d.event === "held") {
    const it = d as unknown as Intent;
    return { kind: "blocked", title: `Purser Shield held a payment from ${name}`, body: `${it.summary}. Nothing moved. Release or reject it with Face ID.`, url: `/pocket?held=${it.id}`, tag: `held-${it.id}` };
  }
  if (e.type === "intent" && d.event === "blocked") {
    const it = d as unknown as Intent;
    let why: string | null = null;
    if (it.verdictId) {
      const v = ctx.db.prepare("SELECT reasons FROM verdicts WHERE id = ?").get(it.verdictId) as { reasons: string } | undefined;
      why = parseJson<Verdict["reasons"]>(v?.reasons ?? "[]", []).find((r) => r.severity === "block")?.title ?? null;
    }
    const amount = amountText(it.money);
    return { kind: "blocked", title: `Blocked: ${name}${amount ? `, ${amount}` : ""}`, body: `${why ?? it.error ?? it.summary}. Nothing was paid.`, url: "/pocket", tag: `bl-${it.id}` };
  }
  if (e.type === "watchdog") {
    const w = d as unknown as WatchdogEvent;
    if (w.severity !== "critical" && w.action !== "freeze") return null;
    return { kind: "watchdog", urgent: w.action === "freeze", title: w.action === "freeze" ? `${name} was frozen by the watchdog` : `Watchdog: ${w.title.toLowerCase()} on ${name}`, body: w.action === "freeze" ? `${w.title}. No payment can leave until you unfreeze it.` : w.title + ".", url: "/pocket", tag: `wd-${w.id}` };
  }
  if ((e.type as string) === "alert" && (d.kind === "spend_over" || d.kind === "balance_under")) {
    return { kind: "budget", title: `${name}: ${String(d.title)}`, body: String(d.detail), url: "/pocket", tag: `al-${String(d.kind)}-${e.safe}` };
  }
  return null;
}

let installed = new WeakSet<Ctx>();
export function installPocket(ctx: Ctx) {
  if (installed.has(ctx) || !pocketOn()) return;
  installed.add(ctx);
  ensure(ctx);
  ctx.bus.subscribe((e) => {
    const note = noteFor(ctx, e);
    if (!note || !e.safe) return;
    for (const o of ownersOf(ctx, e.safe)) void notifyOwner(ctx, o, note).catch(() => undefined);
  });
}

// ------------------------------------------------------------------------------------------------ freeze from the phone

export interface PocketFreezeResult {
  safe: Address;
  name: string;
  frozen: boolean;
  txHash: string | null;
  message: string;
}

export async function freezeFromPhone(ctx: Ctx, device: DeviceRow, safes: string[] | "all"): Promise<PocketFreezeResult[]> {
  const dep = requireDep(ctx);
  const mine = await listAccounts(ctx, { owner: device.owner });
  const targets = safes === "all" ? mine : mine.filter((a) => safes.some((s) => sameAddress(s, a.safe)));
  if (!targets.length) fail(404, "not_found", "None of these agents belongs to this phone's wallet.");
  const wd = ctx.chain.accounts.watchdog;
  const out: PocketFreezeResult[] = [];
  for (const a of targets) {
    const chainAcct = await readChainAccount(ctx, a.safe);
    if (chainAcct.frozen) {
      out.push({ safe: a.safe, name: a.name, frozen: true, txHash: null, message: "Already frozen." });
      continue;
    }
    if (!wd || !sameAddress(chainAcct.config.watchdog, wd.address)) {
      out.push({ safe: a.safe, name: a.name, frozen: false, txHash: null, message: "Freezing from the phone is off for this agent. Turn on the watchdog for it on your dashboard, or freeze it there with your wallet." });
      continue;
    }
    if (!ctx.chain.broadcast) {
      out.push({ safe: a.safe, name: a.name, frozen: false, txHash: null, message: "This engine cannot send the freeze. Freeze it on your dashboard with your wallet." });
      continue;
    }
    try {
      const r = await ctx.chain.send(wd, { to: dep.module, data: encodeFunctionData({ abi: purserModuleAbi, functionName: "freeze", args: [a.safe] }) });
      await ingestReceipt(ctx, r);
      await ctx.audit.append(`device:${device.id}`, "pocket.freeze", a.safe, { tx: r.transactionHash });
      out.push({ safe: a.safe, name: a.name, frozen: true, txHash: r.transactionHash, message: "Frozen. Only you can unfreeze it, with your wallet." });
    } catch (e) {
      out.push({ safe: a.safe, name: a.name, frozen: false, txHash: null, message: `The freeze failed: ${explainRevert(e)}` });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ daily statement

export interface StatementLine {
  safe: Address;
  name: string;
  spentUsd: string;
  earnedUsd: string;
  payments: number;
  blocked: number;
}
export interface Statement {
  day: string; // YYYY-MM-DD in the phone's time zone
  from: number;
  to: number;
  agents: StatementLine[];
  spentUsd: string;
  earnedUsd: string;
  blocked: number;
  payments: number;
}

/** Local date, hour and seconds since local midnight for a unix time in a time zone. */
export function localClock(t: number, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(t * 1000))
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour);
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour, sinceMidnight: hour * 3600 + Number(parts.minute) * 60 + Number(parts.second) };
}

export async function buildStatement(ctx: Ctx, ownerAddr: string, from: number, to: number, day: string): Promise<Statement> {
  const accounts = await listAccounts(ctx, { owner: ownerAddr });
  let spent = 0n;
  let earned = 0n;
  let blocked = 0;
  let payments = 0;
  const agents: StatementLine[] = [];
  for (const a of accounts) {
    // moving idle money into a vault and back is not spending or earning
    const rows = ctx.db.prepare("SELECT direction, usd_micro FROM receipts WHERE safe = ? AND status = 'executed' AND category != 'treasury' AND created_at >= ? AND created_at < ?").all(lower(a.safe), from, to) as { direction: string; usd_micro: string }[];
    let s = 0n;
    let e = 0n;
    for (const r of rows) {
      if (r.direction === "out") s += BigInt(r.usd_micro || "0");
      else e += BigInt(r.usd_micro || "0");
    }
    const b = (ctx.db.prepare("SELECT COUNT(*) AS n FROM intents WHERE safe = ? AND status = 'blocked' AND created_at >= ? AND created_at < ?").get(lower(a.safe), from, to) as { n: number }).n;
    const n = rows.filter((r) => r.direction === "out").length;
    spent += s;
    earned += e;
    blocked += b;
    payments += n;
    agents.push({ safe: a.safe, name: a.name, spentUsd: usd(s), earnedUsd: usd(e), payments: n, blocked: b });
  }
  agents.sort((x, y) => Number(y.spentUsd) + Number(y.earnedUsd) - (Number(x.spentUsd) + Number(x.earnedUsd)));
  return { day, from, to, agents, spentUsd: usd(spent), earnedUsd: usd(earned), blocked, payments };
}

const money = (v: string) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function statementSentence(s: Statement): string {
  const n = s.agents.length;
  const stopped = s.blocked === 0 ? "nothing was blocked" : s.blocked === 1 ? "1 payment was blocked" : `${s.blocked} payments were blocked`;
  return `Your ${n === 1 ? "agent" : `${n} agents`} spent ${money(s.spentUsd)} and earned ${money(s.earnedUsd)}, and ${stopped}.`;
}

export interface WeeklyReport extends Statement {
  week: true;
  /** the agent with the most payments in the week, when there were any */
  busiest: { safe: Address; name: string; payments: number; spentUsd: string } | null;
}

/** 0 = Monday ... 6 = Sunday in a time zone. */
export function localWeekday(t: number, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(t * 1000));
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name);
}

/** Seven days as one report: totals, the busiest agent and how many payments were blocked. */
export async function buildWeekly(ctx: Ctx, ownerAddr: string, from: number, to: number, day: string): Promise<WeeklyReport> {
  const s = await buildStatement(ctx, ownerAddr, from, to, day);
  const top = [...s.agents].sort((x, y) => y.payments - x.payments || Number(y.spentUsd) - Number(x.spentUsd))[0];
  return { ...s, week: true, busiest: top && top.payments > 0 ? { safe: top.safe, name: top.name, payments: top.payments, spentUsd: top.spentUsd } : null };
}

export function weeklySentence(w: WeeklyReport): string {
  const n = w.agents.length;
  const stopped = w.blocked === 0 ? "Nothing was blocked" : w.blocked === 1 ? "1 payment was blocked" : `${w.blocked} payments were blocked`;
  const busy = w.busiest ? ` ${w.busiest.name} was the busiest with ${w.busiest.payments} ${w.busiest.payments === 1 ? "payment" : "payments"}.` : "";
  return `In seven days your ${n === 1 ? "agent" : `${n} agents`} spent ${money(w.spentUsd)} and earned ${money(w.earnedUsd)}.${busy} ${stopped}.`;
}

/**
 * Once a minute: every phone that wants it gets yesterday's statement after 08:00 its own time, and on Monday the
 * report of the seven days before. `at` is the clock to use (the chain's by default).
 */
export async function sendStatements(ctx: Ctx, at?: number): Promise<number> {
  if (!pocketOn()) return 0;
  ensure(ctx);
  const t = at ?? (await chainNow(ctx));
  const devices = ctx.db.prepare("SELECT * FROM pocket_devices WHERE revoked = 0").all() as DeviceRow[];
  let sent = 0;
  for (const d of devices) {
    const prefs = prefsOf(d.prefs);
    const clock = localClock(t, d.tz);
    if (clock.hour < 8) continue;
    const midnight = t - clock.sinceMidnight;
    if (d.created_at > midnight) continue; // paired today: the first statement comes tomorrow
    const has = (key: string) => !!ctx.db.prepare("SELECT 1 FROM pocket_statements WHERE device_id = ? AND day = ?").get(d.id, key);
    const keep = (key: string, data: unknown) => ctx.db.prepare("INSERT OR IGNORE INTO pocket_statements (device_id, day, data, created_at) VALUES (?, ?, ?, ?)").run(d.id, key, JSON.stringify(data), t);
    const day = localClock(midnight - 3600, d.tz).day;
    if (prefs.statement && !has(day)) {
      const s = await buildStatement(ctx, d.owner, midnight - 86_400, midnight, day);
      keep(day, s);
      sent += await notifyOwner(ctx, d.owner, { kind: "statement", title: "Your daily statement", body: statementSentence(s), url: `/pocket/statement?day=${day}`, tag: `st-${day}` }, d.id, t);
    }
    const weekKey = `week-${clock.day}`;
    if (prefs.weekly && localWeekday(t, d.tz) === 0 && !has(weekKey)) {
      const w = await buildWeekly(ctx, d.owner, midnight - 7 * 86_400, midnight, clock.day);
      keep(weekKey, w);
      sent += await notifyOwner(ctx, d.owner, { kind: "weekly", title: "Your weekly report", body: weeklySentence(w), url: `/pocket/statement?day=${weekKey}`, tag: weekKey }, d.id, t);
    }
  }
  return sent;
}

registerTask({
  name: "pocket",
  every: 60_000,
  async run(ctx) {
    installPocket(ctx);
    return sendStatements(ctx);
  },
});


// ------------------------------------------------------------------------------------------------ the live feed

export interface FeedItem {
  id: string;
  kind: "paid" | "earned" | "blocked" | "held" | "watchdog";
  safe: Address;
  name: string;
  /** what happened, in a few words: a service, a memo, a block reason */
  text: string;
  category: string | null;
  usd: string | null;
  display: string | null;
  createdAt: number;
}

function receiptItem(ctx: Ctx, r: ReceiptRow, name: string): FeedItem {
  const info = ctx.tokens.infoSync(r.token as Address);
  const usdMicro = BigInt(String(r.usd_micro ?? "0"));
  return {
    id: r.id,
    kind: r.direction === "in" ? "earned" : "paid",
    safe: r.safe as Address,
    name,
    text: String(r.memo ?? r.service ?? ""),
    category: r.category ?? null,
    usd: usdMicro >= 10_000n ? usd(usdMicro) : null, // under a cent the token amount says more than $0.00
    display: `${fmtUnits(BigInt(r.amount), info.decimals)} ${info.symbol}`,
    createdAt: r.created_at,
  };
}

function blockReasons(ctx: Ctx, verdictId: string | null): Verdict["reasons"] {
  if (!verdictId) return [];
  const v = ctx.db.prepare("SELECT reasons FROM verdicts WHERE id = ?").get(verdictId) as { reasons: string } | undefined;
  return parseJson<Verdict["reasons"]>(v?.reasons ?? "[]", []);
}

function intentItem(ctx: Ctx, r: IntentRow, name: string): FeedItem {
  const it = intentFromRow(ctx, r);
  const reasons = blockReasons(ctx, r.verdict_id);
  const why = (r.status === "held" ? reasons.find((x) => x.code === "shield_hold") : reasons.find((x) => x.severity === "block"))?.title ?? null;
  return { id: r.id, kind: r.status === "held" ? "held" : "blocked", safe: r.safe as Address, name, text: why ?? String(r.error ?? r.summary), category: null, usd: it.money?.usd ?? null, display: it.money?.display ?? null, createdAt: r.created_at };
}

interface WatchRow {
  id: string;
  safe: string;
  title: string;
  detail: string;
  action: string;
  severity: string;
  tx_hash: string | null;
  created_at: number;
}

function watchItem(e: WatchRow, name: string): FeedItem {
  return { id: e.id, kind: "watchdog", safe: e.safe as Address, name, text: e.action === "freeze" ? `${e.title}. Frozen by the watchdog` : e.title, category: null, usd: null, display: null, createdAt: e.created_at };
}

/** The owner's last payments, earnings, blocked payments and watchdog events, newest first. */
export async function feedFor(ctx: Ctx, ownerAddr: string, limit = 40): Promise<FeedItem[]> {
  const safes = ownerSafes(ctx, ownerAddr);
  if (!safes.length) return [];
  const names = new Map<string, string>(safes.map((s) => [s, nameOf(ctx, s)]));
  const name = (s: string) => names.get(s) ?? "Agent";
  const marks = safes.map(() => "?").join(",");
  const out: FeedItem[] = [];
  // a stream pays out every few seconds: the feed lists only its newest payout per agent and payee
  const receipts = ctx.db.prepare(`SELECT * FROM receipts WHERE safe IN (${marks}) AND status = 'executed' ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...safes, limit * 6) as ReceiptRow[];
  const streams = new Set<string>();
  let listed = 0;
  for (const r of receipts) {
    if (r.category === "stream") {
      const k = `${r.safe}:${r.counterparty}:${r.direction}`;
      if (streams.has(k)) continue;
      streams.add(k);
    }
    out.push(receiptItem(ctx, r, name(r.safe)));
    if (++listed >= limit) break;
  }
  const intents = ctx.db.prepare(`SELECT * FROM intents WHERE safe IN (${marks}) AND status IN ('blocked', 'held') ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...safes, limit) as IntentRow[];
  for (const it of intents) out.push(intentItem(ctx, it, name(it.safe)));
  const watch = ctx.db.prepare(`SELECT * FROM watch_events WHERE safe IN (${marks}) ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...safes, limit) as WatchRow[];
  for (const e of watch) {
    if (e.severity !== "critical" && e.action !== "freeze") continue;
    out.push(watchItem(e, name(e.safe)));
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export interface FeedDetail {
  item: FeedItem;
  /** who was paid, or who paid */
  counterparty: Address | null;
  counterpartyName: string | null;
  /** what for: the memo, the service or the payment's own summary */
  what: string | null;
  status: string;
  txHash: string | null;
  fee: Money | null;
  /** why the firewall, the rules or Purser Shield stopped it; the watchdog's finding */
  reasons: { title: string; detail: string }[];
}

/** One line of the feed with everything behind it. Only the owner's own agents. */
export function feedDetail(ctx: Ctx, ownerAddr: string, itemId: string): FeedDetail {
  const mine = new Set(ownerSafes(ctx, ownerAddr));
  const none = () => fail(404, "not_found", "No such payment.");
  const r = ctx.db.prepare("SELECT * FROM receipts WHERE id = ?").get(itemId) as ReceiptRow | undefined;
  if (r) {
    if (!mine.has(r.safe)) none();
    const full = receiptFromRow(ctx, r);
    return { item: receiptItem(ctx, r, nameOf(ctx, r.safe)), counterparty: full.counterparty, counterpartyName: full.counterpartyName, what: full.memo ?? full.service ?? null, status: full.status, txHash: full.txHash, fee: full.fee, reasons: [] };
  }
  const i = getIntentRow(ctx, itemId);
  if (i) {
    if (!mine.has(i.safe)) none();
    const wanted = i.status === "held" ? ["shield_hold"] : null;
    const reasons = blockReasons(ctx, i.verdict_id)
      .filter((x) => (wanted ? wanted.includes(x.code) : x.severity === "block"))
      .map((x) => ({ title: x.title, detail: x.detail }));
    const toName = i.to_addr ? ((ctx.db.prepare("SELECT name FROM accounts WHERE safe = ?").get(lower(i.to_addr)) as { name: string } | undefined)?.name ?? null) : null;
    return { item: intentItem(ctx, i, nameOf(ctx, i.safe)), counterparty: (i.to_addr as Address) ?? null, counterpartyName: toName, what: parseJson<{ memo?: string }>(i.meta, {}).memo || i.summary, status: i.status, txHash: i.tx_hash, fee: null, reasons: reasons.length ? reasons : i.error ? [{ title: i.error, detail: "" }] : [] };
  }
  const e = ctx.db.prepare("SELECT * FROM watch_events WHERE id = ?").get(itemId) as WatchRow | undefined;
  if (e) {
    if (!mine.has(e.safe)) none();
    return { item: watchItem(e, nameOf(ctx, e.safe)), counterparty: null, counterpartyName: null, what: null, status: e.action === "freeze" ? "frozen" : "alert", txHash: e.tx_hash, fee: null, reasons: [{ title: e.title, detail: e.detail }] };
  }
  return none();
}

function fmtUnits(v: bigint, decimals: number): string {
  const s = (Number(v) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals > 6 ? 6 : decimals, minimumFractionDigits: 2 });
  return s;
}

// ------------------------------------------------------------------------------------------------ Face ID, checked by the engine

export interface DeviceAssertion {
  authenticatorData: string; // 0x hex
  clientDataJSON: string;
  r: string; // 0x hex
  s: string;
}

const CHALLENGE_TTL = 120;

/** Where the phone app may run: the site, plus localhost in test mode. More with PURSER_SITE_ORIGINS (comma list). */
function originAllowed(ctx: Ctx, origin: string): boolean {
  const extra = (process.env.PURSER_SITE_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (["https://purseragents.fun", "https://www.purseragents.fun", ...extra].includes(origin)) return true;
  return ctx.cfg.testMode && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/** A single-use challenge for one Face ID action on one phone: "release:<intent>", "reject:<intent>" or "unlock". */
export function newChallenge(ctx: Ctx, deviceId: string, purpose: string, t = now()): { challenge: string; expires: number } {
  ensure(ctx);
  ctx.db.prepare("DELETE FROM pocket_challenges WHERE expires < ?").run(t - 3600);
  const nonce = randomBytes(32).toString("hex");
  ctx.db.prepare("INSERT INTO pocket_challenges (nonce, device_id, purpose, expires) VALUES (?, ?, ?, ?)").run(nonce, deviceId, purpose, t + CHALLENGE_TTL);
  return { challenge: `0x${nonce}`, expires: t + CHALLENGE_TTL };
}

const refuse = (code: string, message: string) => fail(401, code, message);

/**
 * Checks a WebAuthn assertion from a paired phone: the challenge is one this engine issued to this phone for this
 * exact action, unused and not expired; the assertion is a webauthn.get from the site with the user verified; and the
 * P-256 signature over authenticatorData || sha256(clientDataJSON) matches the passkey the phone registered at pairing.
 * The challenge is spent on the first try, whatever the outcome.
 */
export function verifyDeviceAssertion(ctx: Ctx, device: Pick<DeviceRow, "id" | "passkey">, purpose: string, a: DeviceAssertion, t = now()): void {
  ensure(ctx);
  const key = parseJson<{ x: string; y: string } | null>(device.passkey, null);
  if (!key) fail(403, "no_passkey", "This phone has no Face ID key. Pair it again with Face ID switched on.");
  let client: { type?: string; challenge?: string; origin?: string };
  try {
    client = JSON.parse(a.clientDataJSON) as typeof client;
  } catch {
    return refuse("bad_assertion", "The Face ID answer could not be read. Try again.");
  }
  const nonce = Buffer.from(String(client.challenge ?? ""), "base64url").toString("hex");
  const row = ctx.db.prepare("SELECT * FROM pocket_challenges WHERE nonce = ?").get(nonce) as { device_id: string; purpose: string; expires: number; used: number } | undefined;
  if (!row || row.device_id !== device.id || row.purpose !== purpose) refuse("bad_challenge", "This Face ID check does not belong to this action. Try again.");
  if (row!.used) refuse("challenge_used", "This Face ID check was already used. Try again.");
  ctx.db.prepare("UPDATE pocket_challenges SET used = 1 WHERE nonce = ?").run(nonce);
  if (row!.expires < t) refuse("challenge_expired", "This Face ID check ran out of time. Try again.");
  if (client.type !== "webauthn.get") refuse("bad_assertion", "This is not a Face ID sign-in answer.");
  if (!client.origin || !originAllowed(ctx, client.origin)) refuse("bad_origin", "This Face ID answer was not made in the Purser app.");
  const authData = Buffer.from(a.authenticatorData.replace(/^0x/, ""), "hex");
  if (authData.length < 37) refuse("bad_assertion", "The Face ID answer is incomplete.");
  const rpIdHash = createHash("sha256").update(new URL(client.origin!).hostname).digest();
  if (!authData.subarray(0, 32).equals(rpIdHash)) refuse("bad_origin", "This Face ID key belongs to another site.");
  const flags = authData[32];
  if (!(flags & 0x01) || !(flags & 0x04)) refuse("not_verified", "Face ID did not confirm it was you.");
  const word = (hex: string) => Buffer.from(hex.replace(/^0x/, "").padStart(64, "0").slice(-64), "hex");
  let ok = false;
  try {
    const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: word(key!.x).toString("base64url"), y: word(key!.y).toString("base64url") }, format: "jwk" });
    const signed = Buffer.concat([authData, createHash("sha256").update(a.clientDataJSON).digest()]);
    ok = verify("sha256", signed, { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.concat([word(a.r), word(a.s)]));
  } catch {
    ok = false;
  }
  if (!ok) refuse("bad_signature", "This Face ID key is not the one this phone was paired with.");
}

export interface HeldPayment {
  id: string;
  safe: Address;
  name: string;
  summary: string;
  money: Money | null;
  to: Address | null;
  why: string | null;
  createdAt: number;
}

/** Payments Purser Shield holds for this owner (accounts set to warn), newest first. */
export function heldFor(ctx: Ctx, ownerAddr: string): HeldPayment[] {
  const safes = ownerSafes(ctx, ownerAddr);
  if (!safes.length) return [];
  const rows = ctx.db.prepare(`SELECT * FROM intents WHERE status = 'held' AND safe IN (${safes.map(() => "?").join(",")}) ORDER BY created_at DESC, rowid DESC LIMIT 50`).all(...safes) as IntentRow[];
  return rows.map((r) => {
    const it = intentFromRow(ctx, r);
    const why = blockReasons(ctx, r.verdict_id).find((x) => x.code === "shield_hold");
    return { id: r.id, safe: it.safe, name: nameOf(ctx, r.safe), summary: it.summary, money: it.money, to: it.to, why: why?.detail ?? null, createdAt: r.created_at };
  });
}

/** Releases or rejects a held payment from the phone. The passkey assertion is checked first; then the owner's own logic runs. */
export async function decideHeldFromPhone(ctx: Ctx, device: DeviceRow, intentId: string, decision: "release" | "reject", assertion: DeviceAssertion) {
  const row = getIntentRow(ctx, intentId);
  if (!row || !ownersOf(ctx, row.safe).includes(lower(device.owner))) return fail(404, "not_found", "No such payment.");
  if (!device.passkey) fail(403, "no_passkey", "This phone has no Face ID key. Release it on your computer, or pair the phone again with Face ID switched on.");
  if (row.status !== "held") fail(409, "not_held", "This payment is not waiting on Purser Shield.");
  verifyDeviceAssertion(ctx, device, `${decision}:${intentId}`, assertion);
  await ctx.audit.append(`device:${device.id}`, decision === "release" ? "pocket.released" : "pocket.rejected", row.safe, { intent: intentId });
  if (decision === "release") return { decision, result: await releaseHeld(ctx, intentId), intent: null };
  return { decision, result: null, intent: await rejectHeld(ctx, intentId) };
}

// ------------------------------------------------------------------------------------------------ routes

const zPushSub = z.object({
  endpoint: z.string().url().refine((u) => u.startsWith("https://"), "https only"),
  keys: z.object({ p256dh: z.string().min(40).max(200), auth: z.string().min(8).max(64) }),
});

registerRoutes((app: Hono, ctx: Ctx) => {
  if (!pocketOn()) return;
  ensure(ctx);
  installPocket(ctx);
  const device = (c: { req: { header(n: string): string | undefined } }) => authDevice(ctx, c.req.header("authorization"));

  // --- the computer side (owner wallet session)
  app.post("/v1/pocket/pair", (c) => send(c, newPairCode(ctx, owner(ctx, c))));
  app.get("/v1/pocket/pair/:code", (c) => {
    const who = owner(ctx, c);
    const row = ctx.db.prepare("SELECT * FROM pocket_codes WHERE code = ?").get(normCode(param(c, "code"))) as { owner: string; expires: number; device_id: string | null } | undefined;
    if (!row || !sameAddress(row.owner, who)) fail(404, "not_found", "No such code.");
    const d = row!.device_id ? (ctx.db.prepare("SELECT * FROM pocket_devices WHERE id = ?").get(row!.device_id) as DeviceRow | undefined) : undefined;
    return send(c, {
      expires: row!.expires,
      claimed: !!d,
      device: d ? deviceView(ctx, d) : null,
      passkey: d?.passkey ? (JSON.parse(d.passkey) as { x: string; y: string }) : null,
    });
  });
  app.get("/v1/pocket/devices", (c) => {
    const who = owner(ctx, c);
    const rows = ctx.db.prepare("SELECT * FROM pocket_devices WHERE owner = ? AND revoked = 0 ORDER BY created_at DESC").all(lower(who)) as DeviceRow[];
    return send(c, { items: rows.map((r) => deviceView(ctx, r)) });
  });
  app.delete("/v1/pocket/devices/:id", async (c) => {
    const who = owner(ctx, c);
    const r = ctx.db.prepare("UPDATE pocket_devices SET revoked = 1 WHERE id = ? AND owner = ?").run(param(c, "id"), lower(who));
    if (!r.changes) fail(404, "not_found", "No such phone.");
    ctx.db.prepare("DELETE FROM pocket_push WHERE device_id = ?").run(param(c, "id"));
    await ctx.audit.append(`owner:${lower(who)}`, "pocket.unpaired", null, { device: param(c, "id") });
    return send(c, { ok: true });
  });

  // --- the phone side
  app.post("/v1/pocket/claim", async (c) => {
    const b = await body(
      c,
      z.object({
        code: z.string().min(4).max(20),
        name: z.string().max(60).default("Phone"),
        tz: z.string().max(64).default("UTC"),
        passkey: z.object({ x: z.string().regex(/^0x[0-9a-fA-F]{64}$/), y: z.string().regex(/^0x[0-9a-fA-F]{64}$/), credentialId: z.string().max(512) }).nullable().default(null),
      }),
    );
    return send(c, claimPairCode(ctx, b));
  });
  app.get("/v1/pocket/me", async (c) => {
    const d = device(c);
    const accounts = await listAccounts(ctx, { owner: d.owner });
    const wd = ctx.chain.accounts.watchdog;
    const canFreeze: Record<string, boolean> = {};
    for (const a of accounts) {
      try {
        const chainAcct = await readChainAccount(ctx, a.safe);
        canFreeze[a.safe] = !!wd && !!ctx.chain.broadcast && sameAddress(chainAcct.config.watchdog, wd.address);
      } catch {
        canFreeze[a.safe] = false;
      }
    }
    // what the phone calls spent today leaves out vault moves, like the statement does
    const t = now();
    for (const a of accounts) {
      const spent = ctx.db.prepare("SELECT COALESCE(SUM(CAST(usd_micro AS INTEGER)), 0) AS v FROM receipts WHERE safe = ? AND direction = 'out' AND status = 'executed' AND category != 'treasury' AND created_at >= ?").get(lower(a.safe), t - (t % 86_400)) as { v: number };
      a.spentTodayUsd = usd(BigInt(spent.v));
    }
    return send(c, { owner: d.owner, device: deviceView(ctx, d), accounts, canFreeze, vapidKey: vapid(ctx).publicKey, passkey: d.passkey ? (JSON.parse(d.passkey) as { credentialId: string }).credentialId : null, waiting: waitingCount(ctx, d.owner), now: now() });
  });
  app.delete("/v1/pocket/me", async (c) => {
    const d = device(c);
    ctx.db.prepare("UPDATE pocket_devices SET revoked = 1 WHERE id = ?").run(d.id);
    ctx.db.prepare("DELETE FROM pocket_push WHERE device_id = ?").run(d.id);
    return send(c, { ok: true });
  });
  app.post("/v1/pocket/push", async (c) => {
    const d = device(c);
    const b = await body(c, zPushSub);
    ctx.db
      .prepare("INSERT INTO pocket_push (endpoint, device_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth")
      .run(b.endpoint, d.id, b.keys.p256dh, b.keys.auth, now());
    const sent = await notifyOwner(ctx, d.owner, { kind: "approvals", title: "Notifications are on", body: "You will hear from Purser when a payment waits for you, an attack is blocked or the watchdog steps in.", url: "/pocket", tag: "hello" }, d.id);
    return send(c, { ok: true, delivered: sent > 0 });
  });
  app.delete("/v1/pocket/push", async (c) => {
    const d = device(c);
    ctx.db.prepare("DELETE FROM pocket_push WHERE device_id = ?").run(d.id);
    return send(c, { ok: true });
  });
  app.patch("/v1/pocket/prefs", async (c) => {
    const d = device(c);
    const minutes = z.number().int().min(0).max(1439).optional();
    const b = await body(c, z.object({ blocked: z.boolean().optional(), watchdog: z.boolean().optional(), budget: z.boolean().optional(), statement: z.boolean().optional(), weekly: z.boolean().optional(), quiet: z.boolean().optional(), quietFrom: minutes, quietTo: minutes, lock: z.boolean().optional(), tz: z.string().max(64).optional() }));
    if (b.lock && !d.passkey) fail(400, "no_passkey", "The lock needs this phone's Face ID key. Pair the phone again with Face ID switched on.");
    const { tz, ...rest } = b;
    const next = { ...prefsOf(d.prefs), ...rest, approvals: true };
    ctx.db.prepare("UPDATE pocket_devices SET prefs = ?, tz = ? WHERE id = ?").run(JSON.stringify(next), tz ? safeTz(tz) : d.tz, d.id);
    return send(c, { prefs: next });
  });
  app.post("/v1/pocket/freeze", async (c) => {
    const d = device(c);
    const b = await body(c, z.object({ safes: z.union([z.literal("all"), z.array(zAddr).min(1).max(100)]) }));
    return send(c, { results: await freezeFromPhone(ctx, d, b.safes) });
  });
  app.get("/v1/pocket/statement", async (c) => {
    const d = device(c);
    const t = await chainNow(ctx);
    const clock = localClock(t, d.tz);
    const midnight = t - clock.sinceMidnight;
    const which = c.req.query("day") ?? "today";
    if (which === "week") {
      // the last seven days, today so far included
      const w = await buildWeekly(ctx, d.owner, midnight - 6 * 86_400, t + 1, clock.day);
      return send(c, { statement: w, sentence: weeklySentence(w), today: false, week: true });
    }
    if (which === "today") {
      const s = await buildStatement(ctx, d.owner, midnight, t + 1, clock.day);
      return send(c, { statement: s, sentence: statementSentence(s), today: true });
    }
    const stored = ctx.db.prepare("SELECT data FROM pocket_statements WHERE device_id = ? AND day = ?").get(d.id, which) as { data: string } | undefined;
    if (stored) {
      const s = JSON.parse(stored.data) as Statement | WeeklyReport;
      const week = "week" in s;
      return send(c, { statement: s, sentence: week ? weeklySentence(s) : statementSentence(s), today: false, week });
    }
    if (which === "yesterday" || which === localClock(midnight - 3600, d.tz).day) {
      const s = await buildStatement(ctx, d.owner, midnight - 86_400, midnight, localClock(midnight - 3600, d.tz).day);
      return send(c, { statement: s, sentence: statementSentence(s), today: false });
    }
    return fail(404, "not_found", "No statement for that day.");
  });
  app.get("/v1/pocket/feed", async (c) => {
    const d = device(c);
    return send(c, { items: await feedFor(ctx, d.owner, Math.min(Number(c.req.query("limit") ?? 40) || 40, 100)) });
  });
  app.get("/v1/pocket/statements", (c) => {
    const d = device(c);
    const rows = ctx.db.prepare("SELECT day FROM pocket_statements WHERE device_id = ? ORDER BY day DESC LIMIT 60").all(d.id) as { day: string }[];
    return send(c, { days: rows.map((r) => r.day).filter((x) => !x.startsWith("week-")), weeks: rows.map((r) => r.day).filter((x) => x.startsWith("week-")) });
  });
  app.get("/v1/pocket/feed/:id", (c) => {
    const d = device(c);
    return send(c, feedDetail(ctx, d.owner, param(c, "id")));
  });
  app.get("/v1/pocket/agents/:safe", async (c) => {
    const d = device(c);
    const safe = lower(param(c, "safe"));
    if (!/^0x[0-9a-f]{40}$/.test(safe) || !ownersOf(ctx, safe).includes(lower(d.owner))) fail(404, "not_found", "No such agent.");
    const account = await readAccount(ctx, safe);
    const wd = ctx.chain.accounts.watchdog;
    const t = now();
    const paymentsToday = (ctx.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE safe = ? AND direction = 'out' AND status = 'executed' AND created_at >= ?").get(safe, t - (t % 86_400)) as { n: number }).n;
    return send(c, {
      account,
      canFreeze: !!wd && !!ctx.chain.broadcast && sameAddress(account.config.watchdog, wd.address),
      paymentsToday,
      receipts: listReceipts(ctx, { safe, limit: 8 }).items,
    });
  });

  // --- Face ID actions the engine checks itself
  app.post("/v1/pocket/challenge", async (c) => {
    const d = device(c);
    const b = await body(c, z.object({ purpose: z.enum(["release", "reject", "unlock"]), intentId: z.string().max(80).optional() }));
    if (!d.passkey) fail(403, "no_passkey", "This phone has no Face ID key. Pair it again with Face ID switched on.");
    if (b.purpose === "unlock") return send(c, newChallenge(ctx, d.id, "unlock"));
    const row = b.intentId ? getIntentRow(ctx, b.intentId) : undefined;
    if (!row || !ownersOf(ctx, row.safe).includes(lower(d.owner))) fail(404, "not_found", "No such payment.");
    return send(c, newChallenge(ctx, d.id, `${b.purpose}:${row!.id}`));
  });
  const zDeviceAssertion = z.object({ authenticatorData: z.string().regex(/^0x[0-9a-fA-F]{74,2000}$/), clientDataJSON: z.string().max(4000), r: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), s: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/) });
  app.get("/v1/pocket/held", (c) => {
    const d = device(c);
    return send(c, { items: heldFor(ctx, d.owner), next: null });
  });
  app.post("/v1/pocket/held/:id", async (c) => {
    const d = device(c);
    const b = await body(c, z.object({ decision: z.enum(["release", "reject"]), assertion: zDeviceAssertion }));
    return send(c, await decideHeldFromPhone(ctx, d, param(c, "id"), b.decision, b.assertion));
  });
  app.post("/v1/pocket/unlock", async (c) => {
    const d = device(c);
    const b = await body(c, z.object({ assertion: zDeviceAssertion }));
    verifyDeviceAssertion(ctx, d, "unlock", b.assertion);
    return send(c, { ok: true, at: now() });
  });
});
