import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Address, Log } from "viem";
import type { EngineEvent } from "../../packages/sdk/src/schema.ts";
import { prepareModuleCall, prepareSafeTx, ruleChangeCalls, sendAsTestOwner, execAsTestOwner } from "../src/accounts.ts";
import { loadConfig, type Deployment } from "../src/config.ts";
import { kvGet, kvSet } from "../src/db.ts";
import { createEngine, type Engine } from "../src/engine.ts";
import { indexOnce, ingestLogs, ingestReceipt } from "../src/indexer.ts";
import { submitIntent } from "../src/intents.ts";
import { ApiFailure } from "../src/util.ts";
import { createAccount, makeOfflineEngine, makeWorld, randomAddress, usdg, type World } from "./harness.ts";

describe("indexer: from the deployment block, each log once (local anvil)", () => {
  let w: World;
  let payer: Address;
  let payee: Address;
  const extra: Engine[] = [];
  /** A second engine reading the same node with an empty database, as after a fresh start. */
  const fresh = (dep: Deployment = w.dep) => {
    const e = createEngine(loadConfig({ PURSER_DEPLOYMENT: "/nonexistent", PURSER_KEYS: "/nonexistent" }, { rpcUrls: [w.anvil.url], dbPath: ":memory:", deployment: dep, keys: w.keys, testMode: true }));
    extra.push(e);
    return e.ctx;
  };
  const count = (ctx: World["ctx"], sql: string, ...args: unknown[]) => (ctx.db.prepare(sql).get(...args) as { n: number }).n;

  before(async () => {
    w = await makeWorld();
    payer = await createAccount(w, { name: "Payer" });
    payee = await createAccount(w, { name: "Payee" });
    for (const to of [randomAddress(), payee]) {
      const r = await submitIntent(w.ctx, { safe: payer, spec: { kind: "pay", pay: { token: w.dep.usdg, to, amount: usdg(3) } }, category: "transfer", signer: w.agent });
      assert.equal(r.intent.status, "executed", r.intent.error ?? "");
    }
  });
  after(async () => {
    for (const e of extra) e.ctx.db.close();
    await w?.stop();
  });

  it("a fresh engine rebuilds accounts and receipts from the deployment block, then waits at the head", async () => {
    assert.equal(typeof w.dep.startBlock, "number", "deployLocal records the block before the first Purser contract");
    const ctx = fresh();
    const n = await indexOnce(ctx);
    assert.ok(n > 0);
    const head = await w.ctx.chain.pub.getBlockNumber({ cacheTime: 0 });
    assert.equal(kvGet(ctx.db, "index_cursor"), head.toString());
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM accounts WHERE safe IN (?, ?)", payer.toLowerCase(), payee.toLowerCase()), 2);
    const out = count(ctx, "SELECT COUNT(*) AS n FROM receipts WHERE safe = ? AND direction = 'out'", payer.toLowerCase());
    assert.equal(out, count(w.ctx, "SELECT COUNT(*) AS n FROM receipts WHERE safe = ? AND direction = 'out'", payer.toLowerCase()));
    assert.equal(out, 2);
    const incoming = ctx.db.prepare("SELECT * FROM receipts WHERE safe = ? AND direction = 'in'").all(payee.toLowerCase()) as { counterparty: string; amount: string }[];
    assert.equal(incoming.length, 1, "account to account: the payee gets its side too");
    assert.equal(incoming[0].counterparty, payer.toLowerCase());
    assert.equal(incoming[0].amount, usdg(3).toString());
    assert.equal(await indexOnce(ctx), 0, "nothing new");
    await w.rpc("anvil_mine", ["0x3"]);
    // the client caches the block number for a few seconds; the cursor follows once the new head is seen
    for (let i = 0; i < 20 && kvGet(ctx.db, "index_cursor") !== (head + 3n).toString(); i++) {
      assert.equal(await indexOnce(ctx), 0, "empty blocks move the cursor without logs");
      assert.ok(BigInt(kvGet(ctx.db, "index_cursor")!) >= head, "the cursor never moves back");
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(kvGet(ctx.db, "index_cursor"), (head + 3n).toString());
  });

  it("logs the engine already took from its own transaction are not counted again by the poller", async () => {
    const before = count(w.ctx, "SELECT COUNT(*) AS n FROM receipts");
    await indexOnce(w.ctx);
    const r = await submitIntent(w.ctx, { safe: payer, spec: { kind: "pay", pay: { token: w.dep.usdg, to: randomAddress(), amount: usdg(1) } }, category: "transfer", signer: w.agent });
    assert.equal(r.intent.status, "executed");
    const afterSend = count(w.ctx, "SELECT COUNT(*) AS n FROM receipts");
    assert.equal(afterSend, before + 1);
    // the client caches the head for a few seconds: poll until the cursor has passed the payment's block
    const block = (await w.ctx.chain.pub.getTransactionReceipt({ hash: r.intent.txHash! })).blockNumber;
    let seen = 0;
    for (let i = 0; i < 40 && BigInt(kvGet(w.ctx.db, "index_cursor") ?? "0") < block; i++) {
      seen += await indexOnce(w.ctx);
      await new Promise((res) => setTimeout(res, 200));
    }
    assert.ok(seen > 0, "the poller sees the logs");
    assert.equal(count(w.ctx, "SELECT COUNT(*) AS n FROM receipts"), afterSend, "but writes nothing twice");
    const tx = await w.ctx.chain.pub.getTransactionReceipt({ hash: r.intent.txHash! });
    await ingestReceipt(w.ctx, tx);
    await ingestLogs(w.ctx, tx.logs as Log[]);
    assert.equal(count(w.ctx, "SELECT COUNT(*) AS n FROM receipts"), afterSend);
  });

  it("starts at the head when the deployment names no start block, or where index_start says", async () => {
    const { startBlock: _drop, ...noStart } = w.dep;
    await w.rpc("anvil_mine", ["0x1"]); // the head is now an empty block
    const ctx = fresh(noStart as Deployment);
    assert.equal(await indexOnce(ctx), 0, "only the head block, which has no Purser logs");
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM receipts"), 0);
    const later = fresh();
    kvSet(later.db, "index_start", String((await w.ctx.chain.pub.getBlockNumber({ cacheTime: 0 })) + 1n));
    assert.equal(await indexOnce(later), 0, "a start above the head reads nothing");
    assert.equal(kvGet(later.db, "index_cursor"), null);
  });

  it("turns rule and freeze events into account state, bus events and audit entries", async () => {
    const listed = randomAddress();
    const events: EngineEvent[] = [];
    const off = w.ctx.bus.subscribe((e) => e.type === "account" && events.push(e));
    await ingestReceipt(w.ctx, await execAsTestOwner(w.ctx, await prepareSafeTx(w.ctx, payer, ruleChangeCalls(w.ctx, { allow: [listed] }), "allow")));
    assert.ok(w.ctx.db.prepare("SELECT 1 FROM account_sets WHERE safe = ? AND kind = 'allow' AND value = ? AND on_flag = 1").get(payer.toLowerCase(), listed.toLowerCase()));
    await ingestReceipt(w.ctx, await execAsTestOwner(w.ctx, await prepareSafeTx(w.ctx, payer, ruleChangeCalls(w.ctx, { disallow: [listed] }), "disallow")));
    assert.ok(w.ctx.db.prepare("SELECT 1 FROM account_sets WHERE safe = ? AND kind = 'allow' AND value = ? AND on_flag = 0").get(payer.toLowerCase(), listed.toLowerCase()));
    await ingestReceipt(w.ctx, await sendAsTestOwner(w.ctx, prepareModuleCall(w.ctx, "freeze", [payer], "freeze")));
    await ingestReceipt(w.ctx, await sendAsTestOwner(w.ctx, prepareModuleCall(w.ctx, "unfreeze", [payer], "unfreeze")));
    off();
    const kinds = events.filter((e) => e.safe === payer.toLowerCase()).map((e) => (e.data as { event: string }).event);
    assert.ok(kinds.includes("frozen") && kinds.includes("unfrozen"), kinds.join(","));
    const frozen = events.find((e) => (e.data as { event: string }).event === "frozen")!;
    assert.equal((frozen.data as { by: string }).by, w.owner.address.toLowerCase());
    const actions = w.ctx.audit.list({ safe: payer, limit: 20 }).map((e) => e.action);
    assert.ok(actions.includes("account.frozen") && actions.includes("account.unfrozen"));
  });

  it("ignores logs from other contracts and logs it cannot decode", async () => {
    const before = count(w.ctx, "SELECT COUNT(*) AS n FROM seen_logs");
    const stranger = { address: randomAddress(), data: "0x", topics: ["0x" + "11".repeat(32)], transactionHash: "0x" + "22".repeat(32), logIndex: 0, blockNumber: 1n } as unknown as Log;
    const garbled = { ...stranger, address: w.dep.module } as Log;
    await ingestLogs(w.ctx, [stranger, garbled]);
    assert.equal(count(w.ctx, "SELECT COUNT(*) AS n FROM seen_logs"), before);
  });

  it("without a deployment there is nothing to index (503)", async () => {
    const e = makeOfflineEngine();
    await assert.rejects(indexOnce(e.ctx), (x: unknown) => x instanceof ApiFailure && x.status === 503);
    e.ctx.db.close();
  });
});
