import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { chainAddresses, ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC } from "../../packages/sdk/src/chain.ts";

export const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(ENGINE_ROOT, "..");
export const VERSION = "0.1.0";

/** Addresses of the Purser contracts and the tokens the engine works with, written by scripts/deploy.ts. */
export interface Deployment {
  chainId: number;
  mode: "local" | "fork" | "live";
  module: Address;
  factory: Address;
  recurring: Address;
  escrow: Address;
  passkey: Address;
  usdg: Address;
  weth: Address | null;
  feeRecipient: Address;
  feeBps: number;
  safeSingleton: Address;
  safeProxyFactory: Address;
  safeFallbackHandler: Address;
  identityRegistry: Address | null;
  swapRouter: Address | null;
  vaults: Address[];
  ethUsdFeed: Address | null;
  deployedAt: number;
  startBlock?: number; // the indexer starts here (the block before the first Purser contract)
}

/** Engine keys. In this build they exist only for local and fork test mode (scripts/testmode.ts writes them). */
export interface EngineKeys {
  relayer: Hex; // pays gas to submit intents (local node only)
  firewall: Hex; // co-signs intents the firewall allowed
  watchdog: Hex; // may freeze accounts whose owner enabled it
  audit: Hex; // signs the audit trail
  owner?: Hex; // test mode only: plays the owner's wallet
  agent?: Hex; // test mode only: the demo agent's session key
}

export interface Config {
  port: number;
  publicUrl: string;
  rpcUrls: string[];
  chainId: number;
  dbPath: string;
  deployment: Deployment | null;
  keys: EngineKeys | null;
  testMode: boolean;
  indexIntervalMs: number;
  schedulerIntervalMs: number;
  defaultTokenName: string;
}

function readJson<T>(path: string | undefined): T | null {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = resolve(ENGINE_ROOT, "data");
  const rpc = env.PURSER_RPC_URL ?? "http://127.0.0.1:8545";
  const fallbacks = (env.PURSER_RPC_FALLBACK_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const base: Config = {
    port: Number(env.PURSER_PORT ?? 8787),
    publicUrl: env.PURSER_PUBLIC_URL ?? `http://localhost:${env.PURSER_PORT ?? 8787}`,
    rpcUrls: [rpc, ...fallbacks],
    chainId: Number(env.PURSER_CHAIN_ID ?? ROBINHOOD_CHAIN_ID),
    dbPath: env.PURSER_DB ?? resolve(dataDir, "purser.sqlite"),
    // On a host the deployment and the keys can come as JSON in a variable (never logged); else from files.
    deployment: env.PURSER_DEPLOYMENT_JSON ? (JSON.parse(env.PURSER_DEPLOYMENT_JSON) as Deployment) : readJson<Deployment>(env.PURSER_DEPLOYMENT ?? resolve(dataDir, "deployment.json")),
    keys: env.PURSER_KEYS_JSON ? (JSON.parse(env.PURSER_KEYS_JSON) as EngineKeys) : readJson<EngineKeys>(env.PURSER_KEYS ?? resolve(dataDir, "keys.json")),
    testMode: env.PURSER_TEST_MODE === "1",
    indexIntervalMs: Number(env.PURSER_INDEX_INTERVAL_MS ?? 2000),
    schedulerIntervalMs: Number(env.PURSER_SCHEDULER_INTERVAL_MS ?? 15000),
    defaultTokenName: "USDG",
  };
  return { ...base, ...overrides };
}

/** Read-only defaults for a live-chain engine without a deployment (nothing is ever sent there). */
export const liveReadOnly = { rpc: ROBINHOOD_RPC, addresses: chainAddresses };
