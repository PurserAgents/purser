import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPublicClient, defineChain, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, purserModuleAbi } from "../../packages/sdk/src/abi.ts";
import { chainAddresses } from "../../packages/sdk/src/chain.ts";
import { artifact, deployLocal, ensureBuilt, newKeys } from "../src/deploy.ts";
import { startAnvil, type Anvil } from "./harness.ts";

describe("deploying Purser to a local node", () => {
  it("never deploys anywhere but a local node", async () => {
    for (const rpcUrl of ["https://rpc.mainnet.chain.robinhood.com", "http://10.0.0.2:8545", "http://localhost.evil.example:8545"])
      await assert.rejects(deployLocal({ rpcUrl, mode: "fork", keys: newKeys(true) }), /only talks to a local node/, rpcUrl);
  });

  it("new keys: four engine keys, plus owner and agent only for test mode, all distinct", () => {
    const k = newKeys(true);
    const all = [k.relayer, k.firewall, k.watchdog, k.audit, k.owner!, k.agent!];
    for (const x of all) assert.match(x, /^0x[0-9a-f]{64}$/);
    assert.equal(new Set(all).size, 6);
    const plain = newKeys(false);
    assert.equal(plain.owner, undefined);
    assert.equal(plain.agent, undefined);
  });

  it("reads compiled contracts", () => {
    ensureBuilt(); // already built: a no-op
    const m = artifact("PurserModule.sol", "PurserModule");
    assert.ok(m.abi.some((x) => x.type === "function" && x.name === "pay"));
    assert.match(m.bytecode, /^0x[0-9a-f]+$/);
    assert.throws(() => artifact("Nope.sol", "Nope"));
  });
});

describe("deployLocal on a plain anvil chain (local)", () => {
  let anvil: Anvil;
  let pub: PublicClient;
  const keys = newKeys(true);
  before(async () => {
    anvil = await startAnvil();
    pub = createPublicClient({ chain: defineChain({ id: 4663, name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } }), transport: http(anvil.url) }) as PublicClient;
  });
  after(async () => anvil?.stop());

  it("places the real Safe bytecode, a test USDG, and every Purser contract, with the chosen fee", async () => {
    const dep = await deployLocal({ rpcUrl: anvil.url, mode: "local", keys, feeBps: 25 });
    assert.equal(dep.chainId, 4663);
    assert.equal(dep.mode, "local");
    assert.equal(dep.feeBps, 25);
    assert.equal(dep.weth, null);
    assert.equal(dep.swapRouter, null);
    assert.equal(dep.ethUsdFeed, null);
    assert.equal(typeof dep.startBlock, "number");
    assert.equal(dep.vaults.length, 1);
    for (const a of [dep.module, dep.factory, dep.recurring, dep.escrow, dep.passkey, dep.usdg, dep.identityRegistry!, dep.vaults[0], chainAddresses.safeSingleton, chainAddresses.safeProxyFactory, chainAddresses.multiSendCallOnly] as Address[]) {
      const code = await pub.getCode({ address: a });
      assert.ok(code && code.length > 2, `code at ${a}`);
    }
    assert.equal(await pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "FEE_BPS" }), 25n);
    assert.equal(await pub.readContract({ address: dep.usdg, abi: erc20Abi, functionName: "symbol" }), "USDG");
    assert.equal(await pub.readContract({ address: dep.usdg, abi: erc20Abi, functionName: "decimals" }), 6);
    const bal = (k: `0x${string}`) => pub.getBalance({ address: privateKeyToAccount(k).address });
    for (const k of [keys.firewall, keys.watchdog, keys.owner!, keys.agent!]) assert.equal(await bal(k), 100n * 10n ** 18n, "funded with 100 test ETH");
    assert.ok((await bal(keys.relayer)) < 100n * 10n ** 18n, "the relayer paid the deploy gas");
    const again = await deployLocal({ rpcUrl: anvil.url, mode: "local", keys });
    assert.equal(again.feeBps, 10, "default fee");
    assert.notEqual(again.module, dep.module);
    assert.ok(again.startBlock! > dep.startBlock!);
  });

  it("a fee above the 1% cap is refused by the module itself", async () => {
    await assert.rejects(deployLocal({ rpcUrl: anvil.url, mode: "local", keys, feeBps: 101 }));
  });
});
