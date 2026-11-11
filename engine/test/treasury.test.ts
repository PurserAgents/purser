import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { erc4626Abi } from "../../packages/sdk/src/abi.ts";
import { listReceipts } from "../src/receipts.ts";
import { createAccount, makeWorld, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

async function setup(w: World) {
  const e = api(w);
  const owner = (await e.post("/v1/testmode/session")).body.token;
  const safe = await createAccount(w, { name: "Treasurer", fund: usdg(1000) });
  const k = await e.post(`/v1/accounts/${safe}/keys`, { managed: true }, owner);
  const acct = (await e.get(`/v1/accounts/${safe}`)).body;
  await e.post("/v1/testmode/safe-tx", (await e.post(`/v1/accounts/${safe}/rules/prepare`, { config: { ...acct.config, agent: k.body.key.sessionAddress } })).body);
  return { e, safe, key: k.body.secret as string };
}

for (const mode of ["local", "fork"] as const) {
  describe(`agent treasury (14.1, ${mode})`, { skip: mode === "fork" && process.env.RPC_URL === "" }, () => {
    let w: World;
    let e: Api;
    let safe: `0x${string}`;
    let key: string;
    before(async () => {
      w = await makeWorld(mode === "fork" ? { fork: process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com" } : {});
      ({ e, safe, key } = await setup(w));
    });
    after(async () => w?.stop());

    it("lists vaults; the owner allows one and sets a keep-liquid floor", async () => {
      const v = await e.get("/v1/treasury/vaults");
      assert.ok(v.body.items.length >= 1);
      assert.equal(v.body.items[0].asset.symbol, "USDG");
      const prep = await e.post(`/v1/accounts/${safe}/treasury/prepare`, { vaults: [w.dep.vaults[0]], keepLiquid: usdg(200).toString() });
      assert.equal((await e.post("/v1/testmode/safe-tx", prep.body)).status, 200);
      const t = await e.get(`/v1/accounts/${safe}/treasury`);
      assert.deepEqual(t.body.allowedVaults, [w.dep.vaults[0].toLowerCase()]);
      assert.equal(t.body.keepLiquid[0].amount, usdg(200).toString());
    });

    it("sweeps idle money into the vault, never below the floor, and takes it back", async () => {
      const sweep = await e.post("/v1/treasury/sweep", { buffer: usdg(50).toString() }, key);
      assert.equal(sweep.status, 200, JSON.stringify(sweep.body.verdict?.reasons ?? sweep.body));
      assert.equal(sweep.body.intent.status, "executed", sweep.body.intent.error ?? "");
      assert.equal(await usdgBalance(w, safe), usdg(250));
      const t = await e.get(`/v1/accounts/${safe}/treasury`);
      const pos = t.body.positions[0];
      assert.ok(BigInt(pos.assets.amount) >= usdg(749.9), pos.assets.amount);
      const tooMuch = await e.post("/v1/treasury/deposit", { vault: w.dep.vaults[0], amount: usdg(100).toString() }, key);
      assert.equal(tooMuch.body.intent.status, "blocked");
      assert.match(tooMuch.body.verdict.summary, /fail on chain/);
      const back = await e.post("/v1/treasury/withdraw", { vault: w.dep.vaults[0], amount: usdg(300).toString() }, key);
      assert.equal(back.body.intent.status, "executed", back.body.intent.error ?? "");
      assert.equal(await usdgBalance(w, safe), usdg(550));
      const shares = await w.ctx.chain.pub.readContract({ address: w.dep.vaults[0], abi: erc4626Abi, functionName: "balanceOf", args: [safe] });
      assert.ok(shares > 0n);
      const moves = listReceipts(w.ctx, { safe, category: "treasury" });
      assert.equal(moves.items.length, 2);
      // treasury moves are not spending
      const acct = (await e.get(`/v1/accounts/${safe}`)).body;
      assert.equal(acct.spentToday.find((s: any) => s.token.symbol === "USDG").spent, "0");
    });
  });
}
