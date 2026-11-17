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
// the tests run their stand-in services on this machine; the engine refuses private hosts unless told otherwise
process.env.PURSER_FETCH_PRIVATE = "1";

/**
 * Fork tests read the live chain, so they run only when RPC_URL names a node: the default run never depends on the
 * network. RPC_URL=https://rpc.mainnet.chain.robinhood.com npm test runs them too.
 */
export const FORK_RPC = process.env.RPC_URL || null;

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
  const bin = resolve(process.env.HOME ?? "", ".foundry/bin/anvil");
  // a free port can be taken by another process before anvil binds it: try a fresh port if this one does not answer
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    const args = ["--port", String(port), "--chain-id", "4663", "--silent", "--hardfork", "osaka"];
    if (opts.fork) args.push("--fork-url", opts.fork, "--no-storage-caching");
    const proc = spawn("nice", [bin, ...args], { stdio: "ignore" });
    const url = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 150 && proc.exitCode === null; i++) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
        if (r.ok && (await r.json()).result === "0x1237") {
          up = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const stop = () =>
      new Promise<void>((res) => {
        if (proc.exitCode !== null) return res();
        proc.once("exit", () => res());
        proc.kill("SIGTERM");
      });
    if (up) return { url, proc, stop };
    await stop();
  }
  throw new Error("anvil did not start (five ports tried)");
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
  opts: { config?: Partial<AccountConfig>; rule?: RuleInput; ethRule?: RuleInput; allow?: Address[]; fund?: bigint; name?: string; salt?: bigint; owners?: Address[] } = {},
): Promise<Address> {
  const { predictedSafe, tx } = await prepareCreate(w.ctx, {
    owners: opts.owners ?? [w.owner.address],
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
  upsertAccount(w.ctx, { safe: predictedSafe, name: opts.name ?? "Test agent", owners: opts.owners ?? [w.owner.address], kind: "research" });
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

/**
 * Purser Shield counts a report for others only from an independent account in good standing. This gives an account
 * that standing in the test database: $25 paid out to three payees, $5 of it as model credit that calls used up
 * (money it cannot take back), all backdated 31 days, and its own owner.
 */
export async function giveStanding(w: World, safe: Address, owner: Address = randomAddress()) {
  const { submitIntent } = await import("../src/intents.ts");
  const { CREDIT_SERVICE } = await import("../src/models.ts");
  process.env.PURSER_MODELS_PAYTO ??= "0x00000000000000000000000000000000000c0de5";
  const pays: [Address, bigint, string?][] = [
    [randomAddress(), usdg(10)],
    [randomAddress(), usdg(10)],
    [process.env.PURSER_MODELS_PAYTO as Address, usdg(5), CREDIT_SERVICE],
  ];
  for (const [to, amount, service] of pays) {
    const r = await submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to, amount, service } }, category: "transfer", signer: w.agent });
    if (r.intent.status !== "executed") throw new Error(`standing payment: ${r.intent.status} ${r.intent.error ?? ""}`);
  }
  // the $5 of credit is used up by model calls (unused credit could be withdrawn, so it would not count)
  w.ctx.db
    .prepare("INSERT INTO model_calls (id, safe, provider, model, prompt_tokens, completion_tokens, cost_micro, receipt_id, task_id, created_at) VALUES (?, ?, 'purser', 'claude-opus-5-5', 1000, 1000, '5000000', 'credit', NULL, ?)")
    .run(`standing_${safe.toLowerCase()}`, safe.toLowerCase(), Math.floor(Date.now() / 1000));
  w.ctx.db.prepare("UPDATE model_credit SET balance_micro = balance_micro - 5000000 WHERE safe = ?").run(safe.toLowerCase());
  w.ctx.db.prepare("UPDATE receipts SET created_at = created_at - 31 * 86400 WHERE safe = ?").run(safe.toLowerCase());
  w.ctx.db.prepare("UPDATE accounts SET owners = ? WHERE safe = ?").run(JSON.stringify([owner.toLowerCase()]), safe.toLowerCase());
  w.ctx.db.prepare("DELETE FROM kv WHERE key = ?").run(`owners_seen:${safe.toLowerCase()}`);
}
