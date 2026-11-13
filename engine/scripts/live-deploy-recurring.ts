/**
 * Deploys PurserRecurring version 2 to Robinhood Chain mainnet (4663) next to the live module, from the engine's relayer
 * key, reads it back, and points deployment.json at it. Version 2 gives every recurring payout a fresh firewall check.
 *
 *   node --import tsx scripts/live-deploy-recurring.ts              dry run: predicted address and gas, nothing sent
 *   node --import tsx scripts/live-deploy-recurring.ts --broadcast  the real deploy (one transaction)
 *
 * The old recurring contract stays on chain and keeps working for whatever already uses it; new accounts enable
 * version 2. deployment.json is kept as deployment.recurring-v1.json before it is changed.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, getContractAddress, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROBINHOOD_RPC } from "../../packages/sdk/src/chain.ts";
import type { Deployment, EngineKeys } from "../src/config.ts";
import { artifact, ensureBuilt } from "../src/deploy.ts";

const DIR = `${process.env.HOME}/.purser-keys`;
const DEP = process.env.PURSER_DEPLOY_OUT ?? `${DIR}/deployment.json`;
const RPC = process.env.PURSER_DEPLOY_RPC ?? ROBINHOOD_RPC; // only the fork rehearsal sets this
const send = process.argv.includes("--broadcast");

const keys = JSON.parse(readFileSync(`${DIR}/keys.json`, "utf8")) as EngineKeys;
const dep = JSON.parse(readFileSync(DEP, "utf8")) as Deployment;
const deployer = privateKeyToAccount(keys.relayer);
const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 3 }) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC, { retryCount: 3 }) });

if ((await pub.getChainId()) !== 4663) throw new Error("not Robinhood Chain");
if (dep.mode !== "live") throw new Error(`${DEP} is not the live deployment`);
const moduleCode = await pub.getCode({ address: dep.module });
if (!moduleCode || moduleCode === "0x") throw new Error(`the module ${dep.module} has no code on this chain`);
ensureBuilt();

const a = artifact("PurserRecurring.sol", "PurserRecurring");
const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: [dep.module] });
const nonce = await pub.getTransactionCount({ address: deployer.address });
const predicted = getContractAddress({ from: deployer.address, nonce: BigInt(nonce) });
const gasPrice = await pub.getGasPrice();
const bal = await pub.getBalance({ address: deployer.address });
let gas: bigint;
try {
  gas = await pub.estimateGas({ account: deployer.address, data });
} catch {
  gas = BigInt(Math.ceil(((data.length - 2) / 2) * 220 + 200_000));
}
const cost = (gas * gasPrice * 13n) / 10n;
console.log(`deployer (engine relayer) ${deployer.address}  balance ${Number(bal) / 1e18} ETH  nonce ${nonce}`);
console.log(`module ${dep.module}  (live, unchanged)`);
console.log(`old recurring ${dep.recurring}`);
console.log(`new recurring ${predicted}  ~${gas} gas, about ${Number(cost) / 1e18} ETH with a 30% margin`);
if (!send) {
  console.log("\nDRY RUN. Nothing was sent. Run again with --broadcast to deploy.");
  process.exit(0);
}
if (bal < cost) throw new Error(`the deployer needs about ${Number(cost) / 1e18} ETH and holds ${Number(bal) / 1e18}`);

const hash = await wallet.sendTransaction({ account: deployer, chain, data, nonce });
const r = await pub.waitForTransactionReceipt({ hash });
if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed: ${hash}`);
const recurring = r.contractAddress as Address;
console.log(`  deployed PurserRecurring v2 ${recurring}  tx ${hash}`);

const abi = [
  { type: "function", name: "MODULE", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "CHARGE_TYPEHASH", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" },
] as const;
const mod = await pub.readContract({ address: recurring, abi, functionName: "MODULE" });
await pub.readContract({ address: recurring, abi, functionName: "CHARGE_TYPEHASH" }); // only version 2 has it
if (mod.toLowerCase() !== dep.module.toLowerCase()) throw new Error(`recurring.MODULE is ${mod}, expected ${dep.module}; deployment.json not changed`);
console.log(`  ok   recurring.MODULE = ${mod}`);
console.log("  ok   CHARGE_TYPEHASH present (version 2)");

const backup = DEP.replace(/\.json$/, ".recurring-v1.json");
if (!existsSync(backup)) copyFileSync(DEP, backup);
writeFileSync(DEP, JSON.stringify({ ...dep, recurring }, null, 2), { mode: 0o600 });
console.log(`\nDONE. ${DEP} now points at the new recurring contract (old file kept as ${backup}).`);
