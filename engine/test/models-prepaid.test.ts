// Models at cost are prepaid: no path answers a call that is not already paid for on chain. Each test is one way an
// account could get model calls without paying under the earlier credit design (calls first, settlement later).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { encodeFunctionData, type Address } from "viem";
import { erc20Abi } from "../../packages/sdk/src/abi.ts";
import { execAsTestOwner, prepareSafeTx } from "../src/accounts.ts";
import { bookTopUp, creditMicro, CREDIT_SERVICE } from "../src/models.ts";
import { createAccount, defaultRule, makeWorld, randomAddress, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

function standIn() {
  const seen: unknown[] = [];
  let usage = { input_tokens: 1000, output_tokens: 500 };
  const app = new Hono();
  app.post("/v1/messages", async (c) => {
    const b = await c.req.json();
    seen.push(b);
    await new Promise((r) => setTimeout(r, 20)); // a little latency, so parallel calls overlap
    return c.json({ id: `msg_${seen.length}`, type: "message", role: "assistant", model: b.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage });
  });
  return { app, seen, setUsage: (u: typeof usage) => (usage = u) };
}

describe("models at cost are prepaid: every path to an unpaid call is closed (local)", () => {
  let w: World;
  let e: Api;
  let owner: string;
  let server: ServerType;
  const fake = standIn();
  const company = randomAddress();

  const keyFor = async (safe: Address) => {
    const k = await e.post(`/v1/accounts/${safe}/keys`, { name: "agent", managed: true }, owner);
    const acct = (await e.get(`/v1/accounts/${safe}`)).body;
    await e.post("/v1/testmode/safe-tx", (await e.post(`/v1/accounts/${safe}/rules/prepare`, { config: { ...acct.config, agent: k.body.key.sessionAddress } })).body);
    return k.body.secret as string;
  };
  const ask = async (key: string, model = "purser/claude-opus-5-5", maxTokens = 4000) => {
    const res = await e.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Write the report." }], max_tokens: maxTokens }),
    });
    return { status: res.status, body: await res.json() };
  };
  const topUps = (safe: Address) => BigInt((w.ctx.db.prepare("SELECT COALESCE(SUM(micro), 0) AS n FROM model_topups WHERE safe = ?").get(safe.toLowerCase()) as { n: number }).n);
  const used = (safe: Address) => BigInt((w.ctx.db.prepare("SELECT COALESCE(SUM(CAST(cost_micro AS INTEGER)), 0) AS n FROM model_calls WHERE safe = ?").get(safe.toLowerCase()) as { n: number }).n);

  before(async () => {
    w = await makeWorld();
    e = api(w);
    owner = (await e.post("/v1/testmode/session")).body.token;
    server = serve({ fetch: fake.app.fetch, port: 0 });
    await new Promise((r) => server.once("listening", r));
    process.env.PURSER_MODELS_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.PURSER_MODELS_KEY = "sk-ant-test";
    process.env.PURSER_MODELS_PAYTO = company;
    delete process.env.PURSER_MODELS_TOPUP_MICRO; // the default: top up by at least $0.25
  });
  after(async () => {
    for (const k of ["PURSER_MODELS_URL", "PURSER_MODELS_KEY", "PURSER_MODELS_PAYTO"]) delete process.env[k];
    server?.close();
    await w?.stop();
  });

  it("parallel calls on several keys cannot share one payment: every answered call was paid before it ran", async () => {
    const safe = await createAccount(w, { name: "Burst agent" });
    const keys = [await keyFor(safe), await keyFor(safe)];
    const before = await usdgBalance(w, company);
    const calls = fake.seen.length;
    const out = await Promise.all(Array.from({ length: 12 }, (_, i) => ask(keys[i % 2])));
    const answered = out.filter((r) => r.status === 200).length;
    assert.ok(answered > 0, JSON.stringify(out.map((r) => r.body?.error ?? r.status)));
    assert.equal(fake.seen.length - calls, answered, "the provider answered only the calls that were funded");
    const paid = (await usdgBalance(w, company)) - before;
    assert.equal(paid, topUps(safe), "every credited dollar arrived at the models address");
    assert.equal(creditMicro(w.ctx, safe), paid - used(safe), "credit = paid - used, never below zero");
    assert.ok(creditMicro(w.ctx, safe) >= 0n);
  });

  it("an owner who empties the account after calls leaves nothing unpaid, and gets no more calls", async () => {
    const safe = await createAccount(w, { name: "Drained agent" });
    const key = await keyFor(safe);
    assert.equal((await ask(key)).status, 200);
    const spentBefore = used(safe);
    assert.ok(topUps(safe) >= spentBefore, "the answered call was already paid");
    const bal = await usdgBalance(w, safe);
    await execAsTestOwner(w.ctx, await prepareSafeTx(w.ctx, safe, [{ to: w.dep.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [w.owner.address, bal] }) }], "take it all out"));
    const calls = fake.seen.length;
    let r = await ask(key);
    while (r.status === 200) r = await ask(key); // what is left of the credit may still pay a call or two
    assert.equal(r.status, 402, JSON.stringify(r.body));
    assert.ok(["payment_blocked", "payment_failed"].includes(r.body.error.code), JSON.stringify(r.body));
    assert.equal(creditMicro(w.ctx, safe), topUps(safe) - used(safe), "every call that ran was paid before it ran");
    assert.ok(creditMicro(w.ctx, safe) >= 0n);
    void calls;
  });

  it("a frozen account gets no calls, even with credit left", async () => {
    const safe = await createAccount(w, { name: "Frozen agent" });
    const key = await keyFor(safe);
    assert.equal((await ask(key, "auto:fast", 100)).status, 200);
    assert.ok(creditMicro(w.ctx, safe) > 0n);
    await e.post("/v1/testmode/tx", (await e.post(`/v1/accounts/${safe}/freeze/prepare`)).body);
    const calls = fake.seen.length;
    const r = await ask(key, "auto:fast", 100);
    assert.equal(r.status, 402);
    assert.equal(r.body.error.code, "account_frozen");
    assert.equal(fake.seen.length, calls);
  });

  it("a top-up that needs the owner's approval answers nothing until it is paid", async () => {
    const safe = await createAccount(w, { name: "Careful agent", rule: { ...defaultRule, approvalAbove: "1000" } });
    const key = await keyFor(safe);
    const calls = fake.seen.length;
    const r = await ask(key);
    assert.equal(r.status, 402, JSON.stringify(r.body));
    assert.equal(r.body.error.code, "needs_approval");
    assert.equal(fake.seen.length, calls);
    assert.equal(creditMicro(w.ctx, safe), 0n);
  });

  it("only a proven payment to the models address is credited", async () => {
    const safe = await createAccount(w, { name: "Clever agent" });
    const key = await keyFor(safe);
    // the credit service name on a payment to another address (the agent's own wallet) credits nothing
    const elsewhere = await e.post("/v1/pay", { to: randomAddress(), amount: usdg(5).toString(), service: CREDIT_SERVICE }, key);
    assert.equal(elsewhere.body.intent.status, "executed", JSON.stringify(elsewhere.body));
    assert.equal(await bookTopUp(w.ctx, safe, elsewhere.body.intent.id), 0n);
    assert.equal(creditMicro(w.ctx, safe), 0n);
    // a payment to the models address with the service name is a top-up, credited once, when it executes
    const direct = await e.post("/v1/pay", { to: company, amount: usdg(1).toString(), service: CREDIT_SERVICE }, key);
    assert.equal(direct.body.intent.status, "executed");
    assert.equal(creditMicro(w.ctx, safe), 1_000_000n);
    assert.equal(await bookTopUp(w.ctx, safe, direct.body.intent.id), 0n, "never twice");
    assert.equal(creditMicro(w.ctx, safe), 1_000_000n);
  });

  it("calls answered under the old design are paid before any new call; if that payment is refused, nothing is answered", async () => {
    const ok = await createAccount(w, { name: "Old debt agent" });
    const okKey = await keyFor(ok);
    const insert = (safe: Address, micro: number) =>
      w.ctx.db.prepare("INSERT INTO model_calls (id, safe, provider, model, prompt_tokens, completion_tokens, cost_micro, receipt_id, task_id, created_at) VALUES (?, ?, 'purser', 'claude-haiku-5-5', 10, 10, ?, NULL, NULL, ?)").run(`old_${Math.random()}`, safe.toLowerCase(), String(micro), 1);
    insert(ok, 5000);
    const before = await usdgBalance(w, company);
    const r = await ask(okKey, "auto:fast", 100);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.purser.settled[0].usd, "0.005000");
    assert.ok((await usdgBalance(w, company)) - before >= 5000n);

    const tight = await createAccount(w, { name: "Old debt, tight rules", rule: { ...defaultRule, maxSingle: "100", approvalAbove: null } });
    const tightKey = await keyFor(tight);
    insert(tight, 5000);
    const calls = fake.seen.length;
    const refused = await ask(tightKey, "auto:fast", 100);
    assert.equal(refused.status, 402);
    assert.equal(refused.body.error.code, "settlement_refused");
    assert.equal(fake.seen.length, calls);
  });

  it("a call that used more than its bound is taken from the credit, and the next call pays that back first", async () => {
    const safe = await createAccount(w, { name: "Long prompt agent" });
    const key = await keyFor(safe);
    fake.setUsage({ input_tokens: 400_000, output_tokens: 10 }); // far above the bound of a short message
    const one = await ask(key, "purser/claude-opus-5-5", 100);
    assert.equal(one.status, 200);
    assert.match(one.body.purser.creditUsd, /^-1\.350200$/);
    fake.setUsage({ input_tokens: 20, output_tokens: 50 }); // a normal call, inside its bound
    assert.ok(creditMicro(w.ctx, safe) < 0n, "the overrun is a debt on the credit");
    const two = await ask(key, "purser/claude-opus-5-5", 100);
    assert.equal(two.status, 200, JSON.stringify(two.body));
    assert.ok(two.body.purser.topUp, "the next call topped up first");
    assert.ok(creditMicro(w.ctx, safe) >= 0n);
    assert.equal(creditMicro(w.ctx, safe), topUps(safe) - used(safe));
    fake.setUsage({ input_tokens: 1000, output_tokens: 500 });
  });
});
