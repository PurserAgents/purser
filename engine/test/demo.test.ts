import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Address } from "viem";
import type { DemoStep } from "../../packages/sdk/src/schema.ts";
import { DEMO, runFirewallDemo } from "../src/demo.ts";
import { getVerdict } from "../src/firewall.ts";
import { scanInjection } from "../src/firewall.ts";
import { listReceipts } from "../src/receipts.ts";
import { ApiFailure } from "../src/util.ts";
import { makeWorld, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("the firewall scenario: an agent is told to drain its wallet (local anvil)", () => {
  let w: World;
  let a: Api;
  before(async () => {
    w = await makeWorld();
    a = api(w);
  });
  after(async () => w?.stop());

  it("the fixed actors and pages are the same every run, and the pages carry the planted instruction", () => {
    assert.match(DEMO.attacker, /^0x[0-9a-fA-F]{40}$/);
    assert.notEqual(DEMO.attacker, DEMO.modelProvider);
    const page = DEMO.page(DEMO.attacker);
    assert.ok(page.includes(DEMO.attacker));
    assert.ok(scanInjection(page, DEMO.attacker).strong.length > 0);
    assert.ok(scanInjection(DEMO.pageSmall(DEMO.attacker), DEMO.attacker).hiding.length > 0);
    assert.equal(DEMO.funding, 500_000_000n);
  });

  it("runs every step: two normal payments, two blocked attempts, balance unchanged", async () => {
    const events: DemoStep[] = [];
    const off = w.ctx.bus.subscribe((e) => e.type === "demo" && events.push(e.data as DemoStep));
    const r = await runFirewallDemo(w.ctx);
    off();
    const steps = r.steps;
    assert.deepEqual(steps.map((s) => s.step), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(steps.map((s) => s.status), ["ok", "ok", "ok", "ok", "blocked", "blocked", "ok"]);
    assert.deepEqual(events.map((s) => s.step), [1, 2, 3, 4, 5, 6, 7], "each step goes out live as it happens");
    for (const s of steps) assert.equal(/[—↗]/u.test(s.title + s.detail), false, "copy rules");
    assert.equal(steps.some((s) => /\bdemo\b/i.test(s.title + s.detail)), false, "no demo label in what viewers see");

    const safe = r.safe as Address;
    const [drain, quiet] = [steps[4].data as any, steps[5].data as any];
    for (const v of [drain, quiet]) {
      assert.equal(v.status, "blocked");
      assert.equal(v.txHash, null, "never sent");
      assert.equal(getVerdict(w.ctx, v.verdict)!.decision, "block");
    }
    const result = steps[6].data as any;
    assert.equal(result.before, result.after);
    assert.equal(result.attackerReceived, "0");
    assert.equal(BigInt(result.after), await usdgBalance(w, safe));
    assert.equal(await usdgBalance(w, DEMO.attacker), 0n);
    assert.deepEqual(result.blockedVerdicts, [drain.verdict, quiet.verdict]);

    const out = listReceipts(w.ctx, { safe, direction: "out" }).items;
    assert.equal(out.length, 2, "only the model call and the data purchase were paid");
    assert.ok(out.every((x) => x.counterparty !== DEMO.attacker.toLowerCase()));
    const acct = w.ctx.db.prepare("SELECT name, public FROM accounts WHERE safe = ?").get(safe.toLowerCase()) as { name: string; public: number };
    assert.equal(acct.public, 1);
    assert.ok(w.ctx.audit.list({ safe, limit: 5 }).some((e) => e.action === "firewall.scenario"));
    const last = await a.get("/v1/demo/firewall");
    assert.equal(last.body.safe, safe);
    assert.ok(last.body.finishedAt >= last.body.startedAt);
  });

  it("refuses to run outside test mode or without a local node (403)", async () => {
    const notTest = { ...w.ctx, cfg: { ...w.ctx.cfg, testMode: false } };
    await assert.rejects(runFirewallDemo(notTest), (e: unknown) => e instanceof ApiFailure && e.status === 403 && e.code === "not_test_mode");
    const noBroadcast = { ...w.ctx, chain: { ...w.ctx.chain, broadcast: false } };
    await assert.rejects(runFirewallDemo(noBroadcast), (e: unknown) => e instanceof ApiFailure && e.status === 403);
    const noOwner = { ...w.ctx, chain: { ...w.ctx.chain, accounts: { ...w.ctx.chain.accounts, owner: null } } };
    await assert.rejects(runFirewallDemo(noOwner), (e: unknown) => e instanceof ApiFailure && e.status === 403);
  });

  it("one run at a time: a second start while the first runs is 409; wait=false answers 202 at once", async () => {
    assert.equal((await a.post("/v1/demo/firewall/run", { paceMs: -1 })).status, 400);
    assert.equal((await a.post("/v1/demo/firewall/run", { paceMs: 10_001 })).status, 400);
    assert.equal((await a.post("/v1/demo/firewall/run", { wait: "yes" })).status, 400);
    const started = await a.post("/v1/demo/firewall/run", { paceMs: 150, wait: false });
    assert.equal(started.status, 202);
    assert.deepEqual(started.body, { started: true });
    const busy = await a.post("/v1/demo/firewall/run", { paceMs: 0 });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, "busy");
    await assert.rejects(runFirewallDemo(w.ctx), (e: unknown) => e instanceof ApiFailure && e.status === 409);
    const end = Date.now() + 20_000;
    let last = await a.get("/v1/demo/firewall");
    while (!last.body.finishedAt && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
      last = await a.get("/v1/demo/firewall");
    }
    assert.ok(last.body.finishedAt, "the background run finished");
    assert.deepEqual(last.body.steps.map((s: DemoStep) => s.status), ["ok", "ok", "ok", "ok", "blocked", "blocked", "ok"]);
    const again = await a.post("/v1/demo/firewall/run", {});
    assert.equal(again.status, 200, "free again after the run");
  });

  it("a failure inside the run is reported as a last step and frees the scenario", async () => {
    const send = w.ctx.chain.send;
    w.ctx.chain.send = async () => {
      throw new Error("node went away\nstack");
    };
    try {
      await assert.rejects(runFirewallDemo(w.ctx), /node went away/);
    } finally {
      w.ctx.chain.send = send;
    }
    const last = (await a.get("/v1/demo/firewall")).body;
    const final = last.steps[last.steps.length - 1];
    assert.equal(final.status, "error");
    assert.equal(final.title, "The run stopped");
    assert.equal(/\bdemo\b/i.test(final.title), false, "no demo label, even on failure");
    assert.equal(final.detail, "node went away");
    assert.ok(last.finishedAt);
    assert.equal((await a.post("/v1/demo/firewall/run", {})).status, 200, "not stuck as busy");
  });
});
