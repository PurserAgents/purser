import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { heartbeatTypedData } from "../../packages/sdk/src/eip712.ts";
import { listReceipts } from "../src/receipts.ts";
import { listVerdicts } from "../src/firewall.ts";
import { chainNow, chargeSubscriptions, settleStreams } from "../src/recurring.ts";
import { createAccount, makeWorld, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("streams and subscriptions (7.1-7.3, local)", () => {
  let w: World;
  let e: Api;
  let safe: `0x${string}`;
  let key: string;
  const payee = privateKeyToAccount(generatePrivateKey());
  const warp = async (s: number) => {
    await w.rpc("evm_increaseTime", [s]);
    await w.rpc("evm_mine", []);
  };

  before(async () => {
    w = await makeWorld();
    e = api(w);
    const owner = (await e.post("/v1/testmode/session")).body.token;
    safe = await createAccount(w, { name: "Streamer" });
    const k = await e.post(`/v1/accounts/${safe}/keys`, { managed: true }, owner);
    key = k.body.secret;
    const acct = (await e.get(`/v1/accounts/${safe}`)).body;
    await e.post("/v1/testmode/safe-tx", (await e.post(`/v1/accounts/${safe}/rules/prepare`, { config: { ...acct.config, agent: k.body.key.sessionAddress } })).body);
  });
  after(async () => w?.stop());

  it("streams pay per second while the payee sends heartbeats, then stall without them", async () => {
    const created = await e.post("/v1/streams", { payee: payee.address, ratePerSecond: "1000", maxDurationSeconds: 86400, graceSeconds: 60 }, key);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.intent.status, "executed");
    const sid = created.body.streamId;
    assert.ok(sid);
    await warp(30);
    const upTo = await chainNow(w.ctx);
    const signature = await payee.signTypedData(heartbeatTypedData(4663, w.dep.recurring, BigInt(sid), BigInt(upTo)));
    const hb = await e.post(`/v1/streams/${sid}/heartbeat`, { upTo, signature });
    assert.equal(hb.status, 200, JSON.stringify(hb.body));
    await warp(30);
    assert.equal(await settleStreams(w.ctx), 1);
    const paid = await usdgBalance(w, payee.address);
    assert.ok(paid >= 60_000n && paid <= 62_000n, `paid ${paid}`);
    const rec = listReceipts(w.ctx, { safe, category: "stream" });
    assert.ok(rec.items.length >= 1, "stream receipt");
    await warp(3600); // the payee stops delivering
    await settleStreams(w.ctx);
    const view = (await e.get(`/v1/streams/${sid}`)).body;
    assert.equal(view.status, "stalled");
    const after = await usdgBalance(w, payee.address);
    assert.ok(after - paid <= 92_000n, "at most the grace after the last heartbeat");
    await warp(3600);
    assert.equal(await settleStreams(w.ctx), 0, "nothing more accrues");
  });

  it("the agent stops a stream", async () => {
    const created = await e.post("/v1/streams", { payee: payee.address, ratePerSecond: "10", maxDurationSeconds: 3600, graceSeconds: 600 }, key);
    const sid = created.body.streamId;
    const stop = await e.post(`/v1/streams/${sid}/stop`, {}, key);
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.equal((await e.get(`/v1/streams/${sid}`)).body.status, "stopped");
  });

  it("a stream above the approval threshold waits for the owner, then runs", async () => {
    // 0.003 USDG/s for a day = 259.2 USDG > 200 approval threshold
    const created = await e.post("/v1/streams", { payee: payee.address, ratePerSecond: "3000", maxDurationSeconds: 86400, graceSeconds: 60 }, key);
    assert.equal(created.body.intent.status, "queued", JSON.stringify(created.body.intent));
    const decided = await e.post(`/v1/testmode/approvals/${created.body.intent.id}`, { decision: "approve" });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.result.intent.status, "executed");
    assert.ok(decided.body.result.streamId);
  });

  it("subscriptions charge the first period at once and then each period", async () => {
    const before = await usdgBalance(w, payee.address);
    const sub = await e.post("/v1/subscriptions", { payee: payee.address, amount: usdg(9).toString(), periodSeconds: 30 * 86400, maxCharges: 12 }, key);
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.intent.status, "executed");
    assert.equal(await usdgBalance(w, payee.address), before + usdg(9));
    assert.equal(await chargeSubscriptions(w.ctx), 0, "not due yet");
    await warp(30 * 86400);
    assert.equal(await chargeSubscriptions(w.ctx), 1);
    assert.equal(await usdgBalance(w, payee.address), before + usdg(18));
    const list = (await e.get(`/v1/accounts/${safe}/subscriptions`)).body.items;
    const s = list.find((x: any) => x.id === sub.body.subscriptionId);
    assert.equal(s.charged, 2);
    assert.equal(s.chargesLeft, 10);
    assert.ok(listReceipts(w.ctx, { safe, category: "subscription" }).items.length >= 2);
    const cancel = await e.post(`/v1/subscriptions/${sub.body.subscriptionId}/cancel`, {}, key);
    assert.equal(cancel.status, 200);
    await warp(30 * 86400);
    assert.equal(await chargeSubscriptions(w.ctx), 0);
  });

  it("a subscription the rules refuse is blocked before it is created", async () => {
    const r = await e.post("/v1/subscriptions", { payee: payee.address, amount: usdg(400).toString(), periodSeconds: 86400, maxCharges: 1 }, key);
    assert.equal(r.status, 422);
    assert.ok(r.body.verdict.reasons.some((x: any) => x.code === "max_single"));
  });

  it("every charge gets a fresh firewall check: a payee that turns bad halfway is never paid again", async () => {
    const bad = privateKeyToAccount(generatePrivateKey());
    const sub = await e.post("/v1/subscriptions", { payee: bad.address, amount: usdg(5).toString(), periodSeconds: 86400, maxCharges: 10 }, key);
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    const paid = await usdgBalance(w, bad.address);
    assert.equal(paid, usdg(5), "the first period at creation");
    // the payee's wallet now hands control to delegated code (EIP-7702), the way drainers set up forwarding wallets
    await w.rpc("anvil_setCode", [bad.address, "0xef0100" + "deadbeef".repeat(5)]);
    await warp(86400);
    assert.equal(await chargeSubscriptions(w.ctx), 0, "the firewall refuses to sign this charge");
    assert.equal(await usdgBalance(w, bad.address), paid);
    const v = listVerdicts(w.ctx, { safe, decision: "block", limit: 1 })[0];
    assert.equal(v.reasons.some((r) => r.code === "delegated_eoa"), true, JSON.stringify(v.reasons));
    // and nobody can charge it around the engine: the contract wants the firewall's signature for this one payout
    const { encodeFunctionData } = await import("viem");
    const { purserRecurringAbi } = await import("../../packages/sdk/src/abi.ts");
    await assert.rejects(
      w.ctx.chain.pub.call({ account: bad.address, to: w.dep.recurring, data: encodeFunctionData({ abi: purserRecurringAbi, functionName: "charge", args: [BigInt(sub.body.subscriptionId)] }) }),
      /FirewallRequired|reverted/,
    );
    // checked again later, still blocked, still unpaid
    await warp(3700);
    assert.equal(await chargeSubscriptions(w.ctx), 0);
    assert.equal(await usdgBalance(w, bad.address), paid);
  });
});
