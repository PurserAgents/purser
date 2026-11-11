import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, http, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainAddresses } from "../../packages/sdk/src/chain.ts";
import { isLocalRpc } from "./chain.ts";
import { REPO_ROOT, type Deployment, type EngineKeys } from "./config.ts";

const CONTRACTS = resolve(REPO_ROOT, "contracts");
const FOUNDRY_BIN = resolve(process.env.HOME ?? "", ".foundry/bin");

export function ensureBuilt() {
  if (existsSync(resolve(CONTRACTS, "out/PurserModule.sol/PurserModule.json")) && existsSync(resolve(CONTRACTS, "out/Mocks.sol/MockToken.json"))) return;
  execFileSync(resolve(FOUNDRY_BIN, "forge"), ["build"], { cwd: CONTRACTS, stdio: "inherit" });
}

export function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(CONTRACTS, "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

const fixture = (name: string) => readFileSync(resolve(CONTRACTS, "test/fixtures", `${name}.hex`), "utf8").trim() as Hex;

export function newKeys(withTestActors = true): EngineKeys {
  return {
    relayer: generatePrivateKey(),
    firewall: generatePrivateKey(),
    watchdog: generatePrivateKey(),
    audit: generatePrivateKey(),
    ...(withTestActors ? { owner: generatePrivateKey(), agent: generatePrivateKey() } : {}),
  };
}

/**
 * Deploys Purser to a LOCAL node only (anvil). Two shapes:
 * - local: a plain anvil chain with id 4663; the real Safe 1.4.1 bytecode is placed at its canonical addresses and
 *   a test token stands in for USDG.
 * - fork: an anvil fork of Robinhood Chain; the real Safe, ERC-8004 registry, USDG and vaults are used.
 */
export async function deployLocal(opts: { rpcUrl: string; mode: "local" | "fork"; keys: EngineKeys; feeBps?: number }): Promise<Deployment> {
  if (!isLocalRpc([opts.rpcUrl])) throw new Error("deployLocal only talks to a local node");
  ensureBuilt();
  const chain = defineChain({ id: 4663, name: "Robinhood Chain (local)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [opts.rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const rpc = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });

  const deployer = privateKeyToAccount(opts.keys.relayer);
  const fund = [opts.keys.relayer, opts.keys.firewall, opts.keys.watchdog, opts.keys.owner, opts.keys.agent].filter(Boolean) as Hex[];
  for (const k of fund) await rpc("anvil_setBalance", [privateKeyToAccount(k).address, "0x56BC75E2D63100000"]); // 100 ETH
  if (opts.mode === "fork") await rpc("anvil_mine", ["0x1"]); // forked head has no blob fields; mine one block first

  const startBlock = Number(await pub.getBlockNumber());
  const wallet = createWalletClient({ account: deployer, chain, transport: http(opts.rpcUrl) });
  async function deploy(file: string, name: string, args: unknown[] = []): Promise<Address> {
    const a = artifact(file, name);
    const hash = await wallet.sendTransaction({ account: deployer, chain, data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) });
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (!r.contractAddress) throw new Error(`deploy of ${name} failed`);
    return r.contractAddress;
  }

  let usdg: Address = chainAddresses.usdg;
  let identity: Address | null = chainAddresses.identityRegistry;
  let vaults: Address[] = [chainAddresses.steakhouseUsdgVault];
  if (opts.mode === "local") {
    await rpc("anvil_setCode", [chainAddresses.safeSingleton, fixture("safe")]);
    await rpc("anvil_setCode", [chainAddresses.safeProxyFactory, fixture("factory")]);
    await rpc("anvil_setCode", [chainAddresses.safeFallbackHandler, fixture("fallback")]);
    await rpc("anvil_setCode", [chainAddresses.multiSendCallOnly, fixture("multisendcallonly")]);
    usdg = await deploy("Mocks.sol", "MockToken", ["Global Dollar", "USDG", 6]);
    identity = await deploy("Mocks.sol", "MockIdentityRegistry");
    vaults = [await deploy("Mocks.sol", "MockVault", [usdg])];
  }
  const feeRecipient = privateKeyToAccount(generatePrivateKey()).address;
  const feeBps = opts.feeBps ?? 10;
  const module = await deploy("PurserModule.sol", "PurserModule", [feeRecipient, BigInt(feeBps)]);
  const factory = await deploy("PurserFactory.sol", "PurserFactory", [module, chainAddresses.safeSingleton, chainAddresses.safeProxyFactory, chainAddresses.safeFallbackHandler, identity ?? "0x0000000000000000000000000000000000000000"]);
  const recurring = await deploy("PurserRecurring.sol", "PurserRecurring", [module]);
  const escrow = await deploy("PurserEscrow.sol", "PurserEscrow");
  const passkey = await deploy("PurserPasskey.sol", "PurserPasskey", [module]);
  return {
    chainId: 4663,
    mode: opts.mode,
    module,
    factory,
    recurring,
    escrow,
    passkey,
    usdg,
    weth: opts.mode === "fork" ? chainAddresses.weth : null,
    feeRecipient,
    feeBps,
    safeSingleton: chainAddresses.safeSingleton,
    safeProxyFactory: chainAddresses.safeProxyFactory,
    safeFallbackHandler: chainAddresses.safeFallbackHandler,
    identityRegistry: identity,
    swapRouter: opts.mode === "fork" ? chainAddresses.swapRouter02 : null,
    vaults,
    ethUsdFeed: opts.mode === "fork" ? chainAddresses.ethUsdFeed : null,
    deployedAt: Math.floor(Date.now() / 1000),
    startBlock,
  };
}
