import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApp } from "../src/api/app.ts";
import "../src/features.ts";
import { makeOfflineEngine } from "./harness.ts";

/** Reads the SSE stream for a moment and returns what arrived. */
async function readFor(res: Response, ms: number): Promise<string> {
  const reader = res.body!.getReader();
  let text = "";
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), end - Date.now()))]);
    if (!chunk || chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  await reader.cancel().catch(() => {});
  return text;
}

describe("live events (SSE)", () => {
  it("a fresh connection starts from now; since= or Last-Event-ID replays the kept events", async () => {
    const engine = makeOfflineEngine();
    const app = buildApp(engine.ctx);
    engine.ctx.bus.emit("receipt", null, { n: 1 });
    engine.ctx.bus.emit("verdict", null, { n: 2 });

    const fresh = await readFor(await app.request("/v1/events"), 300);
    assert.doesNotMatch(fresh, /event: receipt|event: verdict/, "no replay without since");

    const replay = await readFor(await app.request("/v1/events?since=0"), 300);
    assert.match(replay, /event: receipt/);
    assert.match(replay, /event: verdict/);

    const after1 = await readFor(await app.request("/v1/events", { headers: { "last-event-id": "1" } }), 300);
    assert.doesNotMatch(after1, /event: receipt/);
    assert.match(after1, /event: verdict/);

    const filtered = await readFor(await app.request("/v1/events?since=0&types=verdict"), 300);
    assert.doesNotMatch(filtered, /event: receipt/);
    assert.match(filtered, /event: verdict/);
    engine.ctx.db.close();
  });
});
