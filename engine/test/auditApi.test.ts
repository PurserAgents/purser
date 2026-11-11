import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseExport } from "../src/auditApi.ts";
import { makeOfflineEngine, randomAddress, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("audit API: list, key, export, verify (offline engine)", () => {
  const engine = makeOfflineEngine();
  const ctx = engine.ctx;
  let a: Api;
  const safe = randomAddress();
  before(async () => {
    a = api({ ctx } as World);
    await ctx.audit.append("owner", "key.created", safe, { key: "key_1" });
    await ctx.audit.append("engine", "demo.firewall", null, { steps: 7 });
    await ctx.audit.append("firewall", "intent.blocked", safe, { intent: "int_1" });
  });
  after(() => ctx.db.close());

  const exportText = async () => (await a.app.request("/v1/audit/export")).text();
  const verify = async (text: string, signer?: string) => {
    const r = await a.app.request(`/v1/audit/verify${signer ? `?signer=${signer}` : ""}`, { method: "POST", body: text });
    return { status: r.status, body: await r.json() };
  };

  it("parseExport reads JSON Lines or a JSON array, and nothing from an empty body", () => {
    assert.deepEqual(parseExport(""), []);
    assert.deepEqual(parseExport("  \n "), []);
    assert.deepEqual(parseExport('{"seq":1}\n\n{"seq":2}\n'), [{ seq: 1 }, { seq: 2 }] as never);
    assert.deepEqual(parseExport('[{"seq":1}]'), [{ seq: 1 }] as never);
    assert.throws(() => parseExport("{broken"));
  });

  it("lists newest first, filters by account, pages with before and limit", async () => {
    const all = await a.get("/v1/audit");
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.items.map((e: any) => e.seq), [3, 2, 1]);
    assert.equal(all.body.signer, ctx.audit.signer);
    const mine = await a.get(`/v1/audit?safe=${safe.toUpperCase().replace("0X", "0x")}`);
    assert.deepEqual(mine.body.items.map((e: any) => e.action), ["intent.blocked", "key.created"]);
    assert.deepEqual((await a.get("/v1/audit?limit=1")).body.items.map((e: any) => e.seq), [3]);
    assert.deepEqual((await a.get("/v1/audit?before=3&limit=5")).body.items.map((e: any) => e.seq), [2, 1]);
    const key = await a.get("/v1/audit/key");
    assert.equal(key.body.signer, ctx.audit.signer);
    assert.match(key.body.scheme, /keccak256/);
  });

  it("exports JSON Lines as a download that verifies as is", async () => {
    const r = await a.app.request("/v1/audit/export");
    assert.equal(r.headers.get("content-type"), "application/x-ndjson");
    assert.match(r.headers.get("content-disposition")!, /^attachment; filename="purser-audit-\d+\.jsonl"$/);
    const text = await r.text();
    assert.equal(text.trim().split("\n").length, 3);
    const v = await verify(text);
    assert.equal(v.status, 200);
    assert.deepEqual(v.body, { ok: true, entries: 3, signer: ctx.audit.signer, brokenAt: null, problem: null });
    const asArray = await verify(JSON.stringify(parseExport(text)));
    assert.equal(asArray.body.ok, true);
    assert.equal((await verify("")).body.entries, 0);
  });

  it("a body that is not an export is 400", async () => {
    const v = await verify("this is not json");
    assert.equal(v.status, 400);
    assert.equal(v.body.error.code, "bad_export");
  });

  it("finds an edited entry, a removed entry and a reordered chain", async () => {
    const lines = (await exportText()).trim().split("\n").map((l) => JSON.parse(l));
    const edited = lines.map((e, i) => (i === 1 ? { ...e, data: { steps: 8 } } : e));
    let v = await verify(edited.map((e) => JSON.stringify(e)).join("\n"));
    assert.deepEqual([v.body.ok, v.body.brokenAt], [false, 2]);
    assert.match(v.body.problem, /changed after it was written/);
    v = await verify([lines[0], lines[2]].map((e) => JSON.stringify(e)).join("\n"));
    assert.deepEqual([v.body.ok, v.body.brokenAt], [false, 3]);
    assert.match(v.body.problem, /missing or out of order/);
    const relinked = lines.map((e, i) => (i === 2 ? { ...e, prevHash: lines[0].hash } : e));
    v = await verify(relinked.map((e) => JSON.stringify(e)).join("\n"));
    assert.match(v.body.problem, /does not link/);
  });

  it("an export signed by another key fails against this engine's signer, and passes against its own", async () => {
    const other = makeOfflineEngine();
    await other.ctx.audit.append("engine", "x", null, {});
    const foreign = other.ctx.audit.exportAll().map((e) => JSON.stringify(e)).join("\n");
    const v = await verify(foreign);
    assert.equal(v.body.ok, false);
    assert.match(v.body.problem, /signed by another key/);
    assert.equal((await verify(foreign, other.ctx.audit.signer)).body.ok, true);
    assert.equal((await verify(await exportText(), privateKeyToAccount(generatePrivateKey()).address)).body.ok, false);
    other.ctx.db.close();
  });
});
