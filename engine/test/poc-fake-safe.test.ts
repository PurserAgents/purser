// Regression for GHSA-ch98-775j-jhhv (reported by HEY Research Lab). Local chain only (anvil), stub model provider.
//
// The module accepts any contract that answers isModuleEnabled as an account, and believes the account when it says a
// transfer worked. The engine must not: an address is an account only when it is a real Safe, and a payment counts
// only when the money is seen moving. This file runs the reporter's proof and checks that every step of it fails:
//   (a) models at cost: no API key, no model call answered, no settlement booked, even with a key made by hand;
//   (b) storefront: the facilitator refuses the payer, the seller does not deliver, no income lands in its books;
//   (c) a real Safe whose singleton is swapped for one that moves nothing: Paid is emitted, the engine books nothing.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { createWalletClient, encodeDeployData, encodeFunctionData, http, pad, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { purserModuleAbi } from "../../packages/sdk/src/abi.ts";
import { payTypedData, randomNonce } from "../../packages/sdk/src/eip712.ts";
import { encodeHeader, HEADER_SIGNATURE } from "../../packages/sdk/src/x402.ts";
import { configToChain, readChainAccount, ruleToChain } from "../src/accounts.ts";
import { artifact } from "../src/deploy.ts";
import { indexOnce } from "../src/indexer.ts";
import { createApiKey } from "../src/keys.ts";
import { checkSafe } from "../src/proof.ts";
import { listReceipts } from "../src/receipts.ts";
import { verifyPayment } from "../src/x402.ts";
import { createAccount, makeWorld, randomAddress, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

const ZERO32 = `0x${"0".repeat(64)}` as Hex;

function standIn() {
  const seen: unknown[] = [];
  const app = new Hono();
  app.post("/v1/messages", async (c) => {
    const b = await c.req.json();
    seen.push(b);
    return c.json({ id: `msg_${seen.length}`, type: "message", role: "assistant", model: b.model, content: [{ type: "text", text: `Answer ${seen.length}` }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 20_000, output_tokens: 8_000 } });
  });
  return { app, seen };
}

describe("GHSA-ch98-775j-jhhv: a contract that is not a Safe is not a Purser account", () => {
  let w: World;
  let e: Api;
  let server: ServerType;
  const provider = standIn();
  const company = randomAddress();
  const attacker = privateKeyToAccount(generatePrivateKey());
  let fake: Address;
  const saved = { url: process.env.PURSER_MODELS_URL, key: process.env.PURSER_MODELS_KEY, payTo: process.env.PURSER_MODELS_PAYTO, settle: process.env.PURSER_MODELS_SETTLE_MICRO };

  const send = async (to: Address | null, data: Hex) => {
    const wallet = createWalletClient({ account: attacker, chain: w.ctx.chain.chain, transport: http(w.anvil.url) });
    const hash = await wallet.sendTransaction({ account: attacker, chain: w.ctx.chain.chain, to: to ?? undefined, data });
    return w.ctx.chain.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  };
  const fakeAbi = () => artifact("PocHelpers.sol", "FakeSafe").abi;
  const runAs = (who: Address, data: Hex) => send(who, encodeFunctionData({ abi: fakeAbi(), functionName: "run", args: [w.dep.module, data] }));
  const config = (agent: Address) =>
    configToChain({ agent, cosigner: null, firewall: w.ctx.chain.accounts.firewall!.address, watchdog: null, maxPerMinute: null, hoursUtc: [], weekdays: [], payeeAllowlist: false, serviceAllowlist: false });
  const deployFake = async () => {
    const a = artifact("PocHelpers.sol", "FakeSafe");
    const addr = (await send(null, encodeDeployData({ abi: a.abi, bytecode: a.bytecode }))).contractAddress!;
    await runAs(addr, encodeFunctionData({ abi: purserModuleAbi, functionName: "initialize", args: [config(attacker.address), [{ token: w.dep.usdg, rule: ruleToChain({}) }], [], []] }));
    return addr;
  };

  before(async () => {
    w = await makeWorld();
    e = api(w);
    server = serve({ fetch: provider.app.fetch, port: 0 });
    await new Promise((r) => server.once("listening", r));
    process.env.PURSER_MODELS_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.PURSER_MODELS_KEY = "sk-ant-test";
    process.env.PURSER_MODELS_PAYTO = company;
    delete process.env.PURSER_MODELS_SETTLE_MICRO;
    await w.rpc("anvil_setBalance", [attacker.address, "0xDE0B6B3A7640000"]);
    fake = await deployFake();
    await indexOnce(w.ctx);
  });
  after(async () => {
    server?.close();
    for (const [k, v] of [["PURSER_MODELS_URL", saved.url], ["PURSER_MODELS_KEY", saved.key], ["PURSER_MODELS_PAYTO", saved.payTo], ["PURSER_MODELS_SETTLE_MICRO", saved.settle]] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await w?.stop();
  });

  it("the module calls the fake initialized, the engine does not", async () => {
    const onChain = await w.ctx.chain.pub.readContract({ address: w.dep.module, abi: purserModuleAbi, functionName: "getAccount", args: [fake] });
    assert.equal(onChain.initialized, true, "the live module still accepts it (fixed in the engine, not the contract)");
    assert.equal((await readChainAccount(w.ctx, fake)).initialized, false);
    assert.deepEqual(await checkSafe(w.ctx, fake), { ok: false, reason: "not_safe_proxy" });
    assert.equal(w.ctx.db.prepare("SELECT 1 FROM accounts WHERE safe = ?").get(fake.toLowerCase()), undefined, "no account row from AccountInitialized");
    assert.equal((await e.get(`/v1/accounts/${fake}`)).status, 404);
  });

  it("(a) models at cost: no key for the fake account, and a key made by hand gets no model call and no settlement", async () => {
    const n = await e.post("/v1/auth/nonce", { address: attacker.address });
    const session = await e.post("/v1/auth/verify", { address: attacker.address, nonce: n.body.nonce, issued: n.body.issued, signature: await attacker.signMessage({ message: n.body.message }) });
    assert.equal(session.status, 200, "signing in as a wallet is fine");
    const k = await e.post(`/v1/accounts/${fake}/keys`, { name: "free models", managed: true }, session.body.token);
    assert.equal(k.status, 404, JSON.stringify(k.body));
    assert.equal(k.body.error.code, "not_account");
    assert.equal((await e.get(`/v1/accounts/${fake}/keys`, session.body.token)).status, 404);

    // a key that exists anyway (stored before the fix): the payment pipeline still refuses the account
    const hand = createApiKey(w.ctx, { safe: fake, name: "stored before the fix", managed: true });
    await runAs(fake, encodeFunctionData({ abi: purserModuleAbi, functionName: "setConfig", args: [config(hand.key.sessionAddress!)] }));
    await indexOnce(w.ctx);
    for (let i = 0; i < 5; i++) {
      const res = await e.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${hand.secret}` },
        body: JSON.stringify({ model: "purser/claude-opus-5-5", messages: [{ role: "user", content: "Write a long report." }], max_tokens: 8000 }),
      });
      assert.equal(res.status, 402, await res.text());
    }
    assert.equal(provider.seen.length, 0, "the provider answered nothing");
    const pay = await e.post("/v1/pay", { to: company, amount: usdg(1).toString() }, hand.secret);
    assert.equal(pay.status, 422);
    assert.ok(pay.body.verdict.reasons.some((r: { code: string }) => r.code === "not_account"));
    const receipts = listReceipts(w.ctx, { safe: fake }).items;
    assert.equal(receipts.length, 0, "nothing booked for the fake account");
    assert.equal(await usdgBalance(w, company), 0n);
  });

  it("(b) storefront: the facilitator refuses the fake payer, nothing is delivered, the seller's books stay true", async () => {
    const seller = await createAccount(w, { name: "Honest seller", fund: usdg(100) });
    const sellerKey = createApiKey(w.ctx, { safe: seller, scopes: ["sell", "read"] }).secret;
    const svc = await e.post("/v1/storefront/services", { name: "Market report", price: usdg(25).toString(), response: JSON.stringify({ report: "the paid answer" }) }, sellerKey);
    assert.equal(svc.status, 201, JSON.stringify(svc.body));

    const fake2 = await deployFake();
    await indexOnce(w.ctx);
    const block = await w.ctx.chain.pub.getBlock();
    const intent = { safe: fake2, token: w.dep.usdg, to: seller, amount: usdg(25), service: ZERO32, nonce: randomNonce(), deadline: block.timestamp + 600n };
    const signature = await attacker.signTypedData(payTypedData(w.ctx.cfg.chainId, w.dep.module, intent));
    const payload = {
      x402Version: 2,
      payload: { purser: { kind: "pay", safe: fake2, token: w.dep.usdg, to: seller, amount: intent.amount.toString(), service: ZERO32, nonce: intent.nonce.toString(), deadline: intent.deadline.toString(), signature } },
    };
    const v = await verifyPayment(w.ctx, payload as never, { scheme: "exact", network: `eip155:${w.ctx.cfg.chainId}`, amount: intent.amount.toString(), asset: w.dep.usdg, payTo: seller, maxTimeoutSeconds: 60 });
    assert.equal(v.isValid, false);
    assert.equal(v.invalidReason, "payer_not_a_purser_account");

    const before = await usdgBalance(w, seller);
    const res = await e.app.request(`/v1/store/${svc.body.id}`, { headers: { [HEADER_SIGNATURE]: encodeHeader(payload as never) } });
    const text = await res.text();
    assert.equal(res.status, 402, text);
    assert.doesNotMatch(text, /the paid answer/);
    assert.equal(await usdgBalance(w, seller), before);
    const income = listReceipts(w.ctx, { safe: seller, direction: "in" }).items;
    assert.equal(income.length, 0, "no income in the seller's books");
  });

  it("(c) a real Safe whose singleton is swapped for one that moves nothing: Paid on chain, nothing in the books", async () => {
    const safe = await createAccount(w, { name: "Swapped", fund: usdg(100) });
    // the engine already knows this Safe as real (cached); its owners then point it at a contract that moves nothing
    assert.equal((await checkSafe(w.ctx, safe)).ok, true);
    const a = artifact("PocHelpers.sol", "FakeSafe");
    const impl = (await send(null, encodeDeployData({ abi: a.abi, bytecode: a.bytecode }))).contractAddress!;
    await w.rpc("anvil_setStorageAt", [safe, "0x0", pad(impl, { size: 32 })]);

    const payee = randomAddress();
    const block = await w.ctx.chain.pub.getBlock();
    for (const [token, amount] of [[w.dep.usdg, usdg(5)], ["0x0000000000000000000000000000000000000000", 10n ** 15n]] as const) {
      const intent = { safe, token, to: payee, amount, service: ZERO32, nonce: randomNonce(), deadline: block.timestamp + 600n };
      const signature = await w.agent.signTypedData(payTypedData(w.ctx.cfg.chainId, w.dep.module, intent));
      const r = await e.post("/v1/intents", { kind: "pay", safe, pay: { token, to: payee, amount: amount.toString() }, nonce: intent.nonce.toString(), deadline: intent.deadline.toString(), signature });
      assert.equal(r.body.intent.status, "failed", JSON.stringify(r.body));
      assert.match(r.body.intent.error, /no money reached the payee/);
      assert.ok(r.body.intent.txHash, "the transaction was mined and emitted Paid");
      const logs = (await w.ctx.chain.pub.getTransactionReceipt({ hash: r.body.intent.txHash })).logs;
      assert.ok(logs.some((l) => l.address.toLowerCase() === w.dep.module.toLowerCase()), "the module emitted its events");
    }
    assert.equal(await usdgBalance(w, payee), 0n);
    assert.equal(await w.ctx.chain.pub.getBalance({ address: payee }), 0n);
    await indexOnce(w.ctx);
    const outs = listReceipts(w.ctx, { safe }).items.filter((x) => x.direction === "out" && x.counterparty.toLowerCase() === payee.toLowerCase());
    assert.equal(outs.length, 0, "no executed receipt for a payment that moved nothing");
  });
});
