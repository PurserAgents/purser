// Regression for HEY's retest finding E-1b: a token that calls itself "USDG" wrote a "USDG" row into an honest payee's
// books. Only listed tokens show the symbol they report, and only listed tokens are mirrored into another account.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { encodeDeployData, encodeFunctionData, type Address } from "viem";
import { erc20Abi } from "../../packages/sdk/src/abi.ts";
import { artifact } from "../src/deploy.ts";
import { submitIntent } from "../src/intents.ts";
import { listReceipts } from "../src/receipts.ts";
import { createAccount, defaultRule, makeOfflineEngine, makeWorld, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("a look-alike token never reads as USDG and never reaches another account's books", () => {
  let w: World;
  let e: Api;
  let fake: Address;

  before(async () => {
    w = await makeWorld();
    e = api(w);
    const a = artifact("Mocks.sol", "MockToken");
    const relayer = w.ctx.chain.accounts.relayer!;
    const hash = await w.ctx.chain.wallet(relayer).sendTransaction({ account: relayer, chain: w.ctx.chain.chain, data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: ["Global Dollar", "USDG", 6] }) });
    fake = (await w.ctx.chain.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 })).contractAddress!;
  });
  after(async () => w?.stop());

  it("pays an honest account in the look-alike: the payer's row names the token by address, the payee's books stay empty", async () => {
    const payer = await createAccount(w, { name: "Payer" });
    const payee = await createAccount(w, { name: "Honest payee" });
    const prep = await e.post(`/v1/accounts/${payer}/rules/prepare`, { rules: [{ token: fake, rule: defaultRule }] });
    assert.equal(prep.status, 200, JSON.stringify(prep.body));
    await e.post("/v1/testmode/safe-tx", prep.body);
    await w.ctx.chain.send(w.ctx.chain.accounts.relayer!, { to: fake, data: encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [payer, 500_000_000n] }) });

    const r = await submitIntent(w.ctx, { safe: payer, spec: { kind: "pay", pay: { token: fake, to: payee, amount: 5_000_000n } }, category: "transfer", signer: w.agent });
    assert.equal(r.intent.status, "executed", r.intent.error ?? "");
    const out = listReceipts(w.ctx, { safe: payer }).items.find((x) => x.direction === "out" && x.counterparty === payee.toLowerCase());
    assert.ok(out);
    assert.notEqual(out!.money.token.symbol, "USDG");
    assert.match(out!.money.token.symbol, /^0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
    assert.equal(out!.money.usd, null, "no dollar value");
    assert.equal(listReceipts(w.ctx, { safe: payee, direction: "in" }).items.length, 0, "nothing in the honest payee's books");
    assert.equal(w.ctx.tokens.infoSync(w.dep.usdg).symbol, "USDG", "the real USDG keeps its name");
  });
});

describe("/v1/health names the build", () => {
  it("reports the version with the commit, not the same 0.1.0 for every build", async () => {
    const engine = makeOfflineEngine();
    const { buildApp } = await import("../src/api/app.ts");
    const res = await buildApp(engine.ctx).request("/v1/health");
    const h = await res.json();
    assert.match(h.version, /^0\.1\.0\+([0-9a-f]{7}|unknown)$/);
    if (h.build) assert.match(h.build, /^[0-9a-f]{40}$/);
    assert.equal(h.version.slice(6), h.build ? h.build.slice(0, 7) : "unknown");
    engine.ctx.db.close();
  });
});
