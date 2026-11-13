/**
 * Deploys the five Purser contracts to Robinhood Chain mainnet (4663) from the engine's relayer key, then reads every
 * wire back from the chain and writes deployment.json for the live engine.
 *
 *   node --import tsx scripts/live-deploy.ts              dry run: predicted addresses and gas, nothing sent
 *   node --import tsx scripts/live-deploy.ts --broadcast  the real deploy (five transactions)
 *
 * Keys come from ~/.purser-keys/keys.json (chmod 600) and are never printed. The contracts have no owner and no
 * admin; the fee recipient and fee are immutable, so the deploying key has no power over them afterwards.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, getContractAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainAddresses, ROBINHOOD_RPC } from "../../packages/sdk/src/chain.ts";
import type { Deployment, EngineKeys } from "../src/config.ts";
import { artifact, ensureBuilt } from "../src/deploy.ts";

const FEE_RECIPIENT: Address = "0xE0e118df1d5898a6F7dff990bCeC571a2BD102fe";
const FEE_BPS = 10n; // 0.1% of each payment, the contract's own default; capped at 1% in the contract
const OUT = process.env.PURSER_DEPLOY_OUT ?? `${process.env.HOME}/.purser-keys/deployment.json`;
const RPC = process.env.PURSER_DEPLOY_RPC ?? ROBINHOOD_RPC; // only the fork rehearsal sets this
const send = process.argv.includes("--broadcast");

const keys = JSON.parse(readFileSync(`${process.env.HOME}/.purser-keys/keys.json`, "utf8")) as EngineKeys;
const deployer = privateKeyToAccount(keys.relayer);
const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 3 }) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC, { retryCount: 3 }) });

if ((await pub.getChainId()) !== 4663) throw new Error("not Robinhood Chain");
if (send && existsSync(OUT)) throw new Error(`already deployed: ${OUT} exists. A second set would split the accounts.`);
ensureBuilt();

// Every outside contract the factory and the engine rely on must already exist on the chain.
for (const [name, a] of Object.entries({ safeSingleton: chainAddresses.safeSingleton, safeProxyFactory: chainAddresses.safeProxyFactory, safeFallbackHandler: chainAddresses.safeFallbackHandler, identityRegistry: chainAddresses.identityRegistry, usdg: chainAddresses.usdg })) {
  const code = await pub.getCode({ address: a as Address });
  if (!code || code === "0x") throw new Error(`${name} ${a} has no code on the chain`);
}

const nonce0 = await pub.getTransactionCount({ address: deployer.address });
const at = (i: number) => getContractAddress({ from: deployer.address, nonce: BigInt(nonce0 + i) });
const plan: [string, string, unknown[]][] = [
  ["PurserModule.sol", "PurserModule", [FEE_RECIPIENT, FEE_BPS]],
  ["PurserFactory.sol", "PurserFactory", [at(0), chainAddresses.safeSingleton, chainAddresses.safeProxyFactory, chainAddresses.safeFallbackHandler, chainAddresses.identityRegistry]],
  ["PurserRecurring.sol", "PurserRecurring", [at(0)]],
  ["PurserEscrow.sol", "PurserEscrow", []],
  ["PurserPasskey.sol", "PurserPasskey", [at(0)]],
];

const gasPrice = await pub.getGasPrice();
const bal = await pub.getBalance({ address: deployer.address });
console.log(`deployer (engine relayer) ${deployer.address}  balance ${Number(bal) / 1e18} ETH  nonce ${nonce0}`);
console.log(`fee recipient ${FEE_RECIPIENT}  fee ${FEE_BPS} bps`);
let totalGas = 0n;
const datas: Hex[] = [];
for (const [i, [file, name, args]] of plan.entries()) {
  const a = artifact(file, name);
  const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args });
  datas.push(data);
  let gas: bigint;
  try {
    gas = await pub.estimateGas({ account: deployer.address, data });
  } catch {
    gas = BigInt(Math.ceil(((data.length - 2) / 2) * 220 + 200_000)); // estimate refused (no balance yet): a size-based upper bound
  }
  totalGas += gas;
  console.log(`  ${String(i + 1)}. ${name.padEnd(16)} ${at(i)}  ~${gas} gas`);
}
const cost = (totalGas * gasPrice * 13n) / 10n;
console.log(`total ~${totalGas} gas at ${Number(gasPrice) / 1e9} gwei: about ${Number(cost) / 1e18} ETH with a 30% margin`);

if (!send) {
  console.log("\nDRY RUN. Nothing was sent. Run again with --broadcast to deploy.");
  process.exit(0);
}
if (bal < cost) throw new Error(`the deployer needs about ${Number(cost) / 1e18} ETH and holds ${Number(bal) / 1e18}`);

const startBlock = Number(await pub.getBlockNumber()) - 1;
const deployed: Address[] = [];
for (const [i, data] of datas.entries()) {
  const hash = await wallet.sendTransaction({ account: deployer, chain, data, nonce: nonce0 + i });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy ${i + 1} failed: ${hash}`);
  deployed.push(r.contractAddress);
  console.log(`  deployed ${plan[i][1]} ${r.contractAddress}  tx ${hash}`);
}
const [module, factory, recurring, escrow, passkey] = deployed;

// Read every wire back from the chain.
const read = async (address: Address, fn: string, out: string) =>
  pub.readContract({ address, abi: [{ type: "function", name: fn, inputs: [], outputs: [{ type: out }], stateMutability: "view" }], functionName: fn } as never);
const checks: [string, unknown, unknown][] = [
  ["module.FEE_RECIPIENT", await read(module, "FEE_RECIPIENT", "address"), FEE_RECIPIENT],
  ["module.FEE_BPS", await read(module, "FEE_BPS", "uint256"), FEE_BPS],
  ["factory.MODULE", await read(factory, "MODULE", "address"), module],
  ["factory.SAFE_SINGLETON", await read(factory, "SAFE_SINGLETON", "address"), chainAddresses.safeSingleton],
  ["factory.PROXY_FACTORY", await read(factory, "PROXY_FACTORY", "address"), chainAddresses.safeProxyFactory],
  ["factory.IDENTITY_REGISTRY", await read(factory, "IDENTITY_REGISTRY", "address"), chainAddresses.identityRegistry],
  ["recurring.MODULE", await read(recurring, "MODULE", "address"), module],
  ["passkey.MODULE", await read(passkey, "MODULE", "address"), module],
];
let ok = true;
for (const [name, got, want] of checks) {
  const same = String(got).toLowerCase() === String(want).toLowerCase();
  ok &&= same;
  console.log(`  ${same ? "ok  " : "FAIL"} ${name} = ${String(got)}`);
}
if (!ok) throw new Error("a wire does not match; deployment.json not written");

const dep: Deployment = {
  chainId: 4663,
  mode: "live",
  module,
  factory,
  recurring,
  escrow,
  passkey,
  usdg: chainAddresses.usdg,
  weth: chainAddresses.weth,
  feeRecipient: FEE_RECIPIENT,
  feeBps: Number(FEE_BPS),
  safeSingleton: chainAddresses.safeSingleton,
  safeProxyFactory: chainAddresses.safeProxyFactory,
  safeFallbackHandler: chainAddresses.safeFallbackHandler,
  identityRegistry: chainAddresses.identityRegistry,
  swapRouter: chainAddresses.swapRouter02,
  vaults: [chainAddresses.steakhouseUsdgVault],
  ethUsdFeed: chainAddresses.ethUsdFeed,
  deployedAt: Math.floor(Date.now() / 1000),
  startBlock,
};
writeFileSync(OUT, JSON.stringify(dep, null, 2), { mode: 0o600 });
console.log(`\nDONE. Every wire checked. ${OUT} written for the live engine.`);
