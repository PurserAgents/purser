import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { listReceipts } from "../src/receipts.ts";
import { createAccount, makeWorld, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("agent organisations (15.1, local)", () => {
  let w: World;
  let e: Api;
  let owner: string;
  let treasury: `0x${string}`;
  let researcher: `0x${string}`;
  let writer: `0x${string}`;
  let support: `0x${string}`;
  let treasuryKey: string;
  let researcherKey: string;
  let team: any;

  async function keyFor(safe: `0x${string}`) {
    const k = await e.post(`/v1/accounts/${safe}/keys`, { managed: true }, owner);
    const acct = (await e.get(`/v1/accounts/${safe}`)).body;
    await e.post("/v1/testmode/safe-tx", (await e.post(`/v1/accounts/${safe}/rules/prepare`, { config: { ...acct.config, agent: k.body.key.sessionAddress } })).body);
    return k.body.secret as string;
  }

  before(async () => {
    w = await makeWorld();
    e = api(w);
    owner = (await e.post("/v1/testmode/session")).body.token;
    treasury = await createAccount(w, { name: "Acme treasury", fund: usdg(5000) });
    researcher = await createAccount(w, { name: "Researcher", fund: 0n });
    writer = await createAccount(w, { name: "Writer", fund: 0n });
    support = await createAccount(w, { name: "Support", fund: 0n });
    treasuryKey = await keyFor(treasury);
    researcherKey = await keyFor(researcher);
  });
  after(async () => w?.stop());

  it("creates a team around a shared treasury Safe, with departments and members", async () => {
    const t = await e.post("/v1/teams", { name: "Acme agents", treasury }, owner);
    assert.equal(t.status, 201, JSON.stringify(t.body));
    team = t.body;
    team = (await e.post(`/v1/teams/${team.id}/departments`, { name: "Research", dailyBudget: usdg(150).toString() }, owner)).body;
    team = (await e.post(`/v1/teams/${team.id}/departments`, { name: "Support", dailyBudget: usdg(50).toString() }, owner)).body;
    const research = team.departments.find((d: any) => d.name === "Research");
    const sup = team.departments.find((d: any) => d.name === "Support");
    for (const [safe, dept, role, budget] of [[researcher, research.id, "analyst", usdg(100)], [writer, research.id, "writer", usdg(100)], [support, sup.id, "agent", usdg(40)]] as const) {
      const m = await e.post(`/v1/teams/${team.id}/members`, { safe, departmentId: dept, role, dailyBudget: budget.toString() }, owner);
      assert.equal(m.status, 201, JSON.stringify(m.body));
      assert.equal((await e.post("/v1/testmode/safe-tx", m.body.treasuryTx)).status, 200);
    }
    team = (await e.get(`/v1/teams/${team.id}`)).body;
    assert.equal(team.members.length, 3);
  });

  it("tops up members within their own and their department's daily budget", async () => {
    const ok = await e.post(`/v1/teams/${team.id}/topups`, { member: researcher, amount: usdg(90).toString() }, treasuryKey);
    assert.equal(ok.status, 200, JSON.stringify(ok.body.verdict?.reasons ?? ok.body));
    assert.equal(ok.body.intent.status, "executed");
    assert.equal(await usdgBalance(w, researcher), usdg(90));
    // the member's own cap (100 a day) is enforced on chain as a per-payee limit
    const over = await e.post(`/v1/teams/${team.id}/topups`, { member: researcher, amount: usdg(20).toString() }, treasuryKey);
    assert.equal(over.status, 422);
    assert.ok(over.body.verdict.reasons.some((r: any) => r.code === "counterparty_limit"));
    // the department cap (150 a day for research) is enforced by the engine
    const w1 = await e.post(`/v1/teams/${team.id}/topups`, { member: writer, amount: usdg(55).toString() }, treasuryKey);
    assert.equal(w1.body.intent.status, "executed");
    const w2 = await e.post(`/v1/teams/${team.id}/topups`, { member: writer, amount: usdg(10).toString() }, treasuryKey);
    assert.equal(w2.status, 422);
    assert.equal(w2.body.error.code, "department_budget");
    assert.match(w2.body.error.message, /Research department has 5\.00 USDG left/);
    // only the treasury's key tops up
    assert.equal((await e.post(`/v1/teams/${team.id}/topups`, { member: writer, amount: "1" }, researcherKey)).status, 403);
  });

  it("internal payments between members show on both sides as internal", async () => {
    const r = await e.post("/v1/pay", { to: writer, amount: usdg(5).toString(), memo: "Draft review" }, researcherKey);
    assert.equal(r.body.intent.status, "executed", JSON.stringify(r.body.verdict?.reasons));
    assert.equal(r.body.receipt.category, "internal");
    const income = listReceipts(w.ctx, { safe: writer, direction: "in", category: "internal" });
    assert.ok(income.items.some((x) => x.counterparty === researcher.toLowerCase() && x.money.amount === usdg(5).toString()));
  });

  it("shows an org chart and spending per department and agent", async () => {
    const org = (await e.get(`/v1/teams/${team.id}/org`)).body;
    assert.equal(org.kind, "team");
    assert.equal(org.children.length, 2);
    const research = org.children.find((c: any) => c.label === "Research");
    assert.equal(research.children.length, 2);
    assert.match(research.children[0].label, /\((analyst|writer)\)/);
    const t = (await e.get(`/v1/teams/${team.id}`)).body;
    const r = t.members.find((m: any) => m.safe === researcher.toLowerCase());
    assert.equal(r.spentToday.amount, usdg(5).toString());
    assert.equal(r.dailyBudget.amount, usdg(100).toString());
  });
});
