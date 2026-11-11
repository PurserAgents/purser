import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Hono } from "hono";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { purserPaywall } from "../../packages/sdk/src/merchant.ts";
import {
  createExactPayload,
  createPurserPayload,
  decodeHeader,
  encodeHeader,
  type PaymentRequired,
  type SettleResponse,
} from "../../packages/sdk/src/x402.ts";
import { listReceipts } from "../src/receipts.ts";
import { createAccount, fundUsdg, makeWorld, randomAddress, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("x402 facilitator and merchant middleware (5.1-5.3, local)", () => {
  let w: World;
  let engine: Api;
  let seller: `0x${string}`;
  let buyer: `0x${string}`;
  let merchant: Hono;
  const dev = randomAddress();
  const payer = privateKeyToAccount(generatePrivateKey());

  const paywalled = (payTo: `0x${string}`, price: bigint) => {
    const m = new Hono();
    m.use(
      "/report",
      purserPaywall({
        facilitatorUrl: "http://engine.test/x402",
        payTo,
        asset: w.dep.usdg,
        price,
        description: "A market report",
        fetch: (u, init) => engine.app.request(String(u), init as RequestInit) as Promise<Response>,
      }),
    );
    m.get("/report", (c) => c.json({ report: "ok" }));
    return m;
  };

  before(async () => {
    w = await makeWorld();
    engine = api(w);
    seller = await createAccount(w, { name: "Seller" });
    buyer = await createAccount(w, { name: "Buyer" });
    await fundUsdg(w, payer.address, usdg(50));
    // the seller's owner splits 20% of income to a developer
    const prep = await engine.post(`/v1/accounts/${seller}/rules/prepare`, { splits: [{ to: dev, bps: 2000 }] });
    assert.equal((await engine.post("/v1/testmode/safe-tx", prep.body)).status, 200);
    merchant = paywalled(seller, usdg(2));
  });
  after(async () => w?.stop());

  it("supported kinds name chain 4663", async () => {
    const s = await engine.get("/x402/supported");
    assert.equal(s.body.kinds[0].network, "eip155:4663");
    assert.equal(s.body.kinds[0].scheme, "exact");
  });

  it("answers 402 with PAYMENT-REQUIRED, then settles an EIP-3009 payment into the Purser account with the split", async () => {
    const first = await merchant.request("http://shop.test/report");
    assert.equal(first.status, 402);
    const pr = decodeHeader<PaymentRequired>(first.headers.get("PAYMENT-REQUIRED"));
    assert.ok(pr);
    assert.equal(pr!.accepts[0].payTo, seller);
    const before = await usdgBalance(w, seller);
    const payload = await createExactPayload(payer, pr!.accepts[0], { resource: pr!.resource });
    const paid = await merchant.request("http://shop.test/report", { headers: { "PAYMENT-SIGNATURE": encodeHeader(payload) } });
    assert.equal(paid.status, 200, await paid.clone().text());
    const s = decodeHeader<SettleResponse>(paid.headers.get("PAYMENT-RESPONSE"));
    assert.equal(s?.success, true);
    assert.equal(s?.network, "eip155:4663");
    assert.equal(await usdgBalance(w, seller), before + usdg(1.6));
    assert.equal(await usdgBalance(w, dev), usdg(0.4));
    const income = listReceipts(w.ctx, { safe: seller, direction: "in" });
    assert.equal(income.items[0].category, "x402");
    assert.equal(income.items[0].money.amount, usdg(2).toString());
    // replaying the same header is refused
    const again = await merchant.request("http://shop.test/report", { headers: { "PAYMENT-SIGNATURE": encodeHeader(payload) } });
    assert.equal(again.status, 402);
    assert.equal((await again.json()).error, "nonce_already_used");
  });

  it("refuses underpayment, a wrong network and a forged signature", async () => {
    const req = { scheme: "exact" as const, network: "eip155:4663", amount: usdg(2).toString(), asset: w.dep.usdg, payTo: seller, maxTimeoutSeconds: 120, extra: { name: "Global Dollar", version: "1" } };
    const low = await createExactPayload(payer, { ...req, amount: usdg(1).toString() });
    let r = await engine.post("/x402/verify", { paymentPayload: { ...low, accepted: req }, paymentRequirements: req });
    assert.equal(r.body.isValid, false);
    assert.equal(r.body.invalidReason, "invalid_exact_evm_payload_authorization_value");
    r = await engine.post("/x402/verify", { paymentPayload: await createExactPayload(payer, req), paymentRequirements: { ...req, network: "eip155:8453" } });
    assert.equal(r.body.invalidReason, "invalid_network");
    const forged = await createExactPayload(privateKeyToAccount(generatePrivateKey()), req);
    (forged.payload as any).authorization.from = payer.address;
    r = await engine.post("/x402/verify", { paymentPayload: forged, paymentRequirements: req });
    assert.equal(r.body.invalidReason, "invalid_exact_evm_payload_signature");
  });

  it("settles directly to a plain wallet merchant", async () => {
    const shop = randomAddress();
    const m = paywalled(shop, usdg(1));
    const pr = decodeHeader<PaymentRequired>((await m.request("http://shop.test/report")).headers.get("PAYMENT-REQUIRED"))!;
    const ok = await m.request("http://shop.test/report", { headers: { "PAYMENT-SIGNATURE": encodeHeader(await createExactPayload(payer, pr.accepts[0])) } });
    assert.equal(ok.status, 200);
    assert.equal(await usdgBalance(w, shop), usdg(1));
  });

  it("a Purser account pays a merchant with a signed intent, through the rules and the firewall", async () => {
    const pr = decodeHeader<PaymentRequired>((await merchant.request("http://shop.test/report")).headers.get("PAYMENT-REQUIRED"))!;
    const payload = await createPurserPayload(w.agent, { safe: buyer, module: w.dep.module, chainId: 4663 }, pr.accepts[0], { resource: pr.resource });
    const sellerBefore = await usdgBalance(w, seller);
    const ok = await merchant.request("http://shop.test/report", { headers: { "PAYMENT-SIGNATURE": encodeHeader(payload) } });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(await usdgBalance(w, seller), sellerBefore + usdg(2)); // module.pay to the Safe: no split on this path
    const out = listReceipts(w.ctx, { safe: buyer, direction: "out" });
    assert.equal(out.items[0].category, "x402");
    const dir = await engine.get("/v1/x402/settlements");
    assert.ok(dir.body.items.some((x: any) => x.kind === "purser" && x.status === "settled"));
  });

  it("a Purser payment the rules refuse is not settled", async () => {
    const pricey = paywalled(seller, usdg(300)); // above the buyer's $250 single-payment cap
    const pr = decodeHeader<PaymentRequired>((await pricey.request("http://shop.test/report")).headers.get("PAYMENT-REQUIRED"))!;
    const payload = await createPurserPayload(w.agent, { safe: buyer, module: w.dep.module, chainId: 4663 }, pr.accepts[0]);
    const r = await pricey.request("http://shop.test/report", { headers: { "PAYMENT-SIGNATURE": encodeHeader(payload) } });
    assert.equal(r.status, 402);
    assert.equal((await r.json()).reason, "blocked_by_firewall");
  });
});

describe("x402 on a fork of chain 4663 (real USDG, EIP-3009)", { skip: process.env.RPC_URL === "" }, () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ fork: process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com" });
  });
  after(async () => w?.stop());

  it("settles a real USDG transferWithAuthorization into a Purser account through the module", async () => {
    const e = api(w);
    const seller = await createAccount(w, { name: "Fork seller", fund: 0n });
    const payer = privateKeyToAccount(generatePrivateKey());
    await fundUsdg(w, payer.address, usdg(5));
    const req = { scheme: "exact" as const, network: "eip155:4663", amount: usdg(1.5).toString(), asset: w.dep.usdg, payTo: seller, maxTimeoutSeconds: 120, extra: { name: "Global Dollar", version: "1" } };
    const payload = await createExactPayload(payer, req);
    const v = await e.post("/x402/verify", { paymentPayload: payload, paymentRequirements: req });
    assert.equal(v.body.isValid, true, JSON.stringify(v.body));
    const s = await e.post("/x402/settle", { paymentPayload: payload, paymentRequirements: req });
    assert.equal(s.body.success, true, JSON.stringify(s.body));
    assert.equal(await usdgBalance(w, seller), usdg(1.5));
  });
});
