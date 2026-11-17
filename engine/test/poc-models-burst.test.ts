// Regression for GHSA-6gqp-w3qv-9vfv (N-1, reported by HEY Research Lab). Local chain only (anvil), stand-in provider.
//
// Models at cost used to be paid after the fact, and the check before a call reserved nothing: calls sent at the same
// moment all passed against the same balance, the account then owed more than it held, and nothing was paid. Calls are
// now prepaid: the most a call can cost is taken from the account's credit (one statement, so two calls never take the
// same money), and a short credit is topped up on chain before the model is asked. The reporter's bursts are run here
// and every answered call must have been paid before it ran: credit = paid on chain - used, never below zero.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { Address } from "viem";
import type { AccountConfig } from "../../packages/sdk/src/schema.ts";
import { execAsTestOwner, prepareSafeTx, ruleChangeCalls } from "../src/accounts.ts";
import { indexOnce, ingestReceipt } from "../src/indexer.ts";
import { createApiKey } from "../src/keys.ts";
import { creditMicro } from "../src/models.ts";
import { createAccount, defaultConfig, makeWorld, randomAddress, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

// about 20,000 tokens by the reporter's estimate
const PROMPT = "Summarise the quarter. ".repeat(2174);

function standIn() {
  const seen: unknown[] = [];
  const app = new Hono();
  app.post("/v1/messages", async (c) => {
    const b = await c.req.json();
    seen.push(b);
    await new Promise((r) => setTimeout(r, 150)); // a model takes a moment to answer
    return c.json({ id: `msg_${seen.length}`, type: "message", role: "assistant", model: b.model, content: [{ type: "text", text: `Answer ${seen.length}` }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 20_000, output_tokens: 8_000 } });
  });
  return { app, seen };
}

describe("GHSA-6gqp-w3qv-9vfv: calls sent at the same moment cannot take model calls on credit", () => {
  let w: World;
  let e: Api;
  let server: ServerType;
  const provider = standIn();
  const company = randomAddress();
  const saved = { url: process.env.PURSER_MODELS_URL, key: process.env.PURSER_MODELS_KEY, payTo: process.env.PURSER_MODELS_PAYTO, topUp: process.env.PURSER_MODELS_TOPUP_MICRO };

  const keyFor = async (safe: Address) => {
    const k = createApiKey(w.ctx, { safe, name: "models", scopes: ["models", "read"], managed: true });
    const cfg: AccountConfig = defaultConfig(w, { agent: k.key.sessionAddress as Address });
    const r = await execAsTestOwner(w.ctx, await prepareSafeTx(w.ctx, safe, ruleChangeCalls(w.ctx, { config: cfg }), "set the agent key"));
    await ingestReceipt(w.ctx, r);
    await indexOnce(w.ctx);
    return k.secret;
  };
  const ask = (secret: string) =>
    e.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: "purser/claude-opus-5-5", max_tokens: 8000, messages: [{ role: "user", content: PROMPT }] }),
    });
  const topUps = (safe: Address) => BigInt((w.ctx.db.prepare("SELECT COALESCE(SUM(micro), 0) AS n FROM model_topups WHERE safe = ?").get(safe.toLowerCase()) as { n: number }).n);
  const used = (safe: Address) => BigInt((w.ctx.db.prepare("SELECT COALESCE(SUM(CAST(cost_micro AS INTEGER)), 0) AS n FROM model_calls WHERE safe = ?").get(safe.toLowerCase()) as { n: number }).n);
  /** Every answered call was paid before it ran: what the account paid in, less what its calls used, is its credit. */
  const paidInFull = (safe: Address) => {
    assert.equal(creditMicro(w.ctx, safe), topUps(safe) - used(safe));
    assert.ok(creditMicro(w.ctx, safe) >= 0n, "never below zero");
  };
  const burst = async (secrets: string[], n: number) => {
    const before = provider.seen.length;
    const out = await Promise.all(Array.from({ length: n }, (_, i) => ask(secrets[i % secrets.length])));
    const bodies = await Promise.all(out.map((r) => r.json()));
    return { answered: out.filter((r) => r.status === 200).length, providerCalls: provider.seen.length - before, codes: bodies.map((b, i) => (out[i].status === 200 ? "200" : `${out[i].status} ${b.error.code}`)) };
  };

  before(async () => {
    w = await makeWorld();
    e = api(w);
    server = serve({ fetch: provider.app.fetch, port: 0 });
    await new Promise((r) => server.once("listening", r));
    process.env.PURSER_MODELS_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.PURSER_MODELS_KEY = "sk-ant-test";
    process.env.PURSER_MODELS_PAYTO = company;
    delete process.env.PURSER_MODELS_TOPUP_MICRO;
  });
  after(async () => {
    for (const [k, v] of [["PURSER_MODELS_URL", saved.url], ["PURSER_MODELS_KEY", saved.key], ["PURSER_MODELS_PAYTO", saved.payTo], ["PURSER_MODELS_TOPUP_MICRO", saved.topUp]] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    server?.close();
    await w?.stop();
  });

  it("the reported burst: 20 Opus calls at once on 0.50 USDG; nothing is answered that was not paid first", async () => {
    const safe = await createAccount(w, { name: "Real Safe, small balance", fund: usdg("0.5") });
    const secret = await keyFor(safe);
    const before = await usdgBalance(w, company);
    const b = await burst([secret], 20);
    assert.equal(b.providerCalls, b.answered, "the provider answered only funded calls");
    paidInFull(safe);
    assert.equal((await usdgBalance(w, company)) - before, topUps(safe), "everything credited reached the models address");
    // refused calls are 402 (not paid) or 429 (more than four calls of one account at once)
    assert.ok(b.codes.every((c) => c === "200" || /^402 /.test(c) || c === "429 too_many_calls"), b.codes.join(", "));
    const next = await ask(secret);
    const body = await next.json();
    assert.notEqual(body.error?.code, "settlement_refused", "there is never a debt to refuse");
  });

  it("the larger burst: 60 at once on 0.50 USDG", async () => {
    const safe = await createAccount(w, { name: "Larger burst", fund: usdg("0.5") });
    const secret = await keyFor(safe);
    const b = await burst([secret], 60);
    assert.equal(b.providerCalls, b.answered);
    paidInFull(safe);
  });

  it("an account with enough money: a burst on several keys is answered, every call paid before it ran", async () => {
    const safe = await createAccount(w, { name: "Funded burst", fund: usdg(20) });
    const secrets = [await keyFor(safe), await keyFor(safe), await keyFor(safe)];
    const before = await usdgBalance(w, company);
    const b = await burst(secrets, 12);
    assert.ok(b.answered > 0, b.codes.join(", "));
    assert.equal(b.providerCalls, b.answered);
    paidInFull(safe);
    const paid = (await usdgBalance(w, company)) - before;
    assert.ok(paid >= used(safe), `paid ${paid} for calls that cost ${used(safe)}`);
  });

  it("many accounts of one owner, all at once: each account pays its own calls before they run", async () => {
    const safes: Address[] = [];
    for (let i = 0; i < 3; i++) safes.push(await createAccount(w, { name: `Same owner ${i}`, fund: usdg("0.5") }));
    const secrets = await Promise.all(safes.map(keyFor));
    const before = await usdgBalance(w, company);
    const out = await Promise.all(secrets.map((s) => burst([s], 10)));
    for (const s of safes) paidInFull(s);
    const answered = out.reduce((n, b) => n + b.answered, 0);
    assert.equal(out.reduce((n, b) => n + b.providerCalls, 0), answered);
    const paid = (await usdgBalance(w, company)) - before;
    assert.equal(paid, safes.reduce((n, s) => n + topUps(s), 0n));
    assert.ok(paid >= safes.reduce((n, s) => n + used(s), 0n));
  });
});
