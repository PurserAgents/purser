import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { EngineEvent } from "../../packages/sdk/src/schema.ts";
import { getIntentRow, getReceipt, insertReceipt, intentFromRow, listReceipts, setIntent } from "../src/receipts.ts";
import { makeOfflineEngine, randomAddress, type World } from "./harness.ts";
import { api } from "./util-api.ts";

describe("receipts and intent rows (offline engine)", () => {
  const engine = makeOfflineEngine();
  const ctx = engine.ctx;
  const safe = randomAddress();
  const other = randomAddress();
  const token = "0x00000000000000000000000000000000000000aa";
  after(() => ctx.db.close());

  it("writes a receipt once per chain log and announces it on the bus", () => {
    const seen: EngineEvent[] = [];
    const off = ctx.bus.subscribe((e) => e.type === "receipt" && seen.push(e));
    const r = insertReceipt(ctx, { uniq: "0xtx:1", safe, direction: "out", category: "model", token, amount: 1_500_000n, fee: 1_500n, counterparty: other, memo: "call", model: { provider: "p", model: "m", promptTokens: 1, completionTokens: 2 } as never, createdAt: 1_000 });
    assert.ok(r);
    assert.equal(r!.safe, safe.toLowerCase());
    assert.equal(r!.counterparty, other.toLowerCase());
    assert.equal(r!.money.amount, "1500000");
    assert.equal(r!.fee!.amount, "1500");
    assert.equal(r!.status, "executed");
    assert.equal((r!.model as any).model, "m");
    assert.equal(insertReceipt(ctx, { uniq: "0xtx:1", safe, direction: "out", category: "model", token, amount: 1n, counterparty: other }), null, "the same log never makes a second receipt");
    off();
    assert.equal(seen.length, 1);
    assert.equal(getReceipt(ctx, r!.id)!.memo, "call");
    assert.equal(getReceipt(ctx, "rcp_missing"), null);
  });

  it("names the counterparty when it is a known account", () => {
    ctx.db.prepare("INSERT INTO accounts (safe, name, created_at) VALUES (?, ?, 0)").run(other.toLowerCase(), "Quill");
    const r = insertReceipt(ctx, { safe, direction: "out", category: "internal", token, amount: 2n, counterparty: other, createdAt: 2_000 });
    assert.equal(r!.counterpartyName, "Quill");
    assert.equal(r!.fee, null);
  });

  it("filters by account, direction and category; pages newest first with a cursor; caps the page at 200", () => {
    for (let i = 0; i < 5; i++) insertReceipt(ctx, { safe, direction: i % 2 ? "in" : "out", category: "transfer", token, amount: BigInt(i + 1), counterparty: other, createdAt: 3_000 + i });
    insertReceipt(ctx, { safe: other, direction: "in", category: "transfer", token, amount: 9n, counterparty: safe, createdAt: 9_000 });
    const all = listReceipts(ctx, { safe });
    assert.equal(all.items.length, 7);
    assert.ok(all.items.every((x) => x.safe === safe.toLowerCase()));
    assert.deepEqual(all.items.slice(0, 3).map((x) => x.createdAt), [3_004, 3_003, 3_002]);
    assert.equal(all.next, null);
    assert.equal(listReceipts(ctx, { safe, direction: "in" }).items.length, 2);
    assert.equal(listReceipts(ctx, { safe, category: "model" }).items.length, 1);
    const page1 = listReceipts(ctx, { safe, limit: 3 });
    assert.equal(page1.items.length, 3);
    assert.equal(page1.next, "3002");
    const page2 = listReceipts(ctx, { safe, limit: 3, before: Number(page1.next) });
    assert.deepEqual(page2.items.map((x) => x.createdAt), [3_001, 3_000, 2_000]);
    assert.equal(listReceipts(ctx, {}).items[0].createdAt, 9_000, "all accounts");
    for (let i = 0; i < 205; i++) insertReceipt(ctx, { safe, direction: "out", category: "transfer", token, amount: 1n, counterparty: other, createdAt: 10 });
    const capped = listReceipts(ctx, { safe, limit: 1000 });
    assert.equal(capped.items.length, 200);
    assert.ok(capped.next);
  });

  it("setIntent updates the row and emits it; an unknown id changes nothing", () => {
    ctx.db.prepare("INSERT INTO intents (id, safe, kind, digest, payload, status, summary, token, amount, to_addr, category, created_at, updated_at) VALUES ('int_1', ?, 'pay', '0xd', '{}', 'checking', 'Pay', ?, '5', ?, 'transfer', 1, 1)").run(safe.toLowerCase(), token, other.toLowerCase());
    const seen: EngineEvent[] = [];
    const off = ctx.bus.subscribe((e) => e.type === "intent" && seen.push(e));
    const i = setIntent(ctx, "int_1", { status: "blocked", error: "Blocked: test" })!;
    assert.equal(i.status, "blocked");
    assert.equal(i.error, "Blocked: test");
    assert.equal(i.money!.amount, "5");
    assert.equal(getIntentRow(ctx, "int_1")!.status, "blocked");
    assert.equal(setIntent(ctx, "int_missing", { status: "executed" }), undefined);
    off();
    assert.equal(seen.length, 1);
    const noMoney = intentFromRow(ctx, { ...getIntentRow(ctx, "int_1")!, token: null, amount: null });
    assert.equal(noMoney.money, null);
  });

  it("over the API: unknown receipts and intents are 404, a bad account address is 400", async () => {
    const a = api({ ctx } as World);
    assert.equal((await a.get("/v1/receipts/rcp_missing")).status, 404);
    assert.equal((await a.get("/v1/intents/int_missing")).status, 404);
    assert.equal((await a.get("/v1/accounts/0x123/receipts")).status, 400);
    const page = await a.get(`/v1/accounts/${safe}/receipts?direction=in&limit=1`);
    assert.equal(page.status, 200);
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.items[0].direction, "in");
    assert.equal((await a.get(`/v1/accounts/${safe}/intents?status=blocked`)).body.items[0].id, "int_1");
  });
});
