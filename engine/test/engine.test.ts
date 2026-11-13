import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Hono } from "hono";
import { z } from "zod";
import { body, onError, send, zAddr, zAmount, zBytes32 } from "../src/api/http.ts";
import { chainNow, requireDep } from "../src/ctx.ts";
import { registerTask } from "../src/engine.ts";
import { ApiFailure, fail } from "../src/util.ts";
import { makeOfflineEngine, type World } from "./harness.ts";
import { api } from "./util-api.ts";

describe("engine shell: tasks, context, HTTP plumbing (offline engine)", () => {
  const engine = makeOfflineEngine();
  const ctx = engine.ctx;
  after(() => {
    engine.stop();
    ctx.db.close();
  });

  it("runs registered tasks on tick, once per name, and a failing task never stops the others", async () => {
    let runs = 0;
    let after_ = 0;
    registerTask({ name: "test:count", every: 60_000, run: async () => void runs++ });
    registerTask({ name: "test:count", every: 60_000, run: async () => void (runs += 100) }); // same name: ignored
    registerTask({ name: "test:boom", every: 60_000, run: async () => { throw new Error("task failed"); } });
    registerTask({ name: "test:after", every: 60_000, run: async () => void after_++ });
    await engine.tick();
    assert.equal(runs, 1);
    assert.equal(after_, 1, "tasks after a failing one still run");
    await engine.tick();
    assert.equal(runs, 2);
  });

  it("start schedules the tasks and stop clears them", async () => {
    let n = 0;
    registerTask({ name: "test:fast", every: 10, run: async () => void n++ });
    const e = makeOfflineEngine();
    e.start();
    await new Promise((r) => setTimeout(r, 60));
    e.stop();
    const seen = n;
    assert.ok(seen >= 2, `ran ${seen} times`);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(n, seen, "nothing runs after stop");
    e.ctx.db.close();
  });

  it("keeps the audit key it generated when the config has none", () => {
    const row = ctx.db.prepare("SELECT value FROM kv WHERE key = 'audit_key'").get() as { value: string };
    assert.match(row.value, /^0x[0-9a-f]{64}$/);
    assert.match(ctx.audit.signer, /^0x[0-9a-fA-F]{40}$/);
  });

  it("without a deployment, features answer 503; with the node down, the clock falls back to the wall clock", async () => {
    assert.throws(() => requireDep(ctx), (e: unknown) => e instanceof ApiFailure && e.status === 503);
    const t = await chainNow(ctx);
    assert.ok(Math.abs(t - Date.now() / 1000) < 5);
    const a = api({ ctx } as World);
    const cfg = await a.get("/v1/config");
    assert.equal(cfg.status, 503);
    assert.equal(cfg.body.error.code, "no_deployment");
    const h = await a.get("/v1/health");
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, false);
    assert.equal(h.body.block, null);
    assert.equal(h.body.mode, "readonly");
    assert.equal(h.body.broadcast, false);
    assert.equal(h.body.contracts.module, null);
  });

  it("unknown endpoints are 404 in JSON; test-mode and demo endpoints do not exist outside test mode", async () => {
    const a = api({ ctx } as World);
    const r = await a.get("/v1/nothing-here");
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: { code: "not_found", message: "No such endpoint." } });
    assert.equal((await a.post("/v1/testmode/session")).status, 404);
    assert.equal((await a.post("/v1/testmode/accounts", {})).status, 404);
    assert.equal((await a.post("/v1/demo/firewall/run", { paceMs: 0 })).status, 404);
    const last = await a.get("/v1/demo/firewall");
    assert.equal(last.status, 200);
    assert.deepEqual(last.body.steps, []);
    const pre = await a.app.request("/v1/health", { method: "OPTIONS", headers: { origin: "https://purseragents.fun", "access-control-request-method": "GET" } });
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  });

  it("bodies: bad JSON and schema errors are 400 with the field named; errors map to status and code", async () => {
    const app = new Hono();
    app.onError(onError);
    app.post("/x", async (c) => send(c, await body(c, z.object({ to: zAddr, amount: zAmount, id: zBytes32.optional() }))));
    app.get("/conflict", () => fail(409, "busy", "Already running."));
    app.get("/boom", () => {
      throw new Error("database is locked\nat line 1");
    });
    const post = async (b: string) => {
      const r = await app.request("/x", { method: "POST", body: b });
      return { status: r.status, body: await r.json() };
    };
    const to = "0xABCDEF0000000000000000000000000000000001";
    let r = await post(JSON.stringify({ to, amount: 5 }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { to: to.toLowerCase(), amount: "5" }, "addresses lowercased, amounts as strings");
    assert.equal((await post(JSON.stringify({ to, amount: "1000000000000000000000000" }))).body.amount, "1000000000000000000000000");
    r = await post("{nope");
    assert.deepEqual([r.status, r.body.error.code], [400, "bad_json"]);
    r = await post(JSON.stringify({ to: "0x12", amount: 1 }));
    assert.deepEqual([r.status, r.body.error.code], [400, "bad_request"]);
    assert.match(r.body.error.message, /^to: must be a 0x address/);
    for (const bad of [-1, 1.5, "1.5", "abc", "-3"]) assert.equal((await post(JSON.stringify({ to, amount: bad }))).status, 400, `amount ${bad}`);
    assert.equal((await post(JSON.stringify({ to, amount: 1, id: "0x12" }))).status, 400);
    r = await post("");
    assert.match(r.body.error.message, /^to: /, "an empty body is an empty object");
    const c = await app.request("/conflict");
    assert.equal(c.status, 409);
    assert.deepEqual(await c.json(), { error: { code: "busy", message: "Already running." } });
    const b = await app.request("/boom");
    assert.equal(b.status, 500);
    assert.deepEqual(await b.json(), { error: { code: "internal", message: "database is locked" } }, "first line only");
  });
});
