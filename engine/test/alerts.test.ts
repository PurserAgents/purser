import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Address } from "viem";
import { ALERT_KINDS, applyTemplateAlerts, listAlerts, setAlerts } from "../src/alerts.ts";
import { submitIntent } from "../src/intents.ts";
import { issueOwnerSession } from "../src/keys.ts";
import { insertReceipt } from "../src/receipts.ts";
import { ApiFailure } from "../src/util.ts";
import { createAccount, makeWorld, randomAddress, usdg, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("owner alerts (local anvil)", () => {
  let w: World;
  let a: Api;
  let safe: Address;
  let owner: string;
  let stranger: string;
  const fired: { safe: string | null; kind: string; title: string; detail: string }[] = [];

  before(async () => {
    w = await makeWorld();
    a = api(w); // building the app installs the alert listener
    safe = await createAccount(w);
    owner = issueOwnerSession(w.ctx, w.owner.address).token;
    stranger = issueOwnerSession(w.ctx, randomAddress()).token;
    w.ctx.bus.subscribe((e) => {
      if (e.type === "alert") fired.push({ safe: e.safe, ...(e.data as { kind: string; title: string; detail: string }) });
    });
  });
  after(async () => w?.stop());

  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return pred();
  };
  const settle = () => new Promise((r) => setTimeout(r, 150));
  const kinds = () => fired.map((f) => f.kind);

  it("stores, replaces and lists an account's alerts; templates bring their own", () => {
    assert.deepEqual(listAlerts(w.ctx, safe), []);
    const set = setAlerts(w.ctx, safe, [{ kind: "income", threshold: "1000000" }, { kind: "frozen" }]);
    assert.deepEqual(set.map((x) => [x.kind, x.threshold]), [["frozen", null], ["income", "1000000"]]);
    assert.deepEqual(setAlerts(w.ctx, safe, [{ kind: "payment_blocked" }]).map((x) => x.kind), ["payment_blocked"], "a new set replaces the old one");
    assert.deepEqual(applyTemplateAlerts(w.ctx, safe, "ops").map((x) => x.kind).sort(), ["approval_needed", "balance_under"]);
    assert.throws(() => applyTemplateAlerts(w.ctx, safe, "nope"), (e: unknown) => e instanceof ApiFailure && e.status === 404);
    setAlerts(w.ctx, safe, []);
  });

  it("the API: anyone reads, only the owner changes; bad input is 400", async () => {
    const g = await a.get(`/v1/accounts/${safe}/alerts`);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.kinds, ALERT_KINDS);
    const put = (body: unknown, token?: string) =>
      a.app.request(`/v1/accounts/${safe}/alerts`, { method: "PUT", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await put({ alerts: [] })).status, 401);
    assert.equal((await put({ alerts: [] }, stranger)).status, 403);
    assert.equal((await put({ alerts: [{ kind: "everything" }] }, owner)).status, 400);
    assert.equal((await put({ alerts: [{ kind: "income", threshold: "1.5" }] }, owner)).status, 400);
    assert.equal((await put({ alerts: Array.from({ length: 21 }, () => ({ kind: "frozen" })) }, owner)).status, 400);
    assert.equal((await put({}, owner)).status, 400);
    const ok = await put({ alerts: [{ kind: "income", threshold: usdg(1).toString() }] }, owner);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).items[0].kind, "income");
    assert.equal((await a.get(`/v1/accounts/0xnope/alerts`)).status, 400);
    assert.equal((await a.post(`/v1/accounts/${safe}/alerts/template`, { template: "support" })).status, 401);
    assert.equal((await a.post(`/v1/accounts/${safe}/alerts/template`, { template: "support" }, stranger)).status, 403);
    assert.equal((await a.post(`/v1/accounts/${safe}/alerts/template`, { template: "nope" }, owner)).status, 404);
    const t = await a.post(`/v1/accounts/${safe}/alerts/template`, { template: "support" }, owner);
    assert.deepEqual(t.body.items.map((x: any) => x.kind).sort(), ["approval_needed", "payment_blocked"]);
  });

  it("a blocked payment and a payment waiting for approval reach the owner", async () => {
    setAlerts(w.ctx, safe, [{ kind: "payment_blocked" }, { kind: "approval_needed" }]);
    fired.length = 0;
    const blocked = await submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to: randomAddress(), amount: usdg(300) } }, category: "transfer", signer: w.agent });
    assert.equal(blocked.intent.status, "blocked");
    assert.ok(await waitFor(() => kinds().includes("payment_blocked")));
    const pb = fired.find((f) => f.kind === "payment_blocked")!;
    assert.equal(pb.safe, safe.toLowerCase());
    assert.match(pb.detail, /^Blocked: /);
    const queued = await submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to: randomAddress(), amount: usdg(220) } }, category: "transfer", signer: w.agent });
    assert.equal(queued.intent.status, "queued");
    assert.ok(await waitFor(() => kinds().includes("approval_needed")));
    assert.match(fired.find((f) => f.kind === "approval_needed")!.detail, new RegExp(queued.intent.id));
  });

  it("an alert the owner did not set stays quiet", async () => {
    setAlerts(w.ctx, safe, [{ kind: "income", threshold: usdg(1000).toString() }]);
    fired.length = 0;
    w.ctx.bus.emit("intent", safe, { event: "blocked", status: "blocked", error: "Blocked: x" });
    w.ctx.bus.emit("account", safe, { event: "frozen", by: w.owner.address });
    insertReceipt(w.ctx, { safe, direction: "in", category: "transfer", token: w.dep.usdg, amount: usdg(5), counterparty: randomAddress() });
    await settle();
    assert.deepEqual(fired, []);
  });

  it("income at or above the level fires each time; below it does not", async () => {
    setAlerts(w.ctx, safe, [{ kind: "income", threshold: usdg(2).toString() }, { kind: "frozen" }]);
    fired.length = 0;
    const from = randomAddress();
    insertReceipt(w.ctx, { safe, direction: "in", category: "transfer", token: w.dep.usdg, amount: usdg(1.99), counterparty: from });
    insertReceipt(w.ctx, { safe, direction: "out", category: "transfer", token: w.dep.usdg, amount: usdg(50), counterparty: from });
    await settle();
    assert.deepEqual(kinds(), []);
    insertReceipt(w.ctx, { safe, direction: "in", category: "transfer", token: w.dep.usdg, amount: usdg(2), counterparty: from });
    insertReceipt(w.ctx, { safe, direction: "in", category: "transfer", token: w.dep.usdg, amount: usdg(7), counterparty: from });
    assert.ok(await waitFor(() => kinds().length === 2));
    const details = fired.map((f) => f.detail).sort(); // the two fire concurrently, in either order
    assert.deepEqual(details, [`2.00 USDG from ${from.toLowerCase()}.`, `7.00 USDG from ${from.toLowerCase()}.`]);
    w.ctx.bus.emit("account", safe, { event: "frozen", by: "0xwatchdog" });
    assert.ok(await waitFor(() => kinds().includes("frozen")));
    assert.equal(fired.find((f) => f.kind === "frozen")!.detail, "Frozen by 0xwatchdog.");
    w.ctx.bus.emit("account", null, { event: "frozen", by: "x" });
    await settle();
    assert.equal(kinds().filter((k) => k === "frozen").length, 1, "events without an account are ignored");
  });

  it("balance_under waits six hours before it fires again", async () => {
    setAlerts(w.ctx, safe, [{ kind: "balance_under", threshold: usdg(1_000_000).toString() }]);
    fired.length = 0;
    const out = () => insertReceipt(w.ctx, { safe, direction: "out", category: "transfer", token: w.dep.usdg, amount: 1n, counterparty: randomAddress() });
    out();
    assert.ok(await waitFor(() => kinds().length === 1));
    assert.match(fired[0].detail, /USDG left; the alert is at 1,000,000\.00 USDG\.$/);
    out();
    await settle();
    assert.equal(kinds().length, 1, "cooldown");
    w.ctx.db.prepare("UPDATE alerts SET last_fired = last_fired - ? WHERE safe = ?").run(6 * 3600 + 1, safe.toLowerCase());
    out();
    assert.ok(await waitFor(() => kinds().length === 2), "fires again after the cooldown");
  });
});
