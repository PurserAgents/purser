import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readChainAccount } from "../src/accounts.ts";
import { chainNow } from "../src/ctx.ts";
import { submitIntent } from "../src/intents.ts";
import { insertReceipt } from "../src/receipts.ts";
import { installWatchdog, listWatchEvents, watch } from "../src/watchdog.ts";
import { createAccount, makeWorld, randomAddress, usdg, type World } from "./harness.ts";
import { api } from "./util-api.ts";

describe("spending watchdog (12.1, local)", () => {
  let w: World;
  before(async () => {
    w = await makeWorld();
    installWatchdog(w.ctx);
  });
  after(async () => w?.stop());

  const pay = (safe: `0x${string}`, to: `0x${string}`, amount: bigint) =>
    submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to, amount } }, category: "transfer", signer: w.agent });

  it("freezes an agent stuck in a loop and tells the owner why", async () => {
    const safe = await createAccount(w, { name: "Looper" });
    const payee = randomAddress();
    for (let i = 0; i < 5; i++) assert.equal((await pay(safe, payee, usdg(1))).intent.status, "executed");
    assert.equal((await readChainAccount(w.ctx, safe)).frozen, true);
    const ev = listWatchEvents(w.ctx, safe)[0];
    assert.equal(ev.kind, "loop");
    assert.equal(ev.action, "freeze");
    assert.ok(ev.txHash);
    assert.match(ev.detail, /5 payments of 1\.00 USDG/);
    assert.match(ev.detail, /Only the owner can unfreeze/);
    const next = await pay(safe, randomAddress(), usdg(1));
    assert.equal(next.intent.status, "blocked");
  });

  it("freezes when most of the balance leaves within an hour, even in steps the firewall allows", async () => {
    const safe = await createAccount(w, { name: "Drainee", fund: usdg(300) });
    for (const _ of [0, 1, 2]) await pay(safe, randomAddress(), usdg(60));
    const ev = listWatchEvents(w.ctx, safe).find((e) => e.kind === "drain");
    assert.ok(ev, JSON.stringify(listWatchEvents(w.ctx, safe)));
    assert.equal(ev!.action, "freeze");
  });

  it("finds a spike against the agent's own baseline", async () => {
    const safe = await createAccount(w, { name: "Steady" });
    const t = await chainNow(w.ctx);
    const usual = randomAddress();
    // test fixture: a day of history at about $1 an hour
    for (let h = 2; h < 26; h++) insertReceipt(w.ctx, { safe, direction: "out", category: "model", token: w.dep.usdg, amount: usdg(1), counterparty: usual, createdAt: t - h * 3600 });
    for (let i = 0; i < 4; i++) await pay(safe, usual, usdg(10 + i));
    const ev = listWatchEvents(w.ctx, safe).find((e) => e.kind === "spike");
    assert.ok(ev, JSON.stringify(listWatchEvents(w.ctx, safe)));
    assert.match(ev!.detail, /usually spends about \$1\.0/);
  });

  it("alerts (without freezing) on a large first payment to a new payee", async () => {
    const safe = await createAccount(w, { name: "Careful" });
    const t = await chainNow(w.ctx);
    for (let h = 2; h < 8; h++) insertReceipt(w.ctx, { safe, direction: "out", category: "model", token: w.dep.usdg, amount: usdg(1), counterparty: randomAddress(), createdAt: t - h * 3600 });
    await pay(safe, randomAddress(), usdg(8));
    const ev = listWatchEvents(w.ctx, safe).find((e) => e.kind === "new_counterparty");
    assert.ok(ev);
    assert.equal(ev!.action, "alert");
    assert.equal((await readChainAccount(w.ctx, safe)).frozen, false);
  });

  it("only alerts when the owner did not give the watchdog the freeze right, or switched auto-freeze off", async () => {
    const noKey = await createAccount(w, { name: "No watchdog", config: { watchdog: null } });
    const payee = randomAddress();
    for (let i = 0; i < 5; i++) await pay(noKey, payee, usdg(1));
    const ev = listWatchEvents(w.ctx, noKey)[0];
    assert.equal(ev.action, "alert");
    assert.match(ev.detail, /Freezing by the watchdog is off/);
    assert.equal((await readChainAccount(w.ctx, noKey)).frozen, false);

    const e = api(w);
    const owner = (await e.post("/v1/testmode/session")).body.token;
    const off = await createAccount(w, { name: "Auto-freeze off" });
    assert.equal((await e.patch(`/v1/accounts/${off}/watchdog`, { autoFreeze: false }, owner)).status, 200);
    for (let i = 0; i < 5; i++) await pay(off, payee, usdg(1));
    assert.equal((await readChainAccount(w.ctx, off)).frozen, false);
    const view = await e.get(`/v1/accounts/${off}/watchdog`);
    assert.equal(view.body.baseline.autoFreeze, false);
    assert.equal(view.body.events[0].kind, "loop");
    await watch(w.ctx, off);
    assert.equal(listWatchEvents(w.ctx, off).filter((x) => x.kind === "loop").length, 1, "no repeat inside the cooldown");
  });
});
