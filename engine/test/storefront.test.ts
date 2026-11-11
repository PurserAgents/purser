import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createExactPayload, createPurserPayload, decodeHeader, encodeHeader, type PaymentRequired } from "../../packages/sdk/src/x402.ts";
import { listReceipts } from "../src/receipts.ts";
import { createAccount, fundUsdg, makeWorld, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("agent storefront and pay button (8.1, 8.2, local)", () => {
  let w: World;
  let e: Api;
  let seller: `0x${string}`;
  let buyerSafe: `0x${string}`;
  let sellerKey: string;
  const buyer = privateKeyToAccount(generatePrivateKey());

  before(async () => {
    w = await makeWorld();
    e = api(w);
    const owner = (await e.post("/v1/testmode/session")).body.token;
    seller = await createAccount(w, { name: "Report seller", fund: 0n });
    buyerSafe = await createAccount(w, { name: "Buyer agent" });
    sellerKey = (await e.post(`/v1/accounts/${seller}/keys`, { scopes: ["sell", "read"], managed: false }, owner)).body.secret;
    await fundUsdg(w, buyer.address, usdg(100));
  });
  after(async () => w?.stop());

  const pay = async (path: string) => {
    const first = await e.app.request(path);
    assert.equal(first.status, 402);
    const pr = decodeHeader<PaymentRequired>(first.headers.get("PAYMENT-REQUIRED"))!;
    return { pr, header: encodeHeader(await createExactPayload(buyer, pr.accepts[0])) };
  };

  it("sells per call: 402, pay, deliver, meter; income shows as storefront revenue", async () => {
    const svc = await e.post("/v1/storefront/services", { name: "Daily brief", description: "A one-page market brief", model: "per_call", price: usdg(0.5).toString(), response: JSON.stringify({ brief: "Markets were calm." }) }, sellerKey);
    assert.equal(svc.status, 201, JSON.stringify(svc.body));
    const path = `/v1/store/${svc.body.id}`;
    const { header } = await pay(path);
    const ok = await e.app.request(path, { headers: { "PAYMENT-SIGNATURE": header } });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.deepEqual(await ok.json(), { brief: "Markets were calm." });
    assert.equal(await usdgBalance(w, seller), usdg(0.5));
    const usage = await e.get(`/v1/storefront/services/${svc.body.id}/usage`);
    assert.equal(usage.body.items.length, 1);
    assert.equal(usage.body.service.uses, 1);
    assert.equal(usage.body.service.revenue.amount, usdg(0.5).toString());
    const income = listReceipts(w.ctx, { safe: seller, direction: "in" });
    assert.equal(income.items[0].category, "storefront");
    assert.equal(income.items[0].service, svc.body.id);
  });

  it("sells per minute: pays for a block of minutes and gets an access window", async () => {
    const svc = await e.post("/v1/storefront/services", { name: "Live feed", model: "per_minute", price: usdg(0.1).toString(), response: "{\"tick\":1}" }, sellerKey);
    const path = `/v1/store/${svc.body.id}?minutes=5`;
    const first = await e.app.request(path);
    const pr = decodeHeader<PaymentRequired>(first.headers.get("PAYMENT-REQUIRED"))!;
    assert.equal(pr.accepts[0].amount, usdg(0.5).toString());
    const ok = await e.app.request(path, { headers: { "PAYMENT-SIGNATURE": encodeHeader(await createExactPayload(buyer, pr.accepts[0])) } });
    assert.equal(ok.status, 200);
    const access = ok.headers.get("x-purser-access")!;
    assert.ok(access);
    const again = await e.app.request(`/v1/store/${svc.body.id}`, { headers: { "x-purser-access": access } });
    assert.equal(again.status, 200, "within the window no new payment is needed");
    const usage = await e.get(`/v1/storefront/services/${svc.body.id}/usage`);
    assert.equal(usage.body.items[0].units, 5);
  });

  it("sells a subscription period", async () => {
    const svc = await e.post("/v1/storefront/services", { name: "Research desk", model: "subscription", price: usdg(3).toString(), periodSeconds: 30 * 86400 }, sellerKey);
    assert.equal(svc.body.pricing.periodSeconds, 30 * 86400);
    const { header } = await pay(`/v1/store/${svc.body.id}`);
    const ok = await e.app.request(`/v1/store/${svc.body.id}`, { headers: { "PAYMENT-SIGNATURE": header } });
    assert.equal(ok.status, 200);
    assert.ok(Number(ok.headers.get("x-purser-access-until")) > Date.now() / 1000 + 29 * 86400);
  });

  it("another Purser agent buys with its own account; both sides get receipts", async () => {
    const svc = await e.post("/v1/storefront/services", { name: "Translation", model: "per_call", price: usdg(1).toString() }, sellerKey);
    const first = await e.app.request(`/v1/store/${svc.body.id}`);
    const pr = decodeHeader<PaymentRequired>(first.headers.get("PAYMENT-REQUIRED"))!;
    const payload = await createPurserPayload(w.agent, { safe: buyerSafe, module: w.dep.module, chainId: 4663 }, pr.accepts[0], { resource: pr.resource });
    const ok = await e.app.request(`/v1/store/${svc.body.id}`, { headers: { "PAYMENT-SIGNATURE": encodeHeader(payload) } });
    assert.equal(ok.status, 200, await ok.clone().text());
    const sellerIn = listReceipts(w.ctx, { safe: seller, direction: "in" }).items.find((r) => r.service === svc.body.id);
    assert.ok(sellerIn, "seller sees the income");
    assert.equal(sellerIn!.customer, buyerSafe.toLowerCase());
    const buyerOut = listReceipts(w.ctx, { safe: buyerSafe, direction: "out" }).items[0];
    assert.equal(buyerOut.money.amount, usdg(1).toString());
  });

  it("does not charge when the agent's work fails", async () => {
    const svc = await e.post("/v1/storefront/services", { name: "Broken", model: "per_call", price: usdg(1).toString(), upstream: "http://127.0.0.1:9/nothing" }, sellerKey).catch((x) => x);
    const before = await usdgBalance(w, buyer.address);
    const { header } = await pay(`/v1/store/${svc.body.id}`);
    const r = await e.app.request(`/v1/store/${svc.body.id}`, { headers: { "PAYMENT-SIGNATURE": header } });
    assert.equal(r.status, 502);
    assert.equal(await usdgBalance(w, buyer.address), before);
  });

  it("serves the pay button script and settles a button payment into the Safe", async () => {
    const js = await e.app.request("/embed.js");
    assert.equal(js.status, 200);
    const text = await js.text();
    assert.match(text, /metamask\.app\.link\/dapp/);
    assert.match(text, /eth_signTypedData_v4/);
    assert.equal(/[—↗]/.test(text), false, "no em dash or arrow symbols");
    assert.match(text, /http:\/\/engine\.test/);
    const info = await e.get(`/v1/paylink/${seller}`);
    assert.equal(info.body.usdg.name, "Global Dollar");
    const before = await usdgBalance(w, seller);
    const req = { scheme: "exact" as const, network: "eip155:4663", amount: usdg(2).toString(), asset: w.dep.usdg, payTo: seller, maxTimeoutSeconds: 600, extra: { name: "Global Dollar", version: "1" } };
    const r = await e.post(`/v1/paylink/${seller}/settle`, { payload: await createExactPayload(buyer, req), amount: usdg(2).toString() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await usdgBalance(w, seller), before + usdg(2));
    // ETH through the module: the button sends info.ethTx with value
    const tip = privateKeyToAccount(generatePrivateKey());
    await w.rpc("anvil_setBalance", [tip.address, "0xDE0B6B3A7640000"]);
    const ethBefore = await w.ctx.chain.pub.getBalance({ address: seller });
    const hash = await w.ctx.chain.wallet(tip).sendTransaction({ account: tip, chain: w.ctx.chain.chain, to: info.body.ethTx.to, data: info.body.ethTx.data, value: 10n ** 16n });
    await w.ctx.chain.pub.waitForTransactionReceipt({ hash });
    assert.equal(await w.ctx.chain.pub.getBalance({ address: seller }), ethBefore + 10n ** 16n);
  });
});
