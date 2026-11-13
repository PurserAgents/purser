import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { encodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "../../packages/sdk/src/abi.ts";
import type { AccountConfig } from "../../packages/sdk/src/schema.ts";
import { prepareCreate, readChainAccount, sendAsTestOwner, upsertAccount, type RuleInput } from "../src/accounts.ts";
import { loadConfig, type Deployment, type EngineKeys } from "../src/config.ts";
import { deployLocal, newKeys } from "../src/deploy.ts";
import { createEngine, type Engine } from "../src/engine.ts";
import { indexOnce } from "../src/indexer.ts";
import { ZERO } from "../src/util.ts";

process.env.PURSER_LOG = "0";

export async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

export interface Anvil {
  url: string;
  proc: ChildProcess;
  stop(): Promise<void>;
}

export async function startAnvil(opts: { fork?: string } = {}): Promise<Anvil> {
  const port = await freePort();
  const args = ["--port", String(port), "--chain-id", "4663", "--silent", "--hardfork", "osaka"];
  if (opts.fork) args.push("--fork-url", opts.fork, "--no-storage-caching");
  const bin = resolve(process.env.HOME ?? "", ".foundry/bin/anvil");
  const proc = spawn("nice", [bin, ...args], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    proc,
    stop: () =>
      new Promise<void>((res) => {
        if (proc.exitCode !== null) return res();
        proc.once("exit", () => res());
        proc.kill("SIGTERM");
      }),
  };
}

export interface World {
  anvil: Anvil;
  dep: Deployment;
  keys: EngineKeys;
  engine: Engine;
  ctx: Engine["ctx"];
  owner: ReturnType<typeof privateKeyToAccount>;
  agent: ReturnType<typeof privateKeyToAccount>;
  rpc(method: string, params: unknown[]): Promise<unknown>;
  stop(): Promise<void>;
}

export async function makeWorld(opts: { fork?: string } = {}): Promise<World> {
  const anvil = await startAnvil(opts);
  const keys = newKeys(true);
  const dep = await deployLocal({ rpcUrl: anvil.url, mode: opts.fork ? "fork" : "local", keys });
  const cfg = loadConfig({}, { rpcUrls: [anvil.url], dbPath: ":memory:", deployment: dep, keys, testMode: true, publicUrl: "http://engine.test" });
  const engine = createEngine(cfg);
  const ctx = engine.ctx;
  return {
    anvil,
    dep,
    keys,
    engine,
    ctx,
    owner: privateKeyToAccount(keys.owner!),
    agent: privateKeyToAccount(keys.agent!),
    rpc: (method, params) => ctx.chain.pub.request({ method: method as never, params: params as never }),
    async stop() {
      engine.stop();
      ctx.db.close();
      await anvil.stop();
    },
  };
}

export const usdg = (n: string | number) => parseUnits(String(n), 6);

export function defaultConfig(w: World, over: Partial<AccountConfig> = {}): AccountConfig {
  return {
    agent: w.agent.address,
    cosigner: null,
    firewall: w.ctx.chain.accounts.firewall!.address,
    watchdog: w.ctx.chain.accounts.watchdog!.address,
    maxPerMinute: null,
    hoursUtc: [],
    weekdays: [],
    payeeAllowlist: false,
    serviceAllowlist: false,
    ...over,
  };
}

export const defaultRule: RuleInput = {
  enabled: true,
  receivable: true,
  maxSingle: usdg(250).toString(),
  daily: usdg(1000).toString(),
  weekly: usdg(5000).toString(),
  perCounterpartyDaily: usdg(500).toString(),
  approvalAbove: usdg(200).toString(),
  cosignAbove: null,
  keepLiquid: "0",
};

/** Creates an account as the test owner through the factory, funds it with test USDG and ETH, indexes it. */
export async function createAccount(
  w: World,
  opts: { config?: Partial<AccountConfig>; rule?: RuleInput; ethRule?: RuleInput; allow?: Address[]; fund?: bigint; name?: string; salt?: bigint } = {},
): Promise<Address> {
  const { predictedSafe, tx } = await prepareCreate(w.ctx, {
    owners: [w.owner.address],
    creator: w.owner.address,
    salt: opts.salt ?? BigInt(Math.floor(Math.random() * 1e9)),
    setup: {
      config: defaultConfig(w, opts.config),
      rules: [
        { token: w.dep.usdg, rule: opts.rule ?? defaultRule },
        { token: ZERO, rule: opts.ethRule ?? { maxSingle: (10n ** 17n).toString(), daily: (10n ** 18n).toString(), weekly: (5n * 10n ** 18n).toString(), perCounterpartyDaily: (10n ** 18n).toString(), approvalAbove: (5n * 10n ** 16n).toString(), cosignAbove: null } },
      ],
      allow: [w.dep.escrow, ...(opts.allow ?? [])],
      extensions: [w.dep.recurring],
      agentURI: "https://purseragents.fun/agents/test.json",
    },
  });
  await sendAsTestOwner(w.ctx, tx);
  const acct = await readChainAccount(w.ctx, predictedSafe);
  if (!acct.initialized) throw new Error("account not created");
  await fundUsdg(w, predictedSafe, opts.fund ?? usdg(10_000));
  await w.rpc("anvil_setBalance", [predictedSafe, "0x" + (10n ** 18n).toString(16)]);
  await indexOnce(w.ctx);
  upsertAccount(w.ctx, { safe: predictedSafe, name: opts.name ?? "Test agent", owners: [w.owner.address], kind: "research" });
  return predictedSafe;
}

export async function fundUsdg(w: World, to: Address, amount: bigint) {
  if (w.dep.mode === "local") {
    await w.ctx.chain.send(w.ctx.chain.accounts.relayer!, { to: w.dep.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [to, amount] }) });
    return;
  }
  const whale = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca" as Address;
  await w.rpc("anvil_impersonateAccount", [whale]);
  await w.rpc("anvil_setBalance", [whale, "0x" + (10n ** 18n).toString(16)]);
  await w.rpc("eth_sendTransaction", [{ from: whale, to: w.dep.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) }]);
  await w.rpc("anvil_stopImpersonatingAccount", [whale]);
}

export async function usdgBalance(w: World, who: Address): Promise<bigint> {
  return w.ctx.chain.pub.readContract({ address: w.dep.usdg, abi: erc20Abi, functionName: "balanceOf", args: [who] });
}

export const randomAddress = (): Address => privateKeyToAccount(("0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex).address;

/**
 * An engine with no node and no deployment (the RPC URL points at a closed local port): enough for everything that
 * lives in the database (keys, receipts, webhooks, audit, alerts storage) and for pure API checks.
 */
export function makeOfflineEngine(over: Partial<Parameters<typeof loadConfig>[1]> = {}): Engine {
  const cfg = loadConfig(
    { PURSER_DEPLOYMENT: "/nonexistent/deployment.json", PURSER_KEYS: "/nonexistent/keys.json" },
    { rpcUrls: ["http://127.0.0.1:1"], dbPath: ":memory:", deployment: null, keys: null, testMode: false, publicUrl: "http://engine.test", ...over },
  );
  return createEngine(cfg);
}
