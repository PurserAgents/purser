// Regressions for HEY Research Lab's second re-test (at 7cb16e6), the items not covered by b5cea77. Local chain only
// (anvil), stand-in model provider that speaks both plain JSON and the streaming (SSE) Messages API.
//   1. max_tokens up to 32,000 is answered: long calls are streamed from the provider;
//   2. a burst cannot multiply a gap between the bound and the provider's count: at most a few calls run at once;
//      a large prompt is counted by the provider, so the reservation is its real size;
//   3. the long-prompt prices match Anthropic's published pricing;
//   4. a top-up's confirmation depth is a setting.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Address } from "viem";
import { costMicro, creditMicro, CREDIT_SERVICE, MODELS, reconcileTopUps, usd6 } from "../src/models.ts";
import { createAccount, makeWorld, randomAddress, usdg, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

function standIn() {
  const seen: { stream: boolean; max_tokens: number }[] = [];
  const counts: unknown[] = [];
  let usage = { input_tokens: 20, output_tokens: 500 };
  let delayMs = 0;
  let running = 0;
  let peak = 0;
  let countAs = 0;
  const app = new Hono();
  app.post("/v1/messages/count_tokens", async (c) => {
    counts.push(await c.req.json());
    return c.json({ input_tokens: countAs });
  });
  app.post("/v1/messages", async (c) => {
    const b = await c.req.json();
    seen.push({ stream: !!b.stream, max_tokens: b.max_tokens });
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, delayMs));
    running--;
    const id = `msg_${seen.length}`;
    if (!b.stream)
      return c.json({ id, type: "message", role: "assistant", model: b.model, content: [{ type: "text", text: "short answer" }], stop_reason: "end_turn", stop_sequence: null, usage });
    return streamSSE(c, async (s) => {
      const ev = (event: string, data: unknown) => s.writeSSE({ event, data: JSON.stringify(data) });
      await ev("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: b.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } });
      await ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      await ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a long " } });
      await ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed answer" } });
      await ev("content_block_stop", { type: "content_block_stop", index: 0 });
      await ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      await ev("message_stop", { type: "message_stop" });
    });
  });
  return {
    app,
    seen,
    counts,
    peak: () => peak,
    resetPeak: () => (peak = 0),
    set: (o: { usage?: typeof usage; delayMs?: number; countAs?: number }) => {
      if (o.usage) usage = o.usage;
      if (o.delayMs !== undefined) delayMs = o.delayMs;
      if (o.countAs !== undefined) countAs = o.countAs;
    },
  };
}

describe("re-test round 3: models at cost", () => {
  let w: World;
  let e: Api;
  let server: ServerType;
  let owner: string;
  let url: string;
  const provider = standIn();
  const company = randomAddress();
  const saved = { url: process.env.PURSER_MODELS_URL, key: process.env.PURSER_MODELS_KEY, payTo: process.env.PURSER_MODELS_PAYTO, topUp: process.env.PURSER_MODELS_TOPUP_MICRO };

  const keyFor = async (safe: Address) => {
    const k = await e.post(`/v1/accounts/${safe}/keys`, { managed: true }, owner);
    const acct = (await e.get(`/v1/accounts/${safe}`)).body;
    await e.post("/v1/testmode/safe-tx", (await e.post(`/v1/accounts/${safe}/rules/prepare`, { config: { ...acct.config, agent: k.body.key.sessionAddress } })).body);
    return k.body.secret as string;
  };
  const ask = async (secret: string, maxTokens: number, content = "Write the report.") => {
    const res = await e.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: "purser/claude-opus-5-5", messages: [{ role: "user", content }], max_tokens: maxTokens }),
    });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    w = await makeWorld();
    e = api(w);
    owner = (await e.post("/v1/testmode/session")).body.token;
    server = serve({ fetch: provider.app.fetch, port: 0 });
    await new Promise((r) => server.once("listening", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.PURSER_MODELS_URL = url;
    process.env.PURSER_MODELS_KEY = "sk-ant-test";
    process.env.PURSER_MODELS_PAYTO = company;
  });
  after(async () => {
    for (const [k, v] of [["PURSER_MODELS_URL", saved.url], ["PURSER_MODELS_KEY", saved.key], ["PURSER_MODELS_PAYTO", saved.payTo], ["PURSER_MODELS_TOPUP_MICRO", saved.topUp]] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    delete process.env.PURSER_MODELS_CONFIRMATIONS;
    delete process.env.PURSER_MODELS_INFLIGHT;
    server?.close();
    await w?.stop();
  });

  it("1. max_tokens 32,000 is answered: the long call is streamed from the provider and charged exactly", async () => {
    // what the reporter hit: the SDK refuses a non-streaming request this long
    await assert.rejects(async () => new Anthropic({ apiKey: "sk-ant-test", baseURL: url }).messages.create({ model: "claude-opus-5-5", max_tokens: 32_000, messages: [{ role: "user", content: "x" }] }), /stream/i);
    const safe = await createAccount(w, { name: "Long writer", fund: usdg(100) });
    const secret = await keyFor(safe);
    provider.set({ usage: { input_tokens: 20, output_tokens: 30_000 } });
    const before = creditMicro(w.ctx, safe);
    const r = await ask(secret, 32_000);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.choices[0].message.content, "a long streamed answer");
    assert.equal(provider.seen.at(-1)!.stream, true);
    assert.equal(r.body.usage.completion_tokens, 30_000);
    const opus = MODELS.find((m) => m.id === "claude-opus-5-5")!;
    assert.equal(r.body.purser.costUsd, usd6(costMicro(opus, 20, 30_000)));
    const topUp = r.body.purser.topUp ? BigInt(Math.round(Number(r.body.purser.topUp.usd) * 1e6)) : 0n;
    assert.equal(creditMicro(w.ctx, safe), before + topUp - costMicro(opus, 20, 30_000), "charged exactly the streamed usage");
    // short calls stay plain requests
    provider.set({ usage: { input_tokens: 20, output_tokens: 500 } });
    assert.equal((await ask(secret, 600)).status, 200);
    assert.equal(provider.seen.at(-1)!.stream, false);
  });

  it("2a. a burst runs at most four calls of one account at once, so a provider count above the bound cannot multiply", async () => {
    const safe = await createAccount(w, { name: "Burst", fund: usdg(100) });
    const secret = await keyFor(safe);
    provider.set({ delayMs: 300, usage: { input_tokens: 400_000, output_tokens: 10 } }); // the reporter's lying provider
    provider.resetPeak();
    const out = await Promise.all(Array.from({ length: 10 }, () => ask(secret, 100)));
    provider.set({ delayMs: 0, usage: { input_tokens: 20, output_tokens: 50 } }); // an honest call, inside its bound
    assert.ok(provider.peak() <= 4, `peak ${provider.peak()} calls at once`);
    const answered = out.filter((r) => r.status === 200).length;
    assert.ok(answered <= 4, `answered ${answered}`);
    assert.ok(out.some((r) => r.status === 429 && r.body.error.code === "too_many_calls"));
    // the gap is bounded by four calls, and the next call pays it back before it runs
    const opus = MODELS.find((m) => m.id === "claude-opus-5-5")!;
    assert.ok(creditMicro(w.ctx, safe) > -4n * costMicro(opus, 400_000, 10), `credit ${creditMicro(w.ctx, safe)}`);
    const next = await ask(secret, 100);
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.ok(creditMicro(w.ctx, safe) >= 0n, "back above zero before the next call ran");
    provider.set({ usage: { input_tokens: 20, output_tokens: 500 } });
  });

  it("2b. a large prompt is counted by the provider, and the reservation is its counted size, not the byte bound", async () => {
    process.env.PURSER_MODELS_TOPUP_MICRO = "1"; // so the top-up equals what the call reserves
    try {
      const safe = await createAccount(w, { name: "Long prompt", fund: usdg(100) });
      const secret = await keyFor(safe);
      const prompt = "Summarise the quarter. ".repeat(4000); // 92,000 bytes
      provider.set({ countAs: 23_000, usage: { input_tokens: 23_000, output_tokens: 500 } });
      const counted = provider.counts.length;
      const r = await ask(secret, 1000, prompt);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(provider.counts.length, counted + 1, "the prompt was counted");
      const opus = MODELS.find((m) => m.id === "claude-opus-5-5")!;
      assert.equal(r.body.purser.topUp.usd, usd6(costMicro(opus, 23_000 + 64, 1000)), "reserved at the counted size");
      assert.ok(creditMicro(w.ctx, safe) >= 0n);
    } finally {
      delete process.env.PURSER_MODELS_TOPUP_MICRO;
      provider.set({ usage: { input_tokens: 20, output_tokens: 500 } });
    }
  });

  it("3. prices match Anthropic's published pricing: only Haiku 5.5 has a long-prompt card, above 100,000 tokens", () => {
    // platform.claude.com/docs/en/about-claude/pricing, read 17 Nov 2026: Opus 5.5 $4 / $20 and Sonnet 5.5 $2 / $10 with the
    // whole 1M context at standard prices; Haiku 5.5 $0.10 / $0.50, and $0.50 / $2.50 for prompts over 100,000 tokens
    const by = (id: string) => MODELS.find((m) => m.id === id)!;
    assert.deepEqual([by("claude-opus-5-5").inputMicroPer1M, by("claude-opus-5-5").outputMicroPer1M, by("claude-opus-5-5").longAbove], [4_000_000, 20_000_000, undefined]);
    assert.deepEqual([by("claude-sonnet-5-5").inputMicroPer1M, by("claude-sonnet-5-5").outputMicroPer1M, by("claude-sonnet-5-5").longAbove], [2_000_000, 10_000_000, undefined]);
    const haiku = by("claude-haiku-5-5");
    assert.deepEqual([haiku.inputMicroPer1M, haiku.outputMicroPer1M, haiku.longAbove, haiku.longInputMicroPer1M, haiku.longOutputMicroPer1M], [100_000, 500_000, 100_000, 500_000, 2_500_000]);
    assert.equal(costMicro(haiku, 100_000, 1000), 10_500n, "at 100,000 tokens: the standard card");
    assert.equal(costMicro(haiku, 100_001, 1000), 52_501n, "over 100,000 tokens: the long card for input and output");
  });

  it("4. a top-up is credited after the configured number of confirmations (default 1)", async () => {
    const safe = await createAccount(w, { name: "Careful credit" });
    const key = (await e.post(`/v1/accounts/${safe}/keys`, { managed: true }, owner)).body;
    const acct = (await e.get(`/v1/accounts/${safe}`)).body;
    await e.post("/v1/testmode/safe-tx", (await e.post(`/v1/accounts/${safe}/rules/prepare`, { config: { ...acct.config, agent: key.key.sessionAddress } })).body);
    process.env.PURSER_MODELS_CONFIRMATIONS = "3";
    try {
      const pay = await e.post("/v1/pay", { to: company, amount: usdg(1).toString(), service: CREDIT_SERVICE }, key.secret);
      assert.equal(pay.body.intent.status, "executed");
      assert.equal(creditMicro(w.ctx, safe), 0n, "one confirmation is not three");
      await w.rpc("anvil_mine", ["0x2"]);
      await reconcileTopUps(w.ctx);
      assert.equal(creditMicro(w.ctx, safe), 1_000_000n, "credited at three");
    } finally {
      delete process.env.PURSER_MODELS_CONFIRMATIONS;
    }
  });
});
