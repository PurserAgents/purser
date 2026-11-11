/**
 * The site's server-side data layer. Every loader asks the engine at PURSER_ENGINE_URL and returns the engine's
 * answer, or `null` when the variable is unset, the engine does not answer in time, or the answer does not have the
 * expected shape. A page shows a designed empty state for `null`; it never makes numbers up.
 *
 * Routes and shapes: docs/API.md and `types.ts` (a mirror of packages/sdk/src/schema.ts).
 * The browser reaches the engine through the same-origin proxy at /v1/* (app/v1/[...path]/route.ts).
 */
import "server-only";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  AccountSummary,
  DirectoryEntry,
  Economy,
  EngineConfig,
  FirewallRun,
  Health,
  LeaderboardEntry,
  Page,
  PublicAgent,
  StoreService,
  Template,
} from "./types";

const TIMEOUT_MS = 2500;
const MAX_BYTES = 4_000_000;
/** Seconds a rendered page may be reused before the engine is asked again. Pages export the same number as `revalidate`. */
export const REVALIDATE_SECONDS = 15;

export function engineUrl(): string | null {
  const raw = process.env.PURSER_ENGINE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

type Guard<T> = (value: unknown) => value is T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const NOT_FOUND = Symbol("not-found");

interface EngineAnswer {
  status: number;
  body: string;
}

/**
 * Plain node request instead of fetch on purpose: the framework's fetch cache would keep serving the last good
 * answer after the engine goes down. Pages cache the rendered result for REVALIDATE_SECONDS instead.
 */
function request(url: URL): Promise<EngineAnswer> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method: "GET", headers: { accept: "application/json" }, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) req.destroy(new Error("engine answer too large"));
        else chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("engine timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** The engine's answer, NOT_FOUND for a 404, or null when there is no usable answer. */
export async function fetchEngine<T>(path: string, guard: Guard<T>): Promise<T | typeof NOT_FOUND | null> {
  const base = engineUrl();
  if (!base) return null;
  try {
    const answer = await request(new URL(base + path));
    if (answer.status === 404) return NOT_FOUND;
    if (answer.status < 200 || answer.status >= 300) return null;
    const body: unknown = JSON.parse(answer.body);
    return guard(body) ? body : null;
  } catch {
    return null;
  }
}

async function load<T>(path: string, guard: Guard<T>): Promise<T | null> {
  const answer = await fetchEngine(path, guard);
  return answer === NOT_FOUND ? null : answer;
}

const isPage =
  <T>(item?: (v: unknown) => boolean): Guard<Page<T>> =>
  (v): v is Page<T> =>
    isRecord(v) && Array.isArray(v.items) && (!item || v.items.every(item));

const isEconomy: Guard<Economy> = (v): v is Economy =>
  isRecord(v) && isRecord(v.totals) && isRecord(v.last24h) && Array.isArray(v.topServices) && Array.isArray(v.priceIndex) && Array.isArray(v.series);

const isPublicAgent: Guard<PublicAgent> = (v): v is PublicAgent =>
  isRecord(v) && typeof v.safe === "string" && typeof v.name === "string" && Array.isArray(v.receipts) && Array.isArray(v.rules);

const isConfig: Guard<EngineConfig> = (v): v is EngineConfig =>
  isRecord(v) && typeof v.chainId === "number" && isRecord(v.contracts) && Array.isArray(v.tokens);

const isHealth: Guard<Health> = (v): v is Health => isRecord(v) && typeof v.ok === "boolean" && typeof v.chainId === "number";

const isRun: Guard<FirewallRun> = (v): v is FirewallRun => isRecord(v) && Array.isArray(v.steps);

const hasSafe = (v: unknown) => isRecord(v) && typeof v.safe === "string";
const hasId = (v: unknown) => isRecord(v) && typeof v.id === "string";

export const getHealth = () => load("/v1/health", isHealth);
export const getConfig = () => load("/v1/config", isConfig);
export const getEconomy = (range: "24h" | "30d" = "30d") => load(`/v1/economy?range=${range}`, isEconomy);
export const getLeaderboard = () => load("/v1/leaderboard?limit=50", isPage<LeaderboardEntry>(hasSafe));
export const getTemplates = () => load("/v1/templates", isPage<Template>(hasId));
export const getFirewallRun = () => load("/v1/demo/firewall", isRun);
export const getAccounts = () => load("/v1/accounts", isPage<AccountSummary>(hasSafe));
export const getServicesOf = (safe: string) => load(`/v1/accounts/${encodeURIComponent(safe)}/services`, isPage<StoreService>(hasId));

export function getDirectory(q: { source?: string; sort?: string; q?: string } = {}) {
  const params = new URLSearchParams({ limit: "100" });
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
  return load(`/v1/directory?${params}`, isPage<DirectoryEntry>(hasId));
}

/** A public agent page: the agent, `"private"` when it exists but its owner has not opted in, or null when unknown. */
export async function getPublicAgent(safe: string): Promise<PublicAgent | "private" | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(safe)) return null;
  const answer = await fetchEngine(`/v1/agents/${safe.toLowerCase()}/public`, isPublicAgent);
  if (answer !== NOT_FOUND && answer !== null) return answer;
  // 404 covers both unknown and private agents; the account list tells them apart.
  const accounts = await getAccounts();
  return accounts?.items.some((a) => a.safe.toLowerCase() === safe.toLowerCase()) ? "private" : null;
}

/** The engine's public address, for the pay button script tag (`facilitator` is `<public url>/x402`). */
export function enginePublicUrl(config: EngineConfig | null): string | null {
  if (!config?.facilitator) return null;
  return config.facilitator.replace(/\/x402\/?$/, "");
}
