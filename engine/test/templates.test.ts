import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "viem";
import type { Ctx } from "../src/ctx.ts";
import { getTemplate, setupFromTemplate, templateKinds, TEMPLATES } from "../src/templates.ts";
import { ApiFailure, ZERO } from "../src/util.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const dep = { usdg: a(1), escrow: a(2), recurring: a(3), swapRouter: a(4) };
const stubCtx = (over: { dep?: unknown; firewall?: boolean } = {}) =>
  ({
    dep: "dep" in over ? over.dep : dep,
    chain: { accounts: over.firewall === false ? { firewall: null, watchdog: null } : { firewall: { address: a(10) }, watchdog: { address: a(11) } } },
  }) as unknown as Ctx;

describe("rule templates (pure)", () => {
  it("every template is complete, in base units, and written to the copy rules", () => {
    assert.ok(TEMPLATES.length >= 6);
    assert.equal(new Set(TEMPLATES.map((t) => t.id)).size, TEMPLATES.length, "ids are unique");
    for (const t of TEMPLATES) {
      for (const k of ["maxSingle", "daily", "weekly", "perCounterpartyDaily", "approvalAbove"] as const) assert.match(String(t.rules[k]), /^\d+$/, `${t.id}.${k}`);
      assert.ok(BigInt(t.rules.maxSingle!) <= BigInt(t.rules.daily!), `${t.id}: one payment fits in a day`);
      assert.ok(BigInt(t.rules.daily!) <= BigInt(t.rules.weekly!), `${t.id}: a day fits in a week`);
      assert.ok(t.highlights.length >= 3);
      assert.ok(t.alerts.length >= 1);
      const text = [t.name, t.description, ...t.highlights].join(" ");
      assert.equal(/[—↗]/u.test(text), false, `${t.id}: no em dash or arrow symbol`);
      assert.equal(/\p{Extended_Pictographic}/u.test(text), false, `${t.id}: no emoji`);
      assert.equal(/\b(sample|demo|example|illustration)\b/i.test(text), false, `${t.id}: no sample labels`);
    }
    assert.deepEqual(templateKinds, TEMPLATES.map((t) => t.kind));
  });

  it("getTemplate finds by id and answers 404 for an unknown one", () => {
    assert.equal(getTemplate("research").rules.maxSingle, "5000000");
    assert.throws(() => getTemplate("nope"), (e: unknown) => e instanceof ApiFailure && e.status === 404 && e.code === "not_found");
  });

  it("setupFromTemplate turns a template into the factory setup", () => {
    const s = setupFromTemplate(stubCtx(), "coding", { agent: a(20), agentURI: "https://purseragents.fun/agents/x.json" });
    assert.equal(s.config.agent, a(20));
    assert.equal(s.config.cosigner, null);
    assert.equal(s.config.firewall, a(10));
    assert.equal(s.config.watchdog, a(11));
    assert.deepEqual(s.config.hoursUtc, [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    assert.equal(s.rules.length, 2);
    assert.equal(s.rules[0].token, dep.usdg);
    assert.equal(s.rules[0].rule.enabled, true);
    assert.equal(s.rules[0].rule.daily, "100000000");
    assert.equal(s.rules[1].token, ZERO);
    assert.equal(s.rules[1].rule.maxSingle, (10n ** 16n).toString());
    assert.deepEqual(s.allow, [dep.escrow], "only trading agents get the swap router");
    assert.deepEqual(s.extensions, [dep.recurring]);
    assert.equal(s.agentURI, "https://purseragents.fun/agents/x.json");
  });

  it("trading agents get the swap router and extra allowlist entries; co-signer passes through", () => {
    const s = setupFromTemplate(stubCtx(), "trading", { agent: a(20), cosigner: a(21), allow: [a(30)] });
    assert.deepEqual(s.allow, [dep.escrow, dep.swapRouter, a(30)]);
    assert.equal(s.config.cosigner, a(21));
    assert.equal(s.config.payeeAllowlist, true);
    assert.deepEqual(s.config.weekdays, [0, 1, 2, 3, 4]);
    assert.equal(s.rules[0].rule.cosignAbove, "500000000");
    const noRouter = setupFromTemplate(stubCtx({ dep: { ...dep, swapRouter: null } }), "trading", { agent: a(20) });
    assert.deepEqual(noRouter.allow, [dep.escrow]);
  });

  it("an engine without firewall keys leaves the firewall off; failures are explained", () => {
    const s = setupFromTemplate(stubCtx({ firewall: false }), "research", { agent: a(20) });
    assert.equal(s.config.firewall, null);
    assert.equal(s.config.watchdog, null);
    assert.throws(() => setupFromTemplate(stubCtx(), "missing", { agent: a(20) }), (e: unknown) => e instanceof ApiFailure && e.status === 404);
    assert.throws(() => setupFromTemplate(stubCtx({ dep: null }), "research", { agent: a(20) }), (e: unknown) => e instanceof ApiFailure && e.status === 503 && e.code === "no_deployment");
  });
});
