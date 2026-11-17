// Regression for HEY Research Lab's M-6: a listing price (or invoice amount) of any length, printed with a quadratic
// thousands separator, blocked the single-process engine for seconds per listing search. Amounts are now at most
// 78 digits (2^256 - 1), listing prices and invoice amounts at most 2^128 - 1, the separator is linear, request
// bodies are at most 2 MB, and rows stored before are clamped at startup. Local chain only (anvil).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MAX_BODY } from "../src/api/app.ts";
import { clampStoredAmounts } from "../src/limits.ts";
import { fmt, MAX_U128 } from "../src/util.ts";
import { createAccount, makeWorld, randomAddress, type World } from "./harness.ts";
import { createApiKey } from "../src/keys.ts";
import { api, type Api } from "./util-api.ts";

describe("M-6: amounts are bounded and printing them is linear", () => {
  let w: World;
  let e: Api;
  let seller: string;
  let safe: string;

  before(async () => {
    w = await makeWorld();
    e = api(w);
    safe = await createAccount(w, { name: "Seller" });
    seller = createApiKey(w.ctx, { safe, scopes: ["sell", "invoices", "read"] }).secret;
  });
  after(async () => w?.stop());

  it("fmt puts in the separators in one pass: a 60,000 digit number prints in milliseconds", () => {
    assert.equal(fmt(1_234_567_000_000n, 6), "1,234,567.00");
    assert.equal(fmt(-1_234_567_000_000n, 6), "-1,234,567.00");
    assert.equal(fmt(999_000_000n, 6), "999.00");
    assert.equal(fmt(1_000n * 10n ** 6n, 6), "1,000.00");
    const big = 10n ** 60_000n;
    const t = performance.now();
    const s = fmt(big, 6);
    assert.ok(performance.now() - t < 200, `took ${performance.now() - t} ms`);
    assert.equal(s.length, 60_001 - 6 + Math.floor((60_001 - 6 - 1) / 3) + 3);
  });

  it("the API refuses a price above 2^128 - 1 and any amount over 78 digits", async () => {
    const huge = "9".repeat(60_000);
    const l = await e.post("/v1/market/listings", { title: "Huge", price: huge, deliverySeconds: 600 }, seller);
    assert.equal(l.status, 400, JSON.stringify(l.body).slice(0, 200));
    const over128 = (MAX_U128 + 1n).toString();
    assert.equal((await e.post("/v1/market/listings", { title: "Just over", price: over128, deliverySeconds: 600 }, seller)).status, 400);
    assert.equal((await e.post("/v1/market/listings", { title: "At the limit", price: MAX_U128.toString(), deliverySeconds: 600 }, seller)).status, 201);
    assert.equal((await e.post("/v1/invoices", { payer: randomAddress(), amount: over128, description: "x", deadlineSeconds: 3600 }, seller)).status, 400);
    assert.equal((await e.post("/v1/storefront/services", { name: "Huge", price: huge, response: "{}" }, seller)).status, 400);
    const payKey = createApiKey(w.ctx, { safe, scopes: ["pay"] }).secret;
    assert.equal((await e.post("/v1/pay", { to: randomAddress(), amount: "1".repeat(79) }, payKey)).status, 400, "79 digits anywhere");
  });

  it("a request body over 2 MB is refused before it is read", async () => {
    const res = await e.app.request("/v1/market/listings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${seller}`, "content-length": String(MAX_BODY + 1) },
      body: JSON.stringify({ title: "x".repeat(MAX_BODY), price: "1", deliverySeconds: 600 }),
    });
    assert.equal(res.status, 413);
  });

  it("rows stored before the limit are clamped at startup, and searching stays fast", async () => {
    const now = Math.floor(Date.now() / 1000);
    const huge = "9".repeat(60_000);
    w.ctx.db
      .prepare("INSERT INTO listings (id, seller, title, description, token, price, delivery_seconds, review_seconds, arbiter, service_id, tags, active, created_at, updated_at) VALUES ('lst_old', ?, 'Old huge', '', ?, ?, 600, 600, NULL, NULL, '[]', 1, ?, ?)")
      .run(safe.toLowerCase(), w.dep.usdg.toLowerCase(), huge, now, now);
    w.ctx.db.prepare("INSERT INTO invoices (id, payee, payer, arbiter, token, amount, description, deadline, review_period, status, created_at, updated_at) VALUES ('inv_old', ?, ?, NULL, ?, ?, 'old', ?, 600, 'open', ?, ?)").run(safe.toLowerCase(), randomAddress().toLowerCase(), w.dep.usdg.toLowerCase(), huge, now + 3600, now, now);
    const n = clampStoredAmounts(w.ctx.db);
    assert.equal(n.listings, 1);
    assert.equal(n.invoices, 1);
    const l = w.ctx.db.prepare("SELECT price, active FROM listings WHERE id = 'lst_old'").get() as { price: string; active: number };
    assert.deepEqual(l, { price: MAX_U128.toString(), active: 0 });
    assert.equal((w.ctx.db.prepare("SELECT amount FROM invoices WHERE id = 'inv_old'").get() as { amount: string }).amount, MAX_U128.toString());
    const t = performance.now();
    assert.equal((await e.get(`/v1/accounts/${safe}/listings`)).status, 200);
    assert.equal((await e.get("/v1/invoices")).status, 200);
    assert.ok(performance.now() - t < 1000);
    assert.deepEqual(clampStoredAmounts(w.ctx.db), {}, "nothing left to clamp");
  });
});
