import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { issueOwnerSession, createApiKey } from "../src/keys.ts";
import { openTestAgent } from "../src/seed.ts";
import { makeWorld, randomAddress, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

/**
 * Failure paths of the feature routes whose own test files cover the main flow: bad input (400), missing or
 * wrong auth (401/403), unknown ids (404), wrong state (409/410) and refused payments (422 with the verdict).
 */
describe("feature routes: failure paths (local anvil)", () => {
  let w: World;
  let a: Api;
  let owner: string;
  let stranger: string;
  let r: Awaited<ReturnType<typeof openTestAgent>>;
  let s: Awaited<ReturnType<typeof openTestAgent>>;
  let readOnly: string;

  before(async () => {
    w = await makeWorld();
    a = api(w);
    owner = issueOwnerSession(w.ctx, w.owner.address).token;
    stranger = issueOwnerSession(w.ctx, randomAddress()).token;
    r = await openTestAgent(w.ctx, "Researcher", "research", usdg(40));
    s = await openTestAgent(w.ctx, "Seller", "seller", usdg(5));
    readOnly = createApiKey(w.ctx, { safe: r.safe, scopes: ["read"] }).secret;
  });
  after(async () => w?.stop());

  it("accounts: unknown addresses are 404, bad addresses 400, owner-only routes 401/403, empty rule changes 400", async () => {
    assert.equal((await a.get(`/v1/accounts/${randomAddress()}`)).status, 404);
    assert.equal((await a.get(`/v1/accounts/0xzz`)).status, 400);
    assert.equal((await a.post(`/v1/accounts/${r.safe}/rules/prepare`, {})).status, 400, "nothing to change");
    assert.equal((await a.post(`/v1/accounts/${r.safe}/rules/prepare`, { splits: [{ to: randomAddress(), bps: 10_001 }] })).status, 400);
    assert.equal((await a.post(`/v1/accounts/${r.safe}/rules/prepare`, { guardian: { address: randomAddress(), delaySeconds: 60 } })).status, 400, "recovery waits at least a day");
    assert.equal((await a.post(`/v1/accounts/${r.safe}/rules/prepare`, { config: { agent: "0x1" } })).status, 400);
    assert.equal((await a.post(`/v1/accounts/${r.safe}/template/prepare`, { template: "nope" })).status, 404);
    assert.equal((await a.post(`/v1/accounts/prepare`, { owners: [], creator: w.owner.address, agent: randomAddress() })).status, 400);
    assert.equal((await a.post(`/v1/accounts/prepare`, { owners: [w.owner.address], creator: w.owner.address, agent: randomAddress(), template: "nope" })).status, 404);
    assert.equal((await a.post(`/v1/accounts/register`, { safe: r.safe, name: "x" })).status, 401);
    assert.equal((await a.post(`/v1/accounts/register`, { safe: r.safe, name: "x" }, stranger)).status, 403);
    assert.equal((await a.post(`/v1/accounts/register`, { safe: r.safe, name: "" }, owner)).status, 400);
    const ok = await a.post(`/v1/accounts/register`, { safe: r.safe, name: "Researcher", template: "research" }, owner);
    assert.equal(ok.status, 201);
    const listed = await a.get(`/v1/accounts?owner=${w.owner.address}`);
    assert.ok(listed.body.items.some((x: any) => x.safe === r.safe.toLowerCase()));
    assert.equal((await a.get(`/v1/accounts?owner=${randomAddress()}`)).body.items.length, 0);
    assert.equal((await a.get(`/v1/approvals/int_missing`)).status, 404);
    assert.equal((await a.get(`/v1/verdicts/vrd_missing`)).status, 404);
  });

  it("treasury: needs a treasury key, an allowed vault, and a valid amount", async () => {
    const vault = w.dep.vaults[0];
    assert.equal((await a.post("/v1/treasury/deposit", { vault, amount: "1" })).status, 401);
    assert.equal((await a.post("/v1/treasury/deposit", { vault, amount: "1" }, readOnly)).status, 403);
    assert.equal((await a.post("/v1/treasury/deposit", { vault: "0x1", amount: "1" }, r.apiKey)).status, 400);
    const notAllowed = await a.post("/v1/treasury/deposit", { vault, amount: usdg(1).toString() }, r.apiKey);
    assert.equal(notAllowed.status, 400);
    assert.equal(notAllowed.body.error.code, "vault_not_allowed");
    const sweep = await a.post("/v1/treasury/sweep", {}, r.apiKey);
    assert.equal(sweep.status, 400);
    assert.equal(sweep.body.error.code, "no_vault");
    assert.equal((await a.post(`/v1/accounts/${r.safe}/treasury/prepare`, {})).status, 400, "nothing to change");
    const t = await a.get(`/v1/accounts/${r.safe}/treasury`);
    assert.equal(t.status, 200);
    assert.deepEqual(t.body.allowedVaults, []);
  });

  it("watchdog: anyone reads the baseline; only the owner switches auto-freeze", async () => {
    const g = await a.get(`/v1/accounts/${r.safe}/watchdog`);
    assert.equal(g.status, 200);
    assert.ok(g.body.thresholds);
    assert.equal((await a.patch(`/v1/accounts/${r.safe}/watchdog`, { autoFreeze: false })).status, 401);
    assert.equal((await a.patch(`/v1/accounts/${r.safe}/watchdog`, { autoFreeze: false }, stranger)).status, 403);
    assert.equal((await a.patch(`/v1/accounts/${r.safe}/watchdog`, { autoFreeze: "no" }, owner)).status, 400);
    const ok = await a.patch(`/v1/accounts/${r.safe}/watchdog`, { autoFreeze: false }, owner);
    assert.deepEqual(ok.body, { safe: r.safe.toLowerCase(), autoFreeze: false });
    assert.equal((w.ctx.db.prepare("SELECT auto_freeze FROM accounts WHERE safe = ?").get(r.safe.toLowerCase()) as { auto_freeze: number }).auto_freeze, 0);
  });

  it("splits: no more than 100%, never to itself, at most 8 recipients", async () => {
    const half = { to: randomAddress(), bps: 6_000 };
    const over = await a.post(`/v1/accounts/${s.safe}/splits/prepare`, { splits: [half, { to: randomAddress(), bps: 5_000 }] });
    assert.equal(over.status, 400);
    assert.match(over.body.error.message, /110%/);
    assert.equal((await a.post(`/v1/accounts/${s.safe}/splits/prepare`, { splits: [{ to: s.safe, bps: 100 }] })).status, 400);
    assert.equal((await a.post(`/v1/accounts/${s.safe}/splits/prepare`, { splits: [{ to: randomAddress(), bps: 0 }] })).status, 400);
    assert.equal((await a.post(`/v1/accounts/${s.safe}/splits/prepare`, { splits: Array.from({ length: 9 }, () => ({ to: randomAddress(), bps: 10 })) })).status, 400);
    assert.equal((await a.post(`/v1/accounts/${s.safe}/splits/prepare`, { splits: [{ to: randomAddress(), bps: 100, role: "boss" }] })).status, 400);
    assert.equal((await a.get(`/v1/accounts/${s.safe}/splits`)).status, 200);
  });

  it("teams: owner-only creation on a Purser account; unknown teams, departments and members refused", async () => {
    assert.equal((await a.post("/v1/teams", { name: "Ops", treasury: r.safe })).status, 401);
    assert.equal((await a.post("/v1/teams", { name: "Ops", treasury: r.safe }, stranger)).status, 403);
    assert.equal((await a.post("/v1/teams", { name: "", treasury: r.safe }, owner)).status, 400);
    const team = await a.post("/v1/teams", { name: "Ops", treasury: r.safe }, owner);
    assert.equal(team.status, 201);
    const tid = team.body.id;
    assert.equal((await a.get("/v1/teams/team_missing")).status, 404);
    assert.equal((await a.get("/v1/teams/team_missing/org")).status, 404);
    assert.equal((await a.get("/v1/teams/team_missing/pnl")).status, 404);
    assert.equal((await a.get("/v1/teams/team_missing/export.csv")).status, 404);
    assert.equal((await a.post(`/v1/teams/${tid}/departments`, { name: "R&D" })).status, 401);
    assert.equal((await a.post(`/v1/teams/${tid}/departments`, { name: "R&D" }, stranger)).status, 403);
    assert.equal((await a.post(`/v1/teams/${tid}/members`, { safe: r.safe }, owner)).status, 400, "the treasury is not a member");
    assert.equal((await a.post(`/v1/teams/${tid}/members`, { safe: s.safe, departmentId: "dept_missing" }, owner)).status, 400);
    assert.equal((await a.post(`/v1/teams/team_missing/members`, { safe: s.safe }, owner)).status, 404);
    const notTreasury = await a.post(`/v1/teams/${tid}/topups`, { member: s.safe, amount: "1" }, s.apiKey);
    assert.equal(notTreasury.status, 403);
    assert.equal(notTreasury.body.error.code, "not_treasury");
    const notMember = await a.post(`/v1/teams/${tid}/topups`, { member: randomAddress(), amount: "1" }, r.apiKey);
    assert.equal(notMember.status, 404);
    assert.equal((await a.post(`/v1/teams/${tid}/topups`, { member: s.safe, amount: "1" })).status, 401);
  });

  it("accounting: a quiet account adds up to zero; the CSV still has its header", async () => {
    const quiet = randomAddress();
    const p = await a.get(`/v1/accounts/${quiet}/pnl`);
    assert.equal(p.status, 200);
    assert.deepEqual([p.body.incomeUsd, p.body.spendUsd, p.body.feesUsd, p.body.profitUsd], ["0.00", "0.00", "0.00", "0.00"]);
    const csv = await a.app.request(`/v1/accounts/${quiet}/export.csv`);
    assert.match(csv.headers.get("content-type")!, /text\/csv/);
    assert.equal((await csv.text()).trim().split("\n").length, 1, "header only");
    assert.equal((await a.get(`/v1/accounts/0x12/pnl`)).status, 400);
  });

  it("storefront: price above zero, own services only, unknown 404, paused 410, expired access 402", async () => {
    assert.equal((await a.post("/v1/storefront/services", { name: "Brief", price: "0" }, s.apiKey)).status, 400);
    assert.equal((await a.post("/v1/storefront/services", { name: "Brief", price: "1" })).status, 401);
    assert.equal((await a.post("/v1/storefront/services", { name: "Brief", price: "1" }, readOnly)).status, 403);
    assert.equal((await a.post("/v1/storefront/services", { name: "Brief", price: "1", model: "forever" }, s.apiKey)).status, 400);
    const svc = await a.post("/v1/storefront/services", { name: "Brief", price: usdg(1).toString(), model: "per_minute" }, s.apiKey);
    assert.equal(svc.status, 201);
    const sid = svc.body.id;
    assert.equal((await a.patch(`/v1/storefront/services/${sid}`, { active: false }, r.apiKey)).status, 403, "another account's service");
    assert.equal((await a.get("/v1/storefront/services/svc_missing")).status, 404);
    assert.equal((await a.get("/v1/storefront/services/svc_missing/usage")).status, 404);
    assert.equal((await a.app.request("/v1/store/svc_missing")).status, 404);
    const unpaid = await a.app.request(`/v1/store/${sid}?minutes=5`);
    assert.equal(unpaid.status, 402);
    assert.ok(unpaid.headers.get("PAYMENT-REQUIRED"));
    const expired = await a.app.request(`/v1/store/${sid}`, { headers: { "x-purser-access": "acc_unknown" } });
    assert.equal(expired.status, 402);
    assert.equal((await expired.json()).error.code, "access_expired");
    assert.equal((await a.patch(`/v1/storefront/services/${sid}`, { active: false }, s.apiKey)).status, 200);
    const paused = await a.app.request(`/v1/store/${sid}`);
    assert.equal(paused.status, 410);
  });

  it("recurring: unknown streams and subscriptions are 404, an unmanaged key cannot create them, ids must be numbers", async () => {
    assert.equal((await a.get("/v1/streams/999999")).status, 404);
    assert.equal((await a.post("/v1/streams/999999/stop", {}, r.apiKey)).status, 404);
    assert.equal((await a.post("/v1/subscriptions/999999/cancel", {}, r.apiKey)).status, 404);
    assert.equal((await a.post("/v1/streams", { payee: randomAddress(), ratePerSecond: "1", maxDurationSeconds: 60 })).status, 401);
    assert.equal((await a.post("/v1/streams", { payee: randomAddress(), ratePerSecond: "1", maxDurationSeconds: 0 }, r.apiKey)).status, 400);
    assert.equal((await a.post("/v1/subscriptions", { payee: randomAddress(), amount: "1", periodSeconds: 60, maxCharges: 1 }, r.apiKey)).status, 400, "periods are at least an hour");
    const unmanaged = createApiKey(w.ctx, { safe: r.safe, managed: false }).secret;
    const noKey = await a.post("/v1/streams", { payee: randomAddress(), ratePerSecond: "1", maxDurationSeconds: 60 }, unmanaged);
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error.code, "no_session_key");
    for (const path of ["/v1/streams/abc/heartbeat", "/v1/streams/abc/settle", "/v1/streams/abc/stop/prepare", "/v1/subscriptions/abc/cancel/prepare"]) {
      const res = await a.post(path, { upTo: 1, signature: "0x" });
      assert.equal(res.status, 400, `${path}: ${JSON.stringify(res.body)}`);
    }
    const settle = await a.post("/v1/streams/999999/settle");
    assert.equal(settle.status, 400, "the contract refuses an unknown stream, explained");
    assert.equal(settle.body.error.code, "settle_refused");
  });

  it("x402 facilitator: bad bodies are 400; a payload that is not a payment is invalid, not an error", async () => {
    assert.equal((await a.post("/x402/verify", {})).status, 400);
    assert.equal((await a.post("/x402/settle", { paymentRequirements: { scheme: "upto" } })).status, 400);
    const req = { scheme: "exact", network: "eip155:4663", amount: "1000", asset: w.dep.usdg, payTo: s.safe, maxTimeoutSeconds: 60 };
    const v = await a.post("/x402/verify", { paymentPayload: { x402Version: 2, payload: {} }, paymentRequirements: req });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.isValid, false);
    const st = await a.post("/x402/settle", { paymentPayload: { x402Version: 2, payload: {} }, paymentRequirements: req });
    assert.equal(st.status, 200);
    assert.equal(st.body.success, false);
    assert.equal((await a.post("/v1/x402/fetch", { url: "not a url" }, r.apiKey)).status, 400);
    assert.equal((await a.post("/v1/x402/fetch", { url: "http://127.0.0.1:1/x" }, readOnly)).status, 403);
  });

  it("connector: unknown models are 404, providers are owner-only, a call to an unknown contract is blocked (422)", async () => {
    const chat = await a.post("/v1/chat/completions", { model: "nobody/nothing", messages: [{ role: "user", content: "hi" }] }, r.apiKey);
    assert.equal(chat.status, 404);
    assert.equal(chat.body.error.code, "unknown_model");
    assert.equal((await a.post("/v1/chat/completions", { model: "x", messages: [] }, r.apiKey)).status, 400);
    assert.equal((await a.get("/v1/models")).status, 401);
    const prov = { id: "local", kind: "openai", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m", inputMicroPer1M: 1, outputMicroPer1M: 1 }] };
    assert.equal((await a.post(`/v1/accounts/${r.safe}/providers`, prov)).status, 401);
    assert.equal((await a.post(`/v1/accounts/${r.safe}/providers`, prov, stranger)).status, 403);
    assert.equal((await a.post(`/v1/accounts/${r.safe}/providers`, { ...prov, id: "Bad Id!" }, owner)).status, 400);
    assert.equal((await a.post(`/v1/accounts/${r.safe}/providers`, { ...prov, models: [] }, owner)).status, 400);
    const before = await usdgBalance(w, r.safe);
    const call = await a.post("/v1/call", { target: randomAddress(), data: "0x12345678" }, r.apiKey);
    assert.equal(call.status, 422);
    assert.equal(call.body.verdict.decision, "block");
    assert.equal(await usdgBalance(w, r.safe), before);
    const swap = await a.post("/v1/swap", { tokenIn: w.dep.usdg, tokenOut: randomAddress(), amountIn: "1", minOut: "1" }, r.apiKey);
    assert.equal(swap.status, 503, "no swap router on a plain local chain");
  });

  it("invoices: never to oneself, unknown ids 404, only the payer pays, an unfunded invoice cannot be released", async () => {
    assert.equal((await a.post("/v1/invoices", { payer: s.safe, amount: "1", description: "x" })).status, 401);
    assert.equal((await a.post("/v1/invoices", { payer: s.safe, amount: "1", description: "" }, r.apiKey)).status, 400);
    const self = await a.post("/v1/invoices", { payer: r.safe, amount: "1", description: "Work" }, r.apiKey);
    assert.equal(self.status, 400);
    const inv = await a.post("/v1/invoices", { payer: s.safe, amount: usdg(1).toString(), description: "Work" }, r.apiKey);
    assert.equal(inv.status, 201);
    assert.equal((await a.get("/v1/invoices/inv_missing")).status, 404);
    assert.equal((await a.post("/v1/invoices/inv_missing/pay", {}, s.apiKey)).status, 404);
    assert.equal((await a.post(`/v1/invoices/${inv.body.id}/pay`, {}, r.apiKey)).status, 403, "the payee cannot pay its own invoice");
    const release = await a.post(`/v1/invoices/${inv.body.id}/release`, {}, s.apiKey);
    assert.equal(release.status, 409, JSON.stringify(release.body));
    assert.equal(release.body.error.code, "not_funded");
    assert.equal((await a.post(`/v1/invoices/${inv.body.id}/deliver`, { deliveryHash: "0x" + "11".repeat(32) }, s.apiKey)).status, 403, "only the payee delivers");
  });

  it("network: unknown services and private or unknown agents are 404", async () => {
    assert.equal((await a.get("/v1/directory/missing")).status, 404);
    assert.equal((await a.get(`/v1/agents/${randomAddress()}/public`)).status, 404);
    assert.equal((await a.get(`/v1/agents/0x12/public`)).status, 400);
    w.ctx.db.prepare("UPDATE accounts SET public = 0 WHERE safe = ?").run(s.safe.toLowerCase());
    assert.equal((await a.get(`/v1/agents/${s.safe}/public`)).status, 404);
    assert.ok(!(await a.get("/v1/leaderboard")).body.items.some((x: any) => x.safe === s.safe.toLowerCase()));
  });
});
