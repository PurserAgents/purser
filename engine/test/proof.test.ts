import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { encodeAbiParameters, encodeDeployData, keccak256, pad, type Address, type Hex, type Log } from "viem";
import { erc20Abi } from "../../packages/sdk/src/abi.ts";
import { chainAddresses } from "../../packages/sdk/src/chain.ts";
import { artifact } from "../src/deploy.ts";
import { checkSafe, dropNonSafeAccounts, forgetSafe, isPurserSafe, paymentProven, SAFE_L2_SINGLETON, SAFE_PROXY_CODEHASH, TRANSFER_TOPIC, txProof } from "../src/proof.ts";
import { createApiKey } from "../src/keys.ts";
import { upsertAccount } from "../src/accounts.ts";
import { insertReceipt } from "../src/receipts.ts";
import { ZERO } from "../src/util.ts";
import { createAccount, makeWorld, randomAddress, usdg, type World } from "./harness.ts";

const transferLog = (token: Address, from: Address, to: Address, value: bigint, logIndex = 0): Log =>
  ({
    address: token,
    topics: [TRANSFER_TOPIC, pad(from, { size: 32 }), pad(to, { size: 32 })],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    logIndex,
    blockNumber: 1n,
    transactionHash: `0x${"1".repeat(64)}`,
  }) as unknown as Log;

describe("the Safe check", () => {
  let w: World;
  let safe: Address;
  let proxyCode: Hex;
  before(async () => {
    w = await makeWorld();
    safe = await createAccount(w);
    proxyCode = (await w.ctx.chain.pub.getCode({ address: safe }))!;
  });
  after(() => w?.stop());

  it("a Safe made by PurserFactory is the Safe 1.4.1 proxy on the Safe 1.4.1 singleton, module enabled", async () => {
    assert.equal(keccak256(proxyCode), SAFE_PROXY_CODEHASH);
    const slot0 = await w.ctx.chain.pub.getStorageAt({ address: safe, slot: "0x0" });
    assert.equal(`0x${slot0!.slice(-40)}`, chainAddresses.safeSingleton.toLowerCase());
    assert.deepEqual(await checkSafe(w.ctx, safe), { ok: true, reason: null });
    assert.equal(await isPurserSafe(w.ctx, safe), true);
  });

  it("refuses a wallet, a contract that only answers like a Safe, and proxies on another singleton", async () => {
    assert.deepEqual(await checkSafe(w.ctx, w.owner.address), { ok: false, reason: "no_code" });
    const a = artifact("PocHelpers.sol", "FakeSafe");
    const hash = await w.ctx.chain.wallet(w.ctx.chain.accounts.relayer!).sendTransaction({ account: w.ctx.chain.accounts.relayer!, chain: w.ctx.chain.chain, data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode }) });
    const fake = (await w.ctx.chain.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 })).contractAddress!;
    assert.deepEqual(await checkSafe(w.ctx, fake), { ok: false, reason: "not_safe_proxy" });

    const other = randomAddress();
    await w.rpc("anvil_setCode", [other, proxyCode]);
    await w.rpc("anvil_setStorageAt", [other, "0x0", pad(fake, { size: 32 })]);
    assert.deepEqual(await checkSafe(w.ctx, other), { ok: false, reason: "unknown_singleton" });
  });

  it("a real proxy without the module is a Safe but not a Purser account; SafeL2 1.4.1 counts as a singleton", async () => {
    const bare = randomAddress();
    await w.rpc("anvil_setCode", [bare, proxyCode]);
    await w.rpc("anvil_setStorageAt", [bare, "0x0", pad(chainAddresses.safeSingleton, { size: 32 })]);
    assert.deepEqual(await checkSafe(w.ctx, bare), { ok: false, reason: "module_not_enabled" });
    assert.deepEqual(await checkSafe(w.ctx, bare, { module: false }), { ok: true, reason: null });

    const l2 = randomAddress();
    await w.rpc("anvil_setCode", [l2, proxyCode]);
    await w.rpc("anvil_setStorageAt", [l2, "0x0", pad(SAFE_L2_SINGLETON, { size: 32 })]);
    // the L2 singleton is not deployed on this local chain, so only the code and singleton part can pass
    assert.deepEqual(await checkSafe(w.ctx, l2, { module: false }), { ok: true, reason: null });
  });

  it("caches a yes and a definite no, never 'no code yet'", async () => {
    const later = randomAddress();
    assert.equal((await checkSafe(w.ctx, later, { module: false })).reason, "no_code");
    await w.rpc("anvil_setCode", [later, "0x6000"]);
    assert.equal((await checkSafe(w.ctx, later, { module: false })).reason, "not_safe_proxy", "not remembered as empty");
    await w.rpc("anvil_setCode", [later, proxyCode]);
    await w.rpc("anvil_setStorageAt", [later, "0x0", pad(chainAddresses.safeSingleton, { size: 32 })]);
    assert.equal((await checkSafe(w.ctx, later, { module: false })).reason, "not_safe_proxy", "a definite no is remembered");
    assert.equal((await checkSafe(w.ctx, later, { module: false, fresh: true })).ok, true);
    forgetSafe(w.ctx, later);
    assert.equal((await checkSafe(w.ctx, later, { module: false })).ok, true);
  });

  it("a node error is thrown, never read as a no", async () => {
    const real = w.ctx.chain.pub.getCode;
    w.ctx.chain.pub.getCode = (async () => {
      throw new Error("node down");
    }) as never;
    try {
      await assert.rejects(checkSafe(w.ctx, randomAddress()), /node down/);
    } finally {
      w.ctx.chain.pub.getCode = real;
    }
  });

  it("stored rows for addresses that are not Safes are removed with their keys and the income they 'paid'", async () => {
    const a = artifact("PocHelpers.sol", "FakeSafe");
    const hash = await w.ctx.chain.wallet(w.ctx.chain.accounts.relayer!).sendTransaction({ account: w.ctx.chain.accounts.relayer!, chain: w.ctx.chain.chain, data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode }) });
    const fake = (await w.ctx.chain.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 })).contractAddress!.toLowerCase();
    const pending = randomAddress().toLowerCase(); // a Safe about to be created: no code yet, the row stays
    upsertAccount(w.ctx, { safe: fake, name: "old fake" });
    upsertAccount(w.ctx, { safe: pending, name: "about to be created" });
    const k = createApiKey(w.ctx, { safe: fake });
    insertReceipt(w.ctx, { uniq: "0xabc:1:in", safe, direction: "in", category: "transfer", token: w.dep.usdg, amount: usdg(25), counterparty: fake, txHash: "0xabc", createdAt: 1 });
    const dropped = await dropNonSafeAccounts(w.ctx);
    assert.deepEqual(dropped, [fake]);
    assert.equal(w.ctx.db.prepare("SELECT 1 FROM accounts WHERE safe = ?").get(fake), undefined);
    assert.ok(w.ctx.db.prepare("SELECT 1 FROM accounts WHERE safe = ?").get(pending));
    assert.ok(w.ctx.db.prepare("SELECT 1 FROM accounts WHERE safe = ?").get(safe.toLowerCase()), "the real Safe stays");
    assert.ok((w.ctx.db.prepare("SELECT revoked_at FROM api_keys WHERE id = ?").get(k.key.id) as { revoked_at: number | null }).revoked_at);
    assert.equal(w.ctx.db.prepare("SELECT 1 FROM receipts WHERE uniq = ?").get("0xabc:1:in"), undefined);
  });
});

describe("the payment proof", () => {
  let w: World;
  const token = randomAddress();
  const payer = randomAddress();
  const payee = randomAddress();
  before(async () => {
    w = await makeWorld();
  });
  after(() => w?.stop());

  it("needs the token's own Transfer from the payer to the payee for exactly the amount", async () => {
    const r = (logs: Log[]) => ({ logs, blockNumber: 1n });
    const claim = { payer, token, to: payee, amount: 25n };
    assert.equal(await paymentProven(w.ctx, r([transferLog(token, payer, payee, 25n)]), claim), true);
    assert.equal(await paymentProven(w.ctx, r([]), claim), false, "Paid alone proves nothing");
    assert.equal(await paymentProven(w.ctx, r([transferLog(randomAddress(), payer, payee, 25n)]), claim), false, "another contract's Transfer");
    assert.equal(await paymentProven(w.ctx, r([transferLog(token, payer, payee, 24n)]), claim), false, "a different amount");
    assert.equal(await paymentProven(w.ctx, r([transferLog(token, payer, randomAddress(), 25n)]), claim), false, "another payee");
    assert.equal(await paymentProven(w.ctx, r([transferLog(token, randomAddress(), payee, 25n)]), claim), false, "another payer");
    assert.equal(await paymentProven(w.ctx, r([transferLog(token, payer, payee, 25n)]), { ...claim, amount: 0n }), false);
  });

  it("one Transfer proves one payment", async () => {
    const p = txProof(w.ctx, { logs: [transferLog(token, payer, payee, 5n, 0), transferLog(token, payer, payee, 5n, 1)], blockNumber: 1n });
    const claim = { payer, token, to: payee, amount: 5n };
    assert.equal(await p.proves(claim), true);
    assert.equal(await p.proves(claim), true);
    assert.equal(await p.proves(claim), false, "a third claim has no Transfer left");
  });

  it("ETH: the payee's balance must have grown by the amount in that block", async () => {
    const to = randomAddress();
    const rcpt = await w.ctx.chain.send(w.ctx.chain.accounts.relayer!, { to, value: 1000n });
    assert.equal(await paymentProven(w.ctx, rcpt, { payer: w.ctx.chain.accounts.relayer!.address, token: ZERO, to, amount: 1000n }), true);
    assert.equal(await paymentProven(w.ctx, rcpt, { payer: w.ctx.chain.accounts.relayer!.address, token: ZERO, to, amount: 1001n }), false);
    const p = txProof(w.ctx, rcpt);
    assert.equal(await p.proves({ payer: randomAddress(), token: ZERO, to, amount: 600n }), true);
    assert.equal(await p.proves({ payer: randomAddress(), token: ZERO, to, amount: 600n }), false, "two claims cannot share one balance change");
    assert.equal(await paymentProven(w.ctx, rcpt, { payer: randomAddress(), token: ZERO, to: randomAddress(), amount: 1n }), false);
  });

  it("a real payment from a real Safe is proven, through the relay and the indexer", async () => {
    const safe = await createAccount(w);
    const to = randomAddress();
    const { submitIntent } = await import("../src/intents.ts");
    const { privateKeyToAccount } = await import("viem/accounts");
    const res = await submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to, amount: usdg(3) } }, category: "transfer", signer: privateKeyToAccount(w.keys.agent!) });
    assert.equal(res.intent.status, "executed", res.intent.error ?? "");
    assert.ok(res.receipt);
    const bal = await w.ctx.chain.pub.readContract({ address: w.dep.usdg, abi: erc20Abi, functionName: "balanceOf", args: [to] });
    assert.equal(bal, usdg(3));
    const eth = await submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: ZERO, to, amount: 10n ** 15n } }, category: "transfer", signer: privateKeyToAccount(w.keys.agent!) });
    assert.equal(eth.intent.status, "executed", eth.intent.error ?? "");
    assert.ok(eth.receipt);
  });
});
