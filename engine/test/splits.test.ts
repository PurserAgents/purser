import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createExactPayload } from "../../packages/sdk/src/x402.ts";
import { createAccount, fundUsdg, makeWorld, randomAddress, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("automatic revenue splits (9.1, 9.2, local)", () => {
  let w: World;
  let e: Api;
  let safe: `0x${string}`;
  const owner = randomAddress();
  const developer = randomAddress();
  const provider = randomAddress();
  const coworker = randomAddress();
  const payer = privateKeyToAccount(generatePrivateKey());

  before(async () => {
    w = await makeWorld();
    e = api(w);
    safe = await createAccount(w, { name: "Earning agent", fund: 0n });
    await fundUsdg(w, payer.address, usdg(1000));
  });
  after(async () => w?.stop());

  it("refuses shares above 100% before anything is signed", async () => {
    const r = await e.post(`/v1/accounts/${safe}/splits/prepare`, { splits: [{ to: owner, bps: 6000 }, { to: developer, bps: 5000 }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /110/);
  });

  it("owner, developer, model provider and a co-worker agent are paid on arrival; totals per recipient", async () => {
    const prep = await e.post(`/v1/accounts/${safe}/splits/prepare`, {
      splits: [
        { to: owner, bps: 5000, label: "Owner", role: "owner" },
        { to: developer, bps: 1000, label: "Developer", role: "developer" },
        { to: provider, bps: 1500, label: "Model provider", role: "model_provider" },
        { to: coworker, bps: 500, label: "Research agent", role: "coworker" },
      ],
    });
    assert.equal((await e.post("/v1/testmode/safe-tx", prep.body)).status, 200);
    const req = { scheme: "exact" as const, network: "eip155:4663", amount: usdg(200).toString(), asset: w.dep.usdg, payTo: safe, maxTimeoutSeconds: 120, extra: { name: "Global Dollar", version: "1" } };
    const s = await e.post("/x402/settle", { paymentPayload: await createExactPayload(payer, req), paymentRequirements: req });
    assert.equal(s.body.success, true, JSON.stringify(s.body));
    assert.equal(await usdgBalance(w, owner), usdg(100));
    assert.equal(await usdgBalance(w, developer), usdg(20));
    assert.equal(await usdgBalance(w, provider), usdg(30));
    assert.equal(await usdgBalance(w, coworker), usdg(10));
    assert.equal(await usdgBalance(w, safe), usdg(40));
    const view = await e.get(`/v1/accounts/${safe}/splits`);
    assert.equal(view.body.keptBps, 2000);
    const dev = view.body.items.find((x: any) => x.to === developer.toLowerCase());
    assert.equal(dev.role, "developer");
    assert.equal(dev.paid[0].amount, usdg(20).toString());
    const acct = (await e.get(`/v1/accounts/${safe}`)).body;
    assert.equal(acct.splits.length, 4);
  });
});
