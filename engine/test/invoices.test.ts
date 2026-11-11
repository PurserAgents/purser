import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { listReceipts } from "../src/receipts.ts";
import { createAccount, makeWorld, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("invoices and escrow between agents (10.1, 10.2, local)", () => {
  let w: World;
  let e: Api;
  let payer: `0x${string}`;
  let payee: `0x${string}`;
  let payerKey: string;
  let payeeKey: string;
  const arbiter = privateKeyToAccount(generatePrivateKey());
  const warp = async (s: number) => {
    await w.rpc("evm_increaseTime", [s]);
    await w.rpc("evm_mine", []);
  };

  async function keyFor(safe: `0x${string}`, owner: string) {
    const k = await e.post(`/v1/accounts/${safe}/keys`, { managed: true }, owner);
    const acct = (await e.get(`/v1/accounts/${safe}`)).body;
    await e.post("/v1/testmode/safe-tx", (await e.post(`/v1/accounts/${safe}/rules/prepare`, { config: { ...acct.config, agent: k.body.key.sessionAddress } })).body);
    return k.body.secret as string;
  }

  before(async () => {
    w = await makeWorld();
    e = api(w);
    const owner = (await e.post("/v1/testmode/session")).body.token;
    payer = await createAccount(w, { name: "Client agent" });
    payee = await createAccount(w, { name: "Contractor agent", fund: 0n });
    payerKey = await keyFor(payer, owner);
    payeeKey = await keyFor(payee, owner);
    await w.rpc("anvil_setBalance", [arbiter.address, "0xDE0B6B3A7640000"]);
  });
  after(async () => w?.stop());

  it("invoice, escrow, delivery, release: the contractor is paid and both sides have receipts", async () => {
    const inv = await e.post("/v1/invoices", { payer, amount: usdg(120).toString(), description: "Competitor research, 10 pages", dueInSeconds: 3 * 86400, reviewPeriodSeconds: 86400 }, payeeKey);
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const paid = await e.post(`/v1/invoices/${inv.body.id}/pay`, {}, payerKey);
    assert.equal(paid.status, 200, JSON.stringify(paid.body.verdict ?? paid.body));
    assert.equal(paid.body.invoice.status, "funded");
    assert.ok(paid.body.invoice.jobId);
    assert.equal(await usdgBalance(w, w.dep.escrow), usdg(120));
    const out = listReceipts(w.ctx, { safe: payer, category: "escrow" }).items[0];
    assert.equal(out.money.amount, usdg(120).toString());
    const delivered = await e.post(`/v1/invoices/${inv.body.id}/deliver`, { note: "https://files.example/report.pdf" }, payeeKey);
    assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
    assert.equal(delivered.body.invoice.status, "delivered");
    const released = await e.post(`/v1/invoices/${inv.body.id}/release`, {}, payerKey);
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.invoice.status, "released");
    assert.equal(await usdgBalance(w, payee), usdg(120));
    const income = listReceipts(w.ctx, { safe: payee, direction: "in", category: "escrow" }).items[0];
    assert.equal(income.money.amount, usdg(120).toString());
    // a second release is refused
    assert.equal((await e.post(`/v1/invoices/${inv.body.id}/release`, {}, payerKey)).status >= 400, true);
  });

  it("nothing delivered by the deadline: anyone triggers the refund", async () => {
    const inv = await e.post("/v1/invoices", { payer, amount: usdg(50).toString(), description: "Logo set", dueInSeconds: 3600, reviewPeriodSeconds: 3600 }, payeeKey);
    await e.post(`/v1/invoices/${inv.body.id}/pay`, {}, payerKey);
    const before = await usdgBalance(w, payer);
    const early = await e.post(`/v1/invoices/${inv.body.id}/refund`);
    assert.equal(early.status, 400);
    assert.match(early.body.error.message, /too early/i);
    await warp(3601);
    const r = await e.post(`/v1/invoices/${inv.body.id}/refund`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.invoice.status, "refunded");
    assert.equal(await usdgBalance(w, payer), before + usdg(50));
  });

  it("delivered and not disputed: the contractor claims after the review window", async () => {
    const inv = await e.post("/v1/invoices", { payer, amount: usdg(30).toString(), description: "Data cleaning", reviewPeriodSeconds: 600 }, payeeKey);
    await e.post(`/v1/invoices/${inv.body.id}/pay`, {}, payerKey);
    await e.post(`/v1/invoices/${inv.body.id}/deliver`, { note: "done" }, payeeKey);
    await warp(601);
    const before = await usdgBalance(w, payee);
    const r = await e.post(`/v1/invoices/${inv.body.id}/claim`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await usdgBalance(w, payee), before + usdg(30));
  });

  it("a dispute goes to the named arbiter, who splits the money", async () => {
    const inv = await e.post("/v1/invoices", { payer, amount: usdg(100).toString(), description: "Translation", arbiter: arbiter.address, reviewPeriodSeconds: 3600 }, payeeKey);
    await e.post(`/v1/invoices/${inv.body.id}/pay`, {}, payerKey);
    await e.post(`/v1/invoices/${inv.body.id}/deliver`, { note: "half of it" }, payeeKey);
    const d = await e.post(`/v1/invoices/${inv.body.id}/dispute`, {}, payerKey);
    assert.equal(d.body.invoice.status, "disputed");
    const prep = await e.post(`/v1/invoices/${inv.body.id}/prepare`, { action: "resolve", payeeBps: 6000 });
    const payeeBefore = await usdgBalance(w, payee);
    const payerBefore = await usdgBalance(w, payer);
    const hash = await w.ctx.chain.wallet(arbiter).sendTransaction({ account: arbiter, chain: w.ctx.chain.chain, to: prep.body.to, data: prep.body.data });
    await w.ctx.chain.pub.waitForTransactionReceipt({ hash });
    const { indexOnce } = await import("../src/indexer.ts");
    await indexOnce(w.ctx);
    assert.equal((await e.get(`/v1/invoices/${inv.body.id}`)).body.status, "resolved");
    assert.equal(await usdgBalance(w, payee), payeeBefore + usdg(60));
    assert.equal(await usdgBalance(w, payer), payerBefore + usdg(40));
  });

  it("only the parties act; an invoice over the payer's rules is blocked by the firewall", async () => {
    const inv = await e.post("/v1/invoices", { payer, amount: usdg(900).toString(), description: "Too big" }, payeeKey);
    assert.equal((await e.post(`/v1/invoices/${inv.body.id}/pay`, {}, payeeKey)).status, 403);
    const r = await e.post(`/v1/invoices/${inv.body.id}/pay`, {}, payerKey);
    assert.equal(r.status, 422);
    assert.ok(r.body.verdict.reasons.some((x: any) => x.code === "max_single"));
    const list = await e.get(`/v1/accounts/${payer}/invoices`);
    assert.ok(list.body.items.length >= 5);
  });
});
