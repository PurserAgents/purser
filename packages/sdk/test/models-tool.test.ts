import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Hono } from "../../../engine/node_modules/hono/dist/index.js";
import { serve, type ServerType } from "../../../engine/node_modules/@hono/node-server/dist/index.mjs";
import { buildApp } from "../../../engine/src/api/app.ts";
import "../../../engine/src/features.ts";
import { openTestAgent } from "../../../engine/src/seed.ts";
import { startWorld, type World } from "../../../engine/src/world.ts";
import { Purser, purserTools, runPurserTool } from "../src/all.ts";

process.env.PURSER_LOG = "0";

describe("purser_ask_model: an agent asks a model and pays the provider's price", () => {
  let world: World;
  let engine: ServerType;
  let provider: ServerType;
  let url: string;
  let apiKey: string;
  const asked: any[] = [];

  before(async () => {
    const fake = new Hono();
    fake.post("/v1/messages", async (c) => {
      const b = await c.req.json();
      asked.push(b);
      return c.json({ id: "msg_1", type: "message", role: "assistant", model: b.model, content: [{ type: "text", text: `Answer from ${b.model}` }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 500 } });
    });
    provider = serve({ fetch: fake.fetch, port: 0 });
    await new Promise((r) => provider.once("listening", r));
    process.env.PURSER_MODELS_URL = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    process.env.PURSER_MODELS_KEY = "sk-ant-test";
    process.env.PURSER_MODELS_PAYTO = "0x000000000000000000000000000000000000c0de";
    world = await startWorld({});
    engine = serve({ fetch: buildApp(world.engine.ctx).fetch, port: 0 });
    await new Promise((r) => engine.once("listening", r));
    url = `http://127.0.0.1:${(engine.address() as { port: number }).port}`;
    apiKey = (await openTestAgent(world.engine.ctx, "Model agent", "research", 50_000_000n)).apiKey;
  });
  after(async () => {
    for (const k of ["PURSER_MODELS_URL", "PURSER_MODELS_KEY", "PURSER_MODELS_PAYTO"]) delete process.env[k];
    engine?.close();
    provider?.close();
    await world?.stop();
  });

  it("answers with the cheapest model for the level and says what it cost", async () => {
    const t = purserTools(new Purser({ baseUrl: url, apiKey }), { only: ["purser_ask_model"] })[0];
    const out = await runPurserTool(t, { prompt: "Summarise the report", level: "fast", system: "Be brief." });
    assert.match(out, /^Answer from claude-haiku-5-5/);
    assert.match(out, /Claude Haiku 5\.5, \$0\.000350 at the provider's price/);
    assert.equal(asked.at(-1).system, "Be brief.");
    const best = await runPurserTool(t, { prompt: "Plan the launch", level: "best" });
    assert.match(best, /Claude Opus 5\.5, \$0\.014000/);
  });

  it("the public price list needs no key", async () => {
    const p = await new Purser({ baseUrl: url }).atCost.prices();
    assert.equal(p.items.length, 3);
    assert.ok(p.items.every((x) => x.markup === "0"));
  });
});
