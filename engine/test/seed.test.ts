import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { listAlerts } from "../src/alerts.ts";
import { openTestAgent, seedTestActivity } from "../src/seed.ts";
import { listReceipts } from "../src/receipts.ts";
import { listVerdicts } from "../src/firewall.ts";
import { makeWorld, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("test-mode seed: real activity on the local node (local anvil)", () => {
  let w: World;
  let a: Api;
  let seeded: Awaited<ReturnType<typeof seedTestActivity>>;
  before(async () => {
    w = await makeWorld();
    a = api(w);
    seeded = await seedTestActivity(w.ctx);
  });
  after(async () => w?.stop());

  it("opens a funded agent with an engine-held key that is the account's agent", async () => {
    const agent = await openTestAgent(w.ctx, "Scout", "support", usdg(12));
    assert.equal(await usdgBalance(w, agent.safe), usdg(12));
    const me = await a.get("/v1/me", agent.apiKey);
    assert.equal(me.status, 200);
    assert.equal(me.body.safe, agent.safe.toLowerCase());
    assert.equal(me.body.sessionAddress.toLowerCase(), agent.sessionAddress.toLowerCase());
    const acct = (await a.get(`/v1/accounts/${agent.safe}`)).body;
    assert.equal(acct.config.agent, agent.sessionAddress.toLowerCase());
    assert.equal(acct.name, "Scout");
    assert.deepEqual(listAlerts(w.ctx, agent.safe).map((x) => x.kind).sort(), ["approval_needed", "payment_blocked"], "the template's alerts");
    assert.equal((await a.post("/v1/pay", { to: seeded.providers.model, amount: usdg(1).toString() }, agent.apiKey)).body.intent.status, "executed");
  });

  it("three named agents with history that comes from chain events only", () => {
    const names = (w.ctx.db.prepare("SELECT name FROM accounts WHERE safe IN (?, ?, ?)").all(seeded.research.safe, seeded.seller.safe, seeded.ops.safe) as { name: string }[]).map((r) => r.name).sort();
    assert.deepEqual(names, ["Atlas, research agent", "Ledger, operations", "Quill, report writer"]);
    const all = w.ctx.db.prepare("SELECT * FROM receipts").all() as { tx_hash: string | null; uniq: string | null }[];
    assert.ok(all.length >= 10);
    assert.ok(all.every((r) => r.tx_hash && r.uniq), "every receipt points at a transaction log");
  });

  it("research paid models and data, bought a report from the seller, and had one payment blocked", () => {
    const out = listReceipts(w.ctx, { safe: seeded.research.safe, direction: "out" }).items;
    assert.ok(out.some((r) => r.category === "model" && r.counterparty === seeded.providers.model.toLowerCase()));
    assert.ok(out.some((r) => r.category === "x402" && r.counterparty === seeded.providers.data.toLowerCase()));
    assert.ok(out.some((r) => r.category === "internal" && r.counterparty === seeded.seller.safe.toLowerCase()));
    const blocked = listVerdicts(w.ctx, { safe: seeded.research.safe, decision: "block" });
    assert.equal(blocked.length, 1);
    assert.ok(blocked[0].reasons.some((r) => r.code === "injection"));
  });

  it("the seller earned from an agent and from an outside customer over x402", () => {
    const inc = listReceipts(w.ctx, { safe: seeded.seller.safe, direction: "in" }).items;
    assert.ok(inc.some((r) => r.counterparty === seeded.research.safe.toLowerCase() && r.money.amount === "3000000"));
    assert.ok(inc.some((r) => r.category === "storefront" && r.money.amount === "4000000"));
  });

  it("ops pays allowlisted suppliers, with a stream and a subscription running", () => {
    const allowed = (w.ctx.db.prepare("SELECT value FROM account_sets WHERE safe = ? AND kind = 'allow' AND on_flag = 1").all(seeded.ops.safe.toLowerCase()) as { value: string }[]).map((r) => r.value);
    assert.ok(allowed.includes(seeded.providers.data.toLowerCase()));
    assert.ok(allowed.includes(seeded.seller.safe.toLowerCase()));
    assert.equal((w.ctx.db.prepare("SELECT COUNT(*) AS n FROM streams WHERE safe = ?").get(seeded.ops.safe.toLowerCase()) as { n: number }).n, 1);
    assert.equal((w.ctx.db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE safe = ? AND active = 1").get(seeded.ops.safe.toLowerCase()) as { n: number }).n, 1);
    assert.ok(listReceipts(w.ctx, { safe: seeded.ops.safe, direction: "out" }).items.some((r) => r.money.amount === "45000000"));
  });

  it("the derived supplier addresses are stable and are not well-known keys", () => {
    const p = Object.values(seeded.providers);
    assert.equal(new Set(p).size, 3);
    for (const x of p) assert.ok(!/^0x0{30,}/i.test(x));
  });
});
