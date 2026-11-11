import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, type Address } from "viem";
import { purserModuleAbi } from "../../packages/sdk/src/abi.ts";
import { configFromChain, configToChain, execAsTestOwner, listFrom, maskFrom, ruleChangeCalls, ruleToChain, sendAsTestOwner } from "../src/accounts.ts";
import type { Ctx } from "../src/ctx.ts";
import { ApiFailure, MAX_U128, ZERO } from "../src/util.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const stubCtx = { dep: { module: a(1), usdg: a(2) }, chain: { accounts: { owner: null, relayer: null } }, cfg: { chainId: 4663 } } as unknown as Ctx;

describe("account settings as the module stores them (pure)", () => {
  it("hours and weekdays become bit masks and back", () => {
    assert.equal(maskFrom([]), 0);
    assert.equal(maskFrom([0, 2, 23]), (1 << 0) | (1 << 2) | (1 << 23));
    assert.deepEqual(listFrom(maskFrom([8, 9, 17]), 24), [8, 9, 17]);
    assert.deepEqual(listFrom(0, 24), [], "no mask means any time");
    assert.deepEqual(listFrom(maskFrom([0, 6]), 7), [0, 6]);
  });

  it("config round-trips; empty roles become the zero address and come back as null", () => {
    const cfg = { agent: a(10), cosigner: null, firewall: a(11), watchdog: null, maxPerMinute: null, hoursUtc: [9, 10], weekdays: [0, 1, 2, 3, 4], payeeAllowlist: true, serviceAllowlist: false };
    const chain = configToChain(cfg);
    assert.equal(chain.cosigner, ZERO);
    assert.equal(chain.watchdog, ZERO);
    assert.equal(chain.maxPerMinute, 0);
    assert.deepEqual(configFromChain(chain), cfg);
  });

  it("rules: a missing limit means no limit (2^128 - 1); enabled and receivable default on", () => {
    const r = ruleToChain({ maxSingle: "5", daily: null });
    assert.equal(r.maxSingle, 5n);
    assert.equal(r.daily, MAX_U128);
    assert.equal(r.weekly, MAX_U128);
    assert.equal(r.cosignAbove, MAX_U128);
    assert.equal(r.keepLiquid, 0n);
    assert.equal(r.enabled, true);
    assert.equal(r.receivable, true);
    assert.equal(ruleToChain({ enabled: false }).enabled, false);
  });

  it("rule changes become module calls in a fixed order; an empty change is a 400", () => {
    const calls = ruleChangeCalls(stubCtx, { allow: [a(20)], disallow: [a(21)], approver: null, counterpartyLimits: [{ token: a(2), counterparty: a(22), limit: "7" }] });
    const names = calls.map((c) => decodeFunctionData({ abi: purserModuleAbi, data: c.data }).functionName);
    assert.deepEqual(names, ["setAllowed", "setAllowed", "setCounterpartyLimit", "setApprover"]);
    assert.ok(calls.every((c) => c.to === a(1)));
    const approver = decodeFunctionData({ abi: purserModuleAbi, data: calls[3].data });
    assert.deepEqual(approver.args, [ZERO], "no approver is the zero address");
    assert.throws(() => ruleChangeCalls(stubCtx, {}), (e: unknown) => e instanceof ApiFailure && e.status === 400 && e.code === "empty_change");
    assert.throws(() => ruleChangeCalls(stubCtx, { allow: [] }), (e: unknown) => e instanceof ApiFailure && e.status === 400);
  });

  it("the engine plays the owner only in test mode (403 otherwise)", async () => {
    await assert.rejects(sendAsTestOwner(stubCtx, { chainId: 4663, to: a(1), data: "0x", value: "0", description: "" }), (e: unknown) => e instanceof ApiFailure && e.status === 403);
    await assert.rejects(execAsTestOwner(stubCtx, {} as never), (e: unknown) => e instanceof ApiFailure && e.status === 403);
  });
});
