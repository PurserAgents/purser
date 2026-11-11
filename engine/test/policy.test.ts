import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { keccak256, toHex, type Address } from "viem";
import type { VerdictReason } from "../../packages/sdk/src/schema.ts";
import { serviceId } from "../../packages/sdk/src/eip712.ts";
import { execAsTestOwner, prepareModuleCall, prepareSafeTx, ruleChangeCalls, sendAsTestOwner, type RuleInput } from "../src/accounts.ts";
import { chainNow } from "../src/ctx.ts";
import { submitIntent } from "../src/intents.ts";
import { checkPolicy } from "../src/policy.ts";
import { ApiFailure, ZERO } from "../src/util.ts";
import { createAccount, defaultRule, makeOfflineEngine, makeWorld, randomAddress, usdg, type World } from "./harness.ts";

const codes = (r: { reasons: VerdictReason[] }) => r.reasons.map((x) => x.code).sort();
const rule = (over: RuleInput): RuleInput => ({ ...defaultRule, ...over });
const wide = { maxSingle: usdg(100).toString(), daily: usdg(1000).toString(), weekly: usdg(1000).toString(), perCounterpartyDaily: usdg(1000).toString(), approvalAbove: usdg(1000).toString() };

describe("policy mirror: each of the owner's rules, explained in plain words (local anvil)", () => {
  let w: World;
  const all: VerdictReason[] = [];
  const check = async (safe: Address, amount: bigint, to: Address = randomAddress(), extra: { token?: Address; service?: `0x${string}`; kind?: "pay" | "call" } = {}) => {
    const r = await checkPolicy(w.ctx, safe, [{ token: extra.token ?? w.dep.usdg, amount, to, service: extra.service }], { kind: extra.kind ?? "pay" });
    all.push(...r.reasons);
    return r;
  };
  before(async () => {
    w = await makeWorld();
  });
  after(async () => w?.stop());

  it("within the rules: no reasons; above the approval threshold: waits for the owner", async () => {
    const safe = await createAccount(w);
    const ok = await check(safe, usdg(10));
    assert.deepEqual(codes(ok), []);
    assert.equal(ok.needsApproval, false);
    assert.equal(ok.frozen, false);
    assert.equal(ok.agent.toLowerCase(), w.agent.address.toLowerCase());
    assert.equal(ok.firewall?.toLowerCase(), w.ctx.chain.accounts.firewall!.address.toLowerCase());
    assert.equal(ok.cosigner, null);
    assert.equal(ok.rule!.maxSingle, usdg(250));
    const big = await check(safe, usdg(201));
    assert.deepEqual(codes(big), []);
    assert.equal(big.needsApproval, true);
    assert.equal(big.needsCosign, false, "no co-signer set");
  });

  it("not a Purser account", async () => {
    const r = await check(randomAddress(), 1n);
    assert.deepEqual(codes(r), ["not_account"]);
  });

  it("token not enabled (a token the owner never set up, or switched off)", async () => {
    const safe = await createAccount(w, { ethRule: { enabled: false } });
    assert.deepEqual(codes(await check(safe, 1n, randomAddress(), { token: randomAddress() })), ["token_not_enabled"]);
    const eth = await check(safe, 1n, randomAddress(), { token: ZERO });
    assert.deepEqual(codes(eth), ["token_not_enabled"]);
    assert.match(eth.reasons[0].title, /ETH is not enabled/);
  });

  it("largest single payment, daily and weekly budgets, each on its own", async () => {
    const single = await createAccount(w, { rule: rule({ ...wide, maxSingle: usdg(50).toString() }) });
    const s = await check(single, usdg(60));
    assert.deepEqual(codes(s), ["max_single"]);
    assert.match(s.reasons[0].detail, /60\.00 USDG is more than the 50\.00 USDG/);

    const daily = await createAccount(w, { rule: rule({ ...wide, daily: usdg(50).toString() }) });
    const d = await check(daily, usdg(60));
    assert.deepEqual(codes(d), ["daily_budget"]);
    assert.match(d.reasons[0].detail, /0\.00 USDG of 50\.00 USDG is spent; this payment with its fee is 60\.06 USDG/);
    // the fee counts: 49.96 + 0.1% = 50.00996 is over 50
    assert.deepEqual(codes(await check(daily, usdg(49.96))), ["daily_budget"]);
    assert.deepEqual(codes(await check(daily, usdg(49.9))), []);

    const weekly = await createAccount(w, { rule: rule({ ...wide, weekly: usdg(50).toString() }) });
    const k = await check(weekly, usdg(60));
    assert.deepEqual(codes(k), ["weekly_budget"]);
  });

  it("spending already done today counts toward the budget", async () => {
    const safe = await createAccount(w, { rule: rule({ ...wide, daily: usdg(30).toString() }) });
    const paid = await submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to: randomAddress(), amount: usdg(20) } }, category: "transfer", signer: w.agent });
    assert.equal(paid.intent.status, "executed", paid.intent.error ?? "");
    const r = await check(safe, usdg(15));
    assert.deepEqual(codes(r), ["daily_budget"]);
    assert.match(r.reasons[0].detail, /^Today 20\.02 USDG of 30\.00 USDG is spent/);
  });

  it("daily limit per payee, with the owner's own limit for one payee taking precedence", async () => {
    const safe = await createAccount(w, { rule: rule({ ...wide, perCounterpartyDaily: usdg(20).toString() }) });
    const payee = randomAddress();
    const r = await check(safe, usdg(30), payee);
    assert.deepEqual(codes(r), ["counterparty_limit"]);
    assert.match(r.reasons[0].detail, /the limit is 20\.00 USDG/);
    const raise = await prepareSafeTx(w.ctx, safe, ruleChangeCalls(w.ctx, { counterpartyLimits: [{ token: w.dep.usdg, counterparty: payee, limit: usdg(40).toString() }] }), "raise");
    await execAsTestOwner(w.ctx, raise);
    assert.deepEqual(codes(await check(safe, usdg(30), payee)), []);
    assert.deepEqual(codes(await check(safe, usdg(30), randomAddress())), ["counterparty_limit"], "others keep the default");
  });

  it("payee and service allowlists apply to payments, not to contract calls", async () => {
    const listed = randomAddress();
    const safe = await createAccount(w, { config: { payeeAllowlist: true, serviceAllowlist: true }, allow: [listed] });
    const svc = serviceId("model:frontier-1");
    assert.deepEqual(codes(await check(safe, usdg(1), randomAddress(), { service: svc })), ["payee_not_allowed", "service_not_allowed"]);
    assert.deepEqual(codes(await check(safe, usdg(1), listed, { service: svc })), ["service_not_allowed"]);
    await execAsTestOwner(w.ctx, await prepareSafeTx(w.ctx, safe, ruleChangeCalls(w.ctx, { services: [svc] }), "allow service"));
    assert.deepEqual(codes(await check(safe, usdg(1), listed, { service: svc })), []);
    assert.deepEqual(codes(await check(safe, usdg(1), listed, { service: keccak256(toHex("other")) })), ["service_not_allowed"]);
    assert.deepEqual(codes(await check(safe, usdg(1), randomAddress(), { kind: "call" })), [], "calls are limited by the contract allowlist instead");
  });

  it("allowed hours and days (UTC, weeks start Monday)", async () => {
    const ts = await chainNow(w.ctx);
    const hour = Math.floor(ts / 3600) % 24;
    const weekday = (Math.floor(ts / 86400) + 3) % 7;
    const offHours = await createAccount(w, { config: { hoursUtc: [(hour + 12) % 24] } });
    const h = await check(offHours, usdg(1));
    assert.deepEqual(codes(h), ["time_window"]);
    assert.match(h.reasons[0].detail, new RegExp(`It is ${hour}:00 UTC now`));
    const offDays = await createAccount(w, { config: { weekdays: [(weekday + 3) % 7] } });
    const d = await check(offDays, usdg(1));
    assert.deepEqual(codes(d), ["time_window"]);
    assert.equal(d.reasons[0].title, "Outside the allowed days");
    const onNow = await createAccount(w, { config: { hoursUtc: [hour, (hour + 1) % 24], weekdays: [weekday] } });
    assert.deepEqual(codes(await check(onNow, usdg(1))), []);
  });

  it("frozen accounts refuse everything", async () => {
    const safe = await createAccount(w);
    await sendAsTestOwner(w.ctx, prepareModuleCall(w.ctx, "freeze", [safe], "freeze"));
    const r = await check(safe, usdg(1));
    assert.equal(r.frozen, true);
    assert.deepEqual(codes(r), ["frozen"]);
    await sendAsTestOwner(w.ctx, prepareModuleCall(w.ctx, "unfreeze", [safe], "unfreeze"));
    assert.deepEqual(codes(await check(safe, usdg(1))), []);
  });

  it("payments per minute", async () => {
    const safe = await createAccount(w, { config: { maxPerMinute: 1 } });
    let r;
    for (let i = 0; i < 3; i++) {
      const paid = await submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to: randomAddress(), amount: usdg(1) } }, category: "transfer", signer: w.agent });
      if (paid.intent.status !== "executed") continue; // the previous attempt already used this minute
      r = await check(safe, usdg(1));
      if (codes(r).length) break; // a minute boundary passed in between: try once more
    }
    assert.deepEqual(codes(r!), ["rate_limit"]);
    assert.match(r!.reasons[0].detail, /allows 1 payments per minute/);
  });

  it("co-signer threshold", async () => {
    const cosigner = randomAddress();
    const safe = await createAccount(w, { config: { cosigner }, rule: rule({ cosignAbove: usdg(10).toString() }) });
    const r = await check(safe, usdg(11));
    assert.equal(r.needsCosign, true);
    assert.equal(r.cosigner?.toLowerCase(), cosigner.toLowerCase());
    assert.equal((await check(safe, usdg(10))).needsCosign, false, "at the threshold is fine");
  });

  it("every refusal is a block with a title and a plain detail, written to the copy rules", () => {
    const seen = new Set(all.map((r) => r.code));
    for (const c of ["not_account", "token_not_enabled", "max_single", "daily_budget", "weekly_budget", "counterparty_limit", "payee_not_allowed", "service_not_allowed", "time_window", "frozen", "rate_limit"]) assert.ok(seen.has(c), `covered: ${c}`);
    for (const r of all) {
      assert.equal(r.severity, "block");
      assert.ok(r.title.length > 5 && r.detail.length > 15, JSON.stringify(r));
      assert.equal(/[—↗]/u.test(r.title + r.detail), false, "no em dash or arrow");
      assert.match(r.detail, /\.$/);
    }
  });

  it("without a deployment the policy check is a 503", async () => {
    const e = makeOfflineEngine();
    await assert.rejects(checkPolicy(e.ctx, randomAddress(), []), (x: unknown) => x instanceof ApiFailure && x.status === 503);
    e.ctx.db.close();
  });
});
