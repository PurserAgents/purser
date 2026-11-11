import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createExactPayload } from "../../packages/sdk/src/x402.ts";
import { submitIntent } from "../src/intents.ts";
import { settlePayment } from "../src/x402.ts";
import { createAccount, fundUsdg, makeWorld, randomAddress, usdg, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("accounting: P&L, cost per task and model, revenue per customer, CSV (16.1, local)", () => {
  let w: World;
  let e: Api;
  let safe: `0x${string}`;
  const providerA = randomAddress();
  const providerB = randomAddress();
  const customer1 = privateKeyToAccount(generatePrivateKey());
  const customer2 = privateKeyToAccount(generatePrivateKey());

  before(async () => {
    w = await makeWorld();
    e = api(w);
    safe = await createAccount(w, { name: "Bookkeeper", fund: usdg(500) });
    const pay = (to: `0x${string}`, amount: bigint, model: string, taskId: string) =>
      submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to, amount, service: `model:${model}` } }, category: "model", signer: w.agent, meta: { taskId, model: { provider: model.split("/")[0], model: model.split("/")[1], promptTokens: 1000, completionTokens: 200 } } });
    await pay(providerA, usdg(1.5), "alpha/fast", "task-42");
    await pay(providerA, usdg(2.5), "alpha/fast", "task-42");
    await pay(providerB, usdg(4), "beta/deep", "task-43");
    for (const [c, amount] of [[customer1, usdg(20)], [customer2, usdg(7)], [customer1, usdg(3)]] as const) {
      await fundUsdg(w, c.address, amount);
      const req = { scheme: "exact" as const, network: "eip155:4663", amount: amount.toString(), asset: w.dep.usdg, payTo: safe, maxTimeoutSeconds: 120, extra: { name: "Global Dollar", version: "1" } };
      const s = await settlePayment(w.ctx, await createExactPayload(c, req), req, { category: "storefront", service: "svc_report" });
      assert.equal(s.success, true);
    }
  });
  after(async () => w?.stop());

  it("adds up income, spend, fees and profit", async () => {
    const p = (await e.get(`/v1/accounts/${safe}/pnl`)).body;
    assert.equal(p.incomeUsd, "30.00");
    assert.equal(p.spendUsd, "8.00");
    assert.equal(p.feesUsd, "0.00"); // 0.1% of 8 USDG is 0.008, shown to the cent
    assert.equal(p.profitUsd, "21.99");
    assert.deepEqual(p.byCategory.map((l: any) => l.key).sort(), ["model", "storefront"]);
  });

  it("splits cost per model and per task, and revenue per customer", async () => {
    const p = (await e.get(`/v1/accounts/${safe}/pnl`)).body;
    const alpha = p.byModel.find((l: any) => l.key === "alpha/fast");
    assert.equal(alpha.spend, "4.00");
    assert.equal(alpha.count, 2);
    assert.equal(p.byTask.find((l: any) => l.key === "task-42").spend, "4.00");
    assert.equal(p.byTask.find((l: any) => l.key === "task-43").spend, "4.00");
    const c1 = p.byCustomer.find((l: any) => l.key === customer1.address.toLowerCase());
    assert.equal(c1.income, "23.00");
    assert.equal(c1.count, 2);
    assert.equal(p.byCustomer[0].key, customer1.address.toLowerCase(), "largest customer first");
    assert.equal(p.byDay.length, 1);
  });

  it("exports every receipt as CSV", async () => {
    const res = await e.app.request(`/v1/accounts/${safe}/export.csv`);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    const csv = await res.text();
    const rows = csv.trim().split("\n");
    assert.equal(rows[0], "date,receipt,account,direction,category,amount,token,usd,fee,counterparty,counterparty_name,service,memo,task,customer,model,status,tx_hash");
    assert.equal(rows.length, 1 + 6);
    assert.ok(rows.some((r) => r.includes(",model,1.50,USDG,1.50,0.0015,") && r.includes("model:alpha/fast") && r.includes("task-42") && r.includes("alpha/fast")), rows.join("\n"));
    assert.ok(rows.some((r) => r.includes(",in,storefront,20.00,USDG,20.00,")));
  });
});
