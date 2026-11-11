import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import type { EngineEvent } from "../../packages/sdk/src/schema.ts";
import { issueOwnerSession } from "../src/keys.ts";
import { deliver, enqueue, signPayload, WEBHOOK_EVENTS, webhookType } from "../src/webhooks.ts";
import { freePort, makeOfflineEngine, randomAddress, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

const ev = (type: string, data: unknown, safe: string | null = null) => ({ id: 1, type, safe, ts: 0, data }) as EngineEvent;

describe("webhook signatures and event mapping (pure)", () => {
  it("signs t.<body> with HMAC-SHA256 under the webhook secret", () => {
    const sig = signPayload("whsec_x", '{"a":1}', 1700000000);
    const expected = createHmac("sha256", "whsec_x").update('1700000000.{"a":1}').digest("hex");
    assert.equal(sig, `t=1700000000,v1=${expected}`);
    assert.notEqual(signPayload("whsec_y", '{"a":1}', 1700000000), sig, "another secret, another signature");
    assert.notEqual(signPayload("whsec_x", '{"a":2}', 1700000000), sig, "another body, another signature");
    assert.match(signPayload("s", "b"), /^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("maps engine events to the webhook events subscribers choose", () => {
    assert.equal(webhookType(ev("receipt", { money: {} })), "receipt.created");
    assert.equal(webhookType(ev("receipt", { event: "storefront.use" })), null, "a usage note is not a receipt");
    assert.equal(webhookType(ev("intent", { status: "blocked", event: "blocked" })), "intent.blocked");
    assert.equal(webhookType(ev("intent", { status: "blocked" })), null, "a dry-run block is not sent");
    assert.equal(webhookType(ev("intent", { status: "queued" })), "intent.queued");
    assert.equal(webhookType(ev("intent", { status: "executed" })), "intent.executed");
    assert.equal(webhookType(ev("intent", { status: "checking" })), null);
    assert.equal(webhookType(ev("approval", { event: "approved" })), "approval.decided");
    assert.equal(webhookType(ev("approval", { event: "rejected" })), "approval.decided");
    assert.equal(webhookType(ev("approval", { event: "queued" })), "intent.queued");
    assert.equal(webhookType(ev("watchdog", {})), "watchdog.alert");
    assert.equal(webhookType(ev("account", { event: "frozen" })), "account.frozen");
    assert.equal(webhookType(ev("account", { event: "unfrozen" })), "account.unfrozen");
    assert.equal(webhookType(ev("account", { event: "config" })), null);
    assert.equal(webhookType(ev("invoice", {})), "invoice.updated");
    assert.equal(webhookType(ev("stream", {})), "stream.updated");
    assert.equal(webhookType(ev("subscription", {})), "stream.updated");
    assert.equal(webhookType(ev("alert", {})), "alert");
    assert.equal(webhookType(ev("demo", {})), null);
    for (const t of WEBHOOK_EVENTS) assert.match(t, /^[a-z.]+$/);
  });
});

describe("webhook delivery: per-account filter, retries with backoff, delivery log (offline engine, local receiver)", () => {
  const engine = makeOfflineEngine();
  const ctx = engine.ctx;
  let a: Api;
  let receiver: Server;
  let okUrl: string;
  let failUrl: string;
  let deadUrl: string;
  const got: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const wallet = randomAddress();
  let token: string;
  const safeA = randomAddress();
  const safeB = randomAddress();

  before(async () => {
    a = api({ ctx } as World);
    token = issueOwnerSession(ctx, wallet).token;
    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        got.push({ path: req.url!, headers: req.headers, body });
        res.writeHead(req.url === "/fail" ? 500 : 200).end("ok");
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    const port = (receiver.address() as { port: number }).port;
    okUrl = `http://127.0.0.1:${port}/ok`;
    failUrl = `http://127.0.0.1:${port}/fail`;
    deadUrl = `http://127.0.0.1:${await freePort()}/`;
  });
  after(() => {
    receiver?.close();
    ctx.db.close();
  });

  const pendingFor = (hook: string) => ctx.db.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at, rowid").all(hook) as { id: string; status: string; attempts: number; response_code: number | null; event: string; body: string }[];

  it("creating a webhook needs an owner session and valid input", async () => {
    assert.equal((await a.post("/v1/webhooks", { url: okUrl, events: ["alert"] })).status, 401);
    assert.equal((await a.post("/v1/webhooks", { url: "ftp://example.com/x", events: ["alert"] }, token)).status, 400);
    assert.equal((await a.post("/v1/webhooks", { url: "not a url", events: ["alert"] }, token)).status, 400);
    assert.equal((await a.post("/v1/webhooks", { url: okUrl, events: [] }, token)).status, 400);
    assert.equal((await a.post("/v1/webhooks", { url: okUrl, events: ["everything"] }, token)).status, 400);
    assert.equal((await a.post("/v1/webhooks", { url: okUrl, events: ["alert"], safe: "0x12" }, token)).status, 400);
    const bad = await a.app.request("/v1/webhooks", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{oops" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "bad_json");
  });

  it("delivers a signed body only to hooks that want the event and the account", async () => {
    const forA = await a.post("/v1/webhooks", { url: okUrl, events: ["receipt.created", "alert"], safe: safeA }, token);
    assert.equal(forA.status, 201, JSON.stringify(forA.body));
    assert.match(forA.body.secret, /^whsec_/);
    const all = await a.post("/v1/webhooks", { url: okUrl, events: ["receipt.created"] }, token);
    const idA = forA.body.webhook.id;
    const idAll = all.body.webhook.id;

    enqueue(ctx, "receipt.created", safeA.toUpperCase().replace("0X", "0x"), { amount: 5n });
    enqueue(ctx, "receipt.created", safeB, { amount: 6n });
    enqueue(ctx, "intent.blocked", safeA, {});
    assert.equal(pendingFor(idA).length, 1, "A's hook gets only A's receipt");
    assert.equal(pendingFor(idAll).length, 2, "the account-wide hook gets both");

    got.length = 0;
    assert.equal(await deliver(ctx), 3);
    assert.equal(got.length, 3);
    const toA = got.find((g) => g.headers["purser-delivery"] === pendingFor(idA)[0].id)!;
    assert.equal(toA.headers["purser-event"], "receipt.created");
    const body = JSON.parse(toA.body);
    assert.equal(body.type, "receipt.created");
    assert.equal(body.data.amount, "5", "bigints arrive as strings");
    const [tPart, vPart] = String(toA.headers["purser-signature"]).split(",");
    const t = tPart.slice(2);
    assert.equal(vPart.slice(3), createHmac("sha256", forA.body.secret).update(`${t}.${toA.body}`).digest("hex"), "receiver can check the signature");
    assert.deepEqual(pendingFor(idA).map((d) => [d.status, d.attempts, d.response_code]), [["delivered", 1, 200]]);
    assert.equal(await deliver(ctx), 0, "nothing is sent twice");
  });

  it("the bus feeds webhooks: an engine event becomes a delivery", async () => {
    const h = await a.post("/v1/webhooks", { url: okUrl, events: ["account.frozen"], safe: safeB }, token);
    ctx.bus.emit("account", safeB, { event: "frozen", by: wallet });
    ctx.bus.emit("account", safeA, { event: "frozen", by: wallet });
    const rows = pendingFor(h.body.webhook.id);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].body).data.event, "frozen");
    await deliver(ctx);
  });

  it("retries a failing receiver after 5 s, 30 s and 2 min, then marks it failed", async () => {
    const h = await a.post("/v1/webhooks", { url: failUrl, events: ["alert"] }, token);
    const hid = h.body.webhook.id;
    enqueue(ctx, "alert", null, { kind: "spend_over" });
    await deliver(ctx);
    let d = pendingFor(hid)[0];
    assert.deepEqual([d.status, d.attempts, d.response_code], ["pending", 1, 500]);
    await deliver(ctx);
    assert.equal(pendingFor(hid)[0].attempts, 1, "waits for the backoff before the second try");
    const age = (s: number) => ctx.db.prepare("UPDATE webhook_deliveries SET created_at = created_at - ? WHERE id = ?").run(s, d.id);
    age(6);
    await deliver(ctx);
    assert.equal(pendingFor(hid)[0].attempts, 2);
    age(25);
    await deliver(ctx);
    assert.equal(pendingFor(hid)[0].attempts, 3);
    age(100);
    await deliver(ctx);
    d = pendingFor(hid)[0];
    assert.deepEqual([d.status, d.attempts], ["failed", 4]);
    age(10_000);
    await deliver(ctx);
    assert.equal(pendingFor(hid)[0].attempts, 4, "a failed delivery is not retried");
  });

  it("an unreachable receiver records no response code", async () => {
    const h = await a.post("/v1/webhooks", { url: deadUrl, events: ["invoice.updated"] }, token);
    enqueue(ctx, "invoice.updated", null, {});
    assert.equal(await deliver(ctx), 0);
    const d = pendingFor(h.body.webhook.id)[0];
    assert.deepEqual([d.status, d.attempts, d.response_code], ["pending", 1, null]);
    await a.del(`/v1/webhooks/${h.body.webhook.id}`, token);
    ctx.db.prepare("UPDATE webhook_deliveries SET status = 'failed' WHERE webhook_id = ?").run(h.body.webhook.id);
  });

  it("lists, logs, tests and removes only the caller's own webhooks", async () => {
    const other = issueOwnerSession(ctx, randomAddress()).token;
    const mine = await a.get("/v1/webhooks", token);
    assert.ok(mine.body.items.length >= 4);
    assert.deepEqual(mine.body.events, WEBHOOK_EVENTS);
    assert.equal(JSON.stringify(mine.body).includes("whsec_"), false, "secrets are never listed");
    assert.equal((await a.get("/v1/webhooks", other)).body.items.length, 0);
    assert.equal((await a.get("/v1/webhooks")).status, 401);

    const h = mine.body.items.find((x: any) => x.url === okUrl && x.events.includes("alert"));
    assert.equal((await a.get(`/v1/webhooks/${h.id}/deliveries`, other)).status, 404);
    assert.equal((await a.del(`/v1/webhooks/${h.id}`, other)).status, 404);
    assert.equal((await a.post(`/v1/webhooks/${h.id}/test`, {}, other)).status, 404);
    assert.equal((await a.get(`/v1/webhooks/wh_nope/deliveries`, token)).status, 404);

    // another wallet subscribed to the same event never receives this wallet's test delivery
    const theirs = await a.post("/v1/webhooks", { url: okUrl, events: ["receipt.created"] }, other);
    got.length = 0;
    const t = await a.post(`/v1/webhooks/${h.id}/test`, {}, token);
    assert.equal(t.body.delivered, 1);
    assert.equal(got.length, 1);
    assert.equal(JSON.parse(got[0].body).data.test, true);
    assert.equal(pendingFor(theirs.body.webhook.id).length, 0);
    const log = await a.get(`/v1/webhooks/${h.id}/deliveries`, token);
    assert.ok(log.body.items.length >= 2);
    assert.ok(log.body.items.every((x: any) => x.webhookId === h.id && x.status === "delivered" && x.responseCode === 200));

    assert.equal((await a.del(`/v1/webhooks/${h.id}`, token)).status, 200);
    const before = pendingFor(h.id).length;
    enqueue(ctx, "alert", safeA, {});
    assert.equal(pendingFor(h.id).length, before, "a removed webhook gets nothing new");
    assert.equal((await a.get("/v1/webhooks", token)).body.items.find((x: any) => x.id === h.id).active, false);
  });
});
