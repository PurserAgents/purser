/**
 * Purser in your pocket, the phone side: the device token from pairing, calls with it, and what the phone can do
 * (installed to the home screen, notifications). Storage reads and writes are in try/catch: a blocked store only
 * means pairing again.
 */
import { api } from "./client";
import { signWithCredential } from "./passkey";
import type { Account, AccountSummary, Address, Money, Receipt } from "./types";

const KEY = "purser-pocket";

export interface PocketAuth {
  token: string;
  deviceId: string;
  owner: string;
  credentialId: string | null;
}

export function readPocket(): PocketAuth | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PocketAuth) : null;
  } catch {
    return null;
  }
}

export function writePocket(auth: PocketAuth | null) {
  try {
    if (auth) localStorage.setItem(KEY, JSON.stringify(auth));
    else {
      localStorage.removeItem(KEY);
      localStorage.removeItem(LOCK_KEY);
      for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_KEY)) localStorage.removeItem(k);
    }
  } catch {
    /* pair again next time */
  }
}

// The last loaded data, kept so the app still shows something without a connection.
const CACHE_KEY = "purser-pocket-cache:";

export function readCache<T>(name: string): { at: number; data: T } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY + name);
    return raw ? (JSON.parse(raw) as { at: number; data: T }) : null;
  } catch {
    return null;
  }
}

export function writeCache(name: string, data: unknown) {
  try {
    localStorage.setItem(CACHE_KEY + name, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* no offline copy this time */
  }
}

// Lock with Face ID: remembered on the phone so the lock screen is there before anything loads.
const LOCK_KEY = "purser-pocket-lock";

export function lockWanted(): boolean {
  try {
    return localStorage.getItem(LOCK_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberLock(on: boolean) {
  try {
    if (on) localStorage.setItem(LOCK_KEY, "1");
    else localStorage.removeItem(LOCK_KEY);
  } catch {
    /* the setting still lives on the engine */
  }
}

/** The number on the app icon: payments waiting for the owner. */
export function setIconBadge(count: number) {
  const nav = navigator as Navigator & { setAppBadge?(n?: number): Promise<void>; clearAppBadge?(): Promise<void> };
  try {
    if (count > 0) void nav.setAppBadge?.(count).catch(() => undefined);
    else void nav.clearAppBadge?.().catch(() => undefined);
  } catch {
    /* no badge on this phone */
  }
}

export interface DeviceAssertion {
  authenticatorData: string;
  clientDataJSON: string;
  r: string;
  s: string;
}

/** Face ID for an action the engine checks itself: asks the engine for a single-use challenge and signs it. */
export async function faceIdFor(auth: PocketAuth, purpose: "release" | "reject" | "unlock", intentId?: string): Promise<DeviceAssertion> {
  const c = await pocketApi<{ challenge: string }>(auth, "/v1/pocket/challenge", { body: { purpose, intentId } });
  const a = await signWithCredential(auth.credentialId, c.challenge);
  return { authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, r: a.r, s: a.s };
}

/** A computer: a wide screen with a mouse. The phone app is made for the other kind. */
export function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches && window.innerWidth >= 900;
}

export const pocketApi = <T>(auth: { token: string }, path: string, init: { method?: string; body?: unknown } = {}) => api<T>(path, { ...init, token: auth.token });

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function deviceLabel(): string {
  if (typeof navigator === "undefined") return "Phone";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return /Pixel/.test(ua) ? "Pixel" : "Android phone";
  return "This device";
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Asks for permission, subscribes this phone and hands the subscription to the engine. */
export async function turnOnPush(auth: { token: string }, vapidKey: string): Promise<"on" | "denied"> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapidKey) }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await pocketApi(auth, "/v1/pocket/push", { body: { endpoint: json.endpoint, keys: json.keys } });
  return "on";
}

export async function turnOffPush(auth: { token: string }) {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    /* the engine forgets it either way */
  }
  await pocketApi(auth, "/v1/pocket/push", { method: "DELETE" });
}

export interface PocketPrefs {
  approvals: boolean;
  blocked: boolean;
  watchdog: boolean;
  budget: boolean;
  statement: boolean;
  weekly: boolean;
  quiet: boolean;
  /** minutes after midnight, the phone's own time */
  quietFrom: number;
  quietTo: number;
  lock: boolean;
}

export interface PocketDevice {
  id: string;
  name: string;
  tz: string;
  prefs: PocketPrefs;
  push: boolean;
  passkey: boolean;
  createdAt: number;
  lastSeen: number;
}

export interface PocketMe {
  owner: Address;
  device: PocketDevice;
  accounts: AccountSummary[];
  canFreeze: Record<string, boolean>;
  vapidKey: string;
  passkey: string | null;
  waiting: number;
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

export interface FeedDetail {
  item: FeedItem;
  counterparty: Address | null;
  counterpartyName: string | null;
  what: string | null;
  status: string;
  txHash: string | null;
  fee: Money | null;
  reasons: { title: string; detail: string }[];
}

export interface AgentDetail {
  account: Account;
  canFreeze: boolean;
  paymentsToday: number;
  receipts: Receipt[];
}

export interface FeedItem {
  id: string;
  kind: "paid" | "earned" | "blocked" | "held" | "watchdog";
  safe: Address;
  name: string;
  text: string;
  category: string | null;
  usd: string | null;
  display: string | null;
  createdAt: number;
}

export interface StatementLine {
  safe: Address;
  name: string;
  spentUsd: string;
  earnedUsd: string;
  payments: number;
  blocked: number;
}

export interface Statement {
  day: string;
  from: number;
  to: number;
  agents: StatementLine[];
  spentUsd: string;
  earnedUsd: string;
  blocked: number;
  payments: number;
  /** set on a weekly report */
  week?: true;
  busiest?: { safe: Address; name: string; payments: number; spentUsd: string } | null;
}

/** "$1,240.50" from a dollar string. */
export function dollars(v: string | null | undefined): string {
  const n = Number(v ?? 0);
  return `$${(Number.isFinite(n) ? n : 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const clockText = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
export const clockMinutes = (text: string) => {
  const [h, m] = text.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? Math.min(1439, Math.max(0, h * 60 + m)) : 0;
};

export function ago(t: number, now = Math.floor(Date.now() / 1000)): string {
  const s = Math.max(0, now - t);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
