import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApp } from "../src/api/app.ts";
import "../src/features.ts";
import { freePort, startNode, startWorld } from "../src/world.ts";

describe("test-mode world: a local node, a deployment and an engine", () => {
  it("freePort hands out a usable port", async () => {
    const p = await freePort();
    assert.ok(Number.isInteger(p) && p > 0 && p < 65536);
  });

  it("startNode starts anvil on the given port with chain id 4663, and stop ends it", async () => {
    const port = await freePort();
    const node = await startNode({ port });
    try {
      assert.equal(node.url, `http://127.0.0.1:${port}`);
      const r = await fetch(node.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      assert.equal((await r.json()).result, "0x1237");
    } finally {
      await node.stop();
    }
    assert.notEqual(node.proc.exitCode ?? node.proc.signalCode, null, "the process has exited");
    await node.stop(); // stopping twice is harmless
  });

  it("startWorld deploys and serves a test-mode engine without writing any files; stop closes everything", async () => {
    const world = await startWorld({ publicUrl: "http://engine.test" });
    let stopped = false;
    try {
      assert.equal(world.cfg.testMode, true);
      assert.equal(world.cfg.dbPath, ":memory:");
      assert.equal(world.cfg.publicUrl, "http://engine.test");
      assert.deepEqual(world.cfg.rpcUrls, [world.node.url]);
      assert.equal(world.dep.mode, "local");
      assert.ok(world.keys.owner && world.keys.agent);
      const app = buildApp(world.engine.ctx);
      const h = await (await app.request("/v1/health")).json();
      assert.equal(h.ok, true);
      assert.equal(h.broadcast, true);
      assert.equal(h.contracts.module, world.dep.module);
      const s = await app.request("/v1/testmode/session", { method: "POST" });
      assert.equal(s.status, 200, "test-mode routes exist");
      await world.stop();
      stopped = true;
      assert.notEqual(world.node.proc.exitCode ?? world.node.proc.signalCode, null);
      assert.equal(world.engine.ctx.db.open, false);
    } finally {
      if (!stopped) await world.stop();
    }
  });
});
