import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC } from "../../packages/sdk/src/chain.ts";

/**
 * The $PURSER token keeper. Off unless TOKEN_KEEPER=on. Every few minutes it:
 *   1. sweeps the splitter (releases the creator fees on the curve, claims them from Pons' escrow, splits them),
 *      at most once per sweep interval and only when the sweep would move something
 *   2. claims any $PURSER the escrow holds for the splitter and sends it to the burn pot (claimToken)
 *   3. burns, when the pot says a burn would go through (at most every 30 minutes, the pot enforces it)
 * Each call is simulated first and only sent when the simulation succeeds and has something to do. Every call is
 * one anyone may make; the bot wallet only pays the gas. This is the one part of the engine that sends to the live
 * chain, which is why it is separate from the rest of the engine and off by default.
 *
 * Environment: PURSER_BURN_POT, PURSER_SPLITTER, BOT_PRIVATE_KEY (never logged), and optionally
 * TOKEN_KEEPER_RPC_URL (else PURSER_RPC_URL, else the public node) with PURSER_RPC_FALLBACK_URLS,
 * TOKEN_KEEPER_TICK_MS (default 5 minutes) and TOKEN_KEEPER_SWEEP_MS (default 30 minutes).
 */

export const burnPotAbi = parseAbi([
  "function token() view returns (address)",
  "function preview() view returns (uint256 amount, uint256 nextAt, bool ready, uint256 tokens)",
  "function burn(uint256 minTokensOut) returns (uint256 ethIn, uint256 tokensBurned)",
]);
export const splitterAbi = parseAbi([
  "function sweep() returns (uint256 amount)",
  "function claimToken() returns (uint256 amount)",
]);

export interface TokenKeeperConfig {
  burnPot: Address;
  splitter: Address;
  key: Hex;
  rpcUrls: string[];
  chainId: number;
  tickMs: number;
  sweepMs: number;
}

/** Null when the keeper is off (the default). Throws, naming the variable but never its value, when it is on and
 *  something it needs is missing or malformed. */
export function tokenKeeperConfig(env: NodeJS.ProcessEnv = process.env): TokenKeeperConfig | null {
  if (env.TOKEN_KEEPER !== "on") return null;
  const addr = (name: string): Address => {
    const v = env[name]?.trim();
    if (!v || !isAddress(v)) throw new Error(`TOKEN_KEEPER=on needs ${name}: a contract address`);
    return v as Address;
  };
  const burnPot = addr("PURSER_BURN_POT");
  const splitter = addr("PURSER_SPLITTER");
  let key = (env.BOT_PRIVATE_KEY ?? "").trim();
  if (key && !key.startsWith("0x")) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("TOKEN_KEEPER=on needs BOT_PRIVATE_KEY: one private key (64 hex characters)");
  const rpc = env.TOKEN_KEEPER_RPC_URL?.trim() || env.PURSER_RPC_URL?.trim() || ROBINHOOD_RPC;
  const fallbacks = (env.PURSER_RPC_FALLBACK_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const rpcUrls = [...new Set([rpc, ...fallbacks, ROBINHOOD_RPC])];
  const tickMs = Number(env.TOKEN_KEEPER_TICK_MS ?? 5 * 60_000);
  const sweepMs = Number(env.TOKEN_KEEPER_SWEEP_MS ?? 30 * 60_000);
  if (!(tickMs >= 10_000) || !(sweepMs >= tickMs)) throw new Error("TOKEN_KEEPER_TICK_MS must be at least 10000 and TOKEN_KEEPER_SWEEP_MS at least the tick");
  return { burnPot, splitter, key: key as Hex, rpcUrls, chainId: Number(env.PURSER_CHAIN_ID ?? ROBINHOOD_CHAIN_ID), tickMs, sweepMs };
}

/** What the keeper needs from the chain. The live one is makeKeeperIO; the tests hand in a fake. */
export interface KeeperIO {
  sender: Address;
  token(): Promise<Address>;
  preview(): Promise<{ amount: bigint; nextAt: bigint; ready: boolean; tokens: bigint }>;
  /** Simulates the call from the bot wallet; returns its first return value, or throws its revert. */
  simulate(call: KeeperCall): Promise<bigint>;
  /** Sends the call from the bot wallet and waits for the receipt. */
  send(call: KeeperCall): Promise<{ hash: Hex; ok: boolean }>;
  balance(): Promise<bigint>;
}

export type KeeperCall = "sweep" | "claimToken" | "burn";

export interface KeeperAction {
  call: KeeperCall;
  at: number;
  hash?: Hex;
  ok: boolean;
  amount?: string;
  error?: string;
}

export interface TokenKeeper {
  tick(): Promise<KeeperAction[]>;
  start(): void;
  stop(): void;
  status(): { sender: Address; running: boolean; lastTickAt: number | null; lastSweepAt: number | null; actions: KeeperAction[] };
}

const ZERO = "0x0000000000000000000000000000000000000000";
/** Below this the bot wallet warns in the log: it pays every call's gas. */
export const LOW_GAS_BALANCE = 500_000_000_000_000n; // 0.0005 ETH

/** A short reason for a failure, without any URL (a node URL can carry a key) and without the private key. */
export function reason(err: unknown, secret?: string): string {
  const e = err as { shortMessage?: string; message?: string };
  let s = String(e?.shortMessage ?? e?.message ?? err).split("\n")[0];
  s = s.replace(/https?:\/\/\S+/g, "<rpc>");
  if (secret) s = s.split(secret).join("<key>").split(secret.replace(/^0x/, "")).join("<key>");
  return s.slice(0, 200);
}

export function createTokenKeeper(
  io: KeeperIO,
  opts: { tickMs: number; sweepMs: number; now?: () => number; log?: (line: string) => void; secret?: string },
): TokenKeeper {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(`[token-keeper] ${line}`));
  const actions: KeeperAction[] = [];
  let current: KeeperAction[] = [];
  let lastTickAt: number | null = null;
  let lastSweepAt: number | null = null;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const record = (a: KeeperAction) => {
    current.push(a);
    actions.unshift(a);
    if (actions.length > 50) actions.pop();
    log(`${a.call} ${a.ok ? "ok" : "FAILED"}${a.amount ? ` amount ${a.amount}` : ""}${a.hash ? ` tx ${a.hash}` : ""}${a.error ? ` (${a.error})` : ""}`);
  };

  /** Simulate; send only if the simulation says there is something to do. A revert in simulation is not a failure
   *  worth a transaction: it is logged only when it is not one of the pot's expected waits. */
  async function attempt(call: KeeperCall, worthIt: (v: bigint) => boolean): Promise<void> {
    let v: bigint;
    try {
      v = await io.simulate(call);
    } catch (err) {
      const r = reason(err, opts.secret);
      if (!/TooSoon|TooSmall|NothingToBurn|MarketNotReady|TokenNotSet/.test(r)) log(`${call}: not sent, simulation reverted (${r})`);
      return;
    }
    if (!worthIt(v)) return;
    try {
      const { hash, ok } = await io.send(call);
      record({ call, at: now(), hash, ok, amount: v.toString() });
    } catch (err) {
      record({ call, at: now(), ok: false, error: reason(err, opts.secret) });
    }
  }

  async function tick(): Promise<KeeperAction[]> {
    if (busy) return [];
    busy = true;
    current = [];
    try {
      lastTickAt = now();
      const token = await io.token();
      if (token === ZERO) {
        log("the burn pot has no token yet (setToken has not run); waiting");
        return current;
      }
      const bal = await io.balance();
      if (bal < LOW_GAS_BALANCE) log(`the bot wallet ${io.sender} is low on gas: ${bal} wei`);
      if (lastSweepAt === null || now() - lastSweepAt >= opts.sweepMs) {
        lastSweepAt = now();
        await attempt("sweep", (v) => v > 0n);
        await attempt("claimToken", (v) => v > 0n);
      }
      const p = await io.preview();
      if (p.ready) await attempt("burn", () => true);
    } catch (err) {
      log(`tick failed: ${reason(err, opts.secret)}`);
    } finally {
      busy = false;
    }
    return current;
  }

  return {
    tick,
    start() {
      if (timer) return;
      log(`on: bot wallet ${io.sender}, tick ${opts.tickMs / 1000}s, sweep every ${opts.sweepMs / 1000}s`);
      void tick();
      timer = setInterval(() => void tick(), opts.tickMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status: () => ({ sender: io.sender, running: timer !== null, lastTickAt, lastSweepAt, actions: [...actions] }),
  };
}

/** The live chain, through viem, signing with the bot key. */
export function makeKeeperIO(cfg: TokenKeeperConfig): KeeperIO {
  const chain = defineChain({
    id: cfg.chainId,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: cfg.rpcUrls } },
  });
  const transport = cfg.rpcUrls.length > 1 ? fallback(cfg.rpcUrls.map((u) => http(u, { retryCount: 2 }))) : http(cfg.rpcUrls[0], { retryCount: 2 });
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const account = privateKeyToAccount(cfg.key);
  const wallet = createWalletClient({ account, chain, transport });
  const target = (call: KeeperCall) =>
    call === "burn"
      ? ({ address: cfg.burnPot, abi: burnPotAbi, functionName: "burn", args: [0n] } as const)
      : ({ address: cfg.splitter, abi: splitterAbi, functionName: call } as const);

  return {
    sender: account.address,
    token: () => pub.readContract({ address: cfg.burnPot, abi: burnPotAbi, functionName: "token" }),
    async preview() {
      const [amount, nextAt, ready, tokens] = await pub.readContract({ address: cfg.burnPot, abi: burnPotAbi, functionName: "preview" });
      return { amount, nextAt, ready, tokens };
    },
    async simulate(call) {
      const { result } = await pub.simulateContract({ ...target(call), account } as Parameters<typeof pub.simulateContract>[0]);
      return Array.isArray(result) ? (result[0] as bigint) : (result as bigint);
    },
    async send(call) {
      const { request } = await pub.simulateContract({ ...target(call), account } as Parameters<typeof pub.simulateContract>[0]);
      const hash = await wallet.writeContract(request as Parameters<typeof wallet.writeContract>[0]);
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      return { hash, ok: receipt.status === "success" };
    },
    balance: () => pub.getBalance({ address: account.address }),
  };
}

let running: TokenKeeper | null = null;

/** Starts the keeper when TOKEN_KEEPER=on; does nothing otherwise. Called once from main.ts. */
export function startTokenKeeper(env: NodeJS.ProcessEnv = process.env): TokenKeeper | null {
  const cfg = tokenKeeperConfig(env);
  if (!cfg) return null;
  running = createTokenKeeper(makeKeeperIO(cfg), { tickMs: cfg.tickMs, sweepMs: cfg.sweepMs, secret: cfg.key });
  running.start();
  return running;
}

export function stopTokenKeeper() {
  running?.stop();
  running = null;
}
