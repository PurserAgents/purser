import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { encodePacked, keccak256, toFunctionSelector, type Address } from "viem";
import { sendAsTestOwner } from "../src/accounts.ts";
import { decideAsTestOwner, decideWithPasskey, getApproval, listApprovals, prepareDecision, rejectChallenge } from "../src/approvals.ts";
import { REVERT_WORDS } from "../src/chain.ts";
import { ingestReceipt } from "../src/indexer.ts";
import { resumeIntent, submitIntent } from "../src/intents.ts";
import { getIntentRow } from "../src/receipts.ts";
import { ApiFailure } from "../src/util.ts";
import { createAccount, makeWorld, randomAddress, usdg, usdgBalance, type World } from "./harness.ts";
import { api, softPasskey, type Api } from "./util-api.ts";

describe("approvals: queue, approve, reject, resume (local anvil)", () => {
  let w: World;
  let a: Api;
  let safe: Address;
  before(async () => {
    w = await makeWorld();
    a = api(w);
    safe = await createAccount(w);
  });
  after(async () => w?.stop());

  const queue = async (payee = randomAddress(), amount = usdg(220)) => {
    const r = await submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to: payee, amount } }, category: "transfer", signer: w.agent });
    assert.equal(r.intent.status, "queued", r.intent.error ?? "");
    return { id: r.intent.id, payee };
  };

  it("a queued payment is listed with its digest and the passkey reject challenge", async () => {
    const { id } = await queue();
    const p = getApproval(w.ctx, id);
    assert.equal(p.status, "queued");
    assert.equal(p.safe, safe.toLowerCase());
    assert.equal(p.money!.amount, usdg(220).toString());
    assert.match(p.summary, /^Pay 220\.00 USDG to 0x/);
    assert.equal(p.rejectChallenge, keccak256(encodePacked(["string", "bytes32"], ["reject", p.digest])));
    assert.equal(rejectChallenge(p.digest), p.rejectChallenge);
    assert.ok(listApprovals(w.ctx, safe).some((x) => x.id === id));
    assert.ok(listApprovals(w.ctx).some((x) => x.id === id), "across all accounts");
    assert.ok(listApprovals(w.ctx, randomAddress()).length === 0);
    const viaApi = await a.get(`/v1/approvals/${id}`);
    assert.equal(viaApi.body.digest, p.digest);
  });

  it("cannot run before the owner approves", async () => {
    const { id, payee } = await queue();
    await assert.rejects(resumeIntent(w.ctx, id), (e: unknown) => e instanceof ApiFailure && e.status === 409 && e.code === "not_approved");
    const r = await a.post(`/v1/approvals/${id}/resume`);
    assert.equal(r.status, 409);
    assert.equal(await usdgBalance(w, payee), 0n);
  });

  it("prepares the owner's approve or reject transaction; bad input and unknown ids are refused", async () => {
    const { id } = await queue();
    const ap = prepareDecision(w.ctx, id, true);
    assert.equal(ap.to.toLowerCase(), w.dep.module.toLowerCase());
    assert.ok(ap.data.startsWith(toFunctionSelector("approveIntent(address,bytes32)")));
    assert.match(ap.description, /^Approve: Pay 220\.00 USDG/);
    const rj = await a.post(`/v1/approvals/${id}/prepare`, { decision: "reject" });
    assert.ok(rj.body.data.startsWith(toFunctionSelector("rejectIntent(address,bytes32)")));
    assert.equal((await a.post(`/v1/approvals/${id}/prepare`, { decision: "maybe" })).status, 400);
    assert.equal((await a.post(`/v1/approvals/int_missing/prepare`, { decision: "approve" })).status, 404);
    assert.equal((await a.get(`/v1/approvals/int_missing`)).status, 404);
    assert.equal((await a.post(`/v1/testmode/approvals/int_missing`, { decision: "approve" })).status, 404);
  });

  it("a rejected payment never runs", async () => {
    const { id, payee } = await queue();
    assert.equal(await decideAsTestOwner(w.ctx, id, false), null);
    assert.equal(getIntentRow(w.ctx, id)!.status, "rejected");
    assert.equal(getApproval(w.ctx, id).status, "rejected");
    assert.ok(!listApprovals(w.ctx, safe).some((x) => x.id === id), "no longer pending");
    assert.ok(listApprovals(w.ctx, safe, true).some((x) => x.id === id && x.status === "rejected"));
    await assert.rejects(resumeIntent(w.ctx, id), (e: unknown) => e instanceof ApiFailure && e.status === 409);
    assert.equal(await usdgBalance(w, payee), 0n);
  });

  it("an approval sent from the owner's wallet is picked up by the approvals task and paid once", async () => {
    const { id, payee } = await queue();
    await ingestReceipt(w.ctx, await sendAsTestOwner(w.ctx, prepareDecision(w.ctx, id, true)));
    assert.equal(getIntentRow(w.ctx, id)!.status, "approved");
    await w.engine.tick();
    assert.equal(getIntentRow(w.ctx, id)!.status, "executed");
    assert.equal(await usdgBalance(w, payee), usdg(220));
    await w.engine.tick();
    assert.equal(await usdgBalance(w, payee), usdg(220), "not paid twice");
  });

  it("two resumes at once send the payment only once", async () => {
    const { id, payee } = await queue();
    await ingestReceipt(w.ctx, await sendAsTestOwner(w.ctx, prepareDecision(w.ctx, id, true)));
    const results = await Promise.allSettled([resumeIntent(w.ctx, id), resumeIntent(w.ctx, id)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(refused.length, 1);
    assert.equal((refused[0].reason as ApiFailure).status, 409);
    assert.equal(await usdgBalance(w, payee), usdg(220));
  });

  it("passkey approvals: refused without a registered passkey, and without a relayer", async () => {
    const { id, payee } = await queue();
    const pk = softPasskey();
    await assert.rejects(decideWithPasskey(w.ctx, id, true, pk.assert(getApproval(w.ctx, id).digest)), (e: unknown) => e instanceof ApiFailure && e.status === 400 && e.message === REVERT_WORDS.NoPasskey);
    const badBody = await a.post(`/v1/approvals/${id}/passkey`, { decision: "approve", assertion: { r: "1" } });
    assert.equal(badBody.status, 400);
    const relayer = w.ctx.chain.accounts.relayer;
    w.ctx.chain.accounts.relayer = null;
    try {
      await assert.rejects(decideWithPasskey(w.ctx, id, true, pk.assert(getApproval(w.ctx, id).digest)), (e: unknown) => e instanceof ApiFailure && e.status === 503);
    } finally {
      w.ctx.chain.accounts.relayer = relayer;
    }
    assert.equal(getIntentRow(w.ctx, id)!.status, "queued");
    assert.equal(await usdgBalance(w, payee), 0n);
  });

  it("a registered passkey can also reject from the phone", async () => {
    const pk = softPasskey();
    const setup = await a.post(`/v1/accounts/${safe}/passkey/prepare`, { x: pk.x, y: pk.y });
    assert.equal((await a.post("/v1/testmode/safe-tx", setup.body)).status, 200);
    const { id, payee } = await queue();
    const p = getApproval(w.ctx, id);
    const r = await a.post(`/v1/approvals/${id}/passkey`, { decision: "reject", assertion: pk.assert(p.rejectChallenge) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result, null);
    assert.equal(getIntentRow(w.ctx, id)!.status, "rejected");
    assert.equal(await usdgBalance(w, payee), 0n);
    // signing the approve challenge cannot be used to reject (and the other way round)
    const second = await queue();
    const wrong = await a.post(`/v1/approvals/${second.id}/passkey`, { decision: "reject", assertion: pk.assert(getApproval(w.ctx, second.id).digest) });
    assert.equal(wrong.status, 400);
    assert.equal(getIntentRow(w.ctx, second.id)!.status, "queued");
  });
});
