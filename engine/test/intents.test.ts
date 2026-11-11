import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { payTypedData, randomNonce, type PayIntent } from "../../packages/sdk/src/eip712.ts";
import { REVERT_WORDS } from "../src/chain.ts";
import { chainNow } from "../src/ctx.ts";
import { createApiKey } from "../src/keys.ts";
import { _test, getIntent, listIntents, resumeIntent, submitIntent } from "../src/intents.ts";
import { getIntentRow } from "../src/receipts.ts";
import { ApiFailure, json, ZERO } from "../src/util.ts";
import { createAccount, defaultRule, makeWorld, randomAddress, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("payment intents: signatures, co-signing, dry runs, failures (local anvil)", () => {
  let w: World;
  let a: Api;
  let safe: Address;
  let key: string;
  const cosigner = privateKeyToAccount(generatePrivateKey());
  let cosafe: Address;

  before(async () => {
    w = await makeWorld();
    a = api(w);
    safe = await createAccount(w);
    cosafe = await createAccount(w, { config: { cosigner: cosigner.address }, rule: { ...defaultRule, cosignAbove: usdg(10).toString() } });
    // an API key whose session key is the account's agent key
    key = createApiKey(w.ctx, { safe, name: "agent", sessionKey: w.keys.agent! }).secret;
  });
  after(async () => w?.stop());

  const pay = (to: Address, amount: bigint, extra: Partial<Parameters<typeof submitIntent>[1]> = {}) =>
    submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to, amount } }, category: "transfer", signer: w.agent, ...extra });

  /** What an agent that keeps its own key sends to POST /v1/intents. */
  async function selfSigned(to: Address, amount: bigint, opts: { nonce?: bigint; deadline?: bigint; signer?: ReturnType<typeof privateKeyToAccount> } = {}) {
    const intent: PayIntent = { safe, token: w.dep.usdg, to, amount, service: `0x${"0".repeat(64)}`, nonce: opts.nonce ?? randomNonce(), deadline: opts.deadline ?? BigInt((await chainNow(w.ctx)) + 600) };
    const signature = await (opts.signer ?? w.agent).signTypedData(payTypedData(w.ctx.cfg.chainId, w.dep.module, intent));
    return { kind: "pay", safe, nonce: intent.nonce.toString(), deadline: intent.deadline.toString(), signature, pay: { token: w.dep.usdg, to, amount: amount.toString() } };
  }

  it("an intent without any signature is refused before anything is stored", async () => {
    const before = listIntents(w.ctx, { safe }).length;
    await assert.rejects(pay(randomAddress(), usdg(1), { signer: null }), (e: unknown) => e instanceof ApiFailure && e.status === 400 && e.code === "no_signature");
    assert.equal(listIntents(w.ctx, { safe }).length, before);
  });

  it("an intent signed by a key that is not the account's agent is blocked and never sent", async () => {
    const payee = randomAddress();
    const r = await pay(payee, usdg(1), { signer: privateKeyToAccount(generatePrivateKey()) });
    assert.equal(r.intent.status, "blocked");
    assert.ok(r.verdict.reasons.some((x) => x.code === "wrong_agent_key"));
    assert.equal(r.intent.txHash, null);
    assert.equal(await usdgBalance(w, payee), 0n);
  });

  it("an agent that keeps its own key signs the intent itself; the same nonce cannot pay twice", async () => {
    const payee = randomAddress();
    const req = await selfSigned(payee, usdg(3));
    const r = await a.post("/v1/intents", req);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.intent.status, "executed");
    assert.equal(await usdgBalance(w, payee), usdg(3));
    const replay = await a.post("/v1/intents", req);
    assert.equal(replay.status, 422, "a refused payment answers 422 with the verdict");
    assert.equal(replay.body.intent.status, "blocked");
    const failed = replay.body.verdict.reasons.find((x: any) => x.code === "simulation_failed");
    assert.ok(failed, JSON.stringify(replay.body.verdict.reasons));
    assert.equal(await usdgBalance(w, payee), usdg(3), "paid once");
  });

  it("an expired intent is refused by the simulation", async () => {
    const r = await a.post("/v1/intents", await selfSigned(randomAddress(), usdg(1), { deadline: BigInt((await chainNow(w.ctx)) - 60) }));
    assert.equal(r.status, 422);
    assert.ok(r.body.verdict.reasons.some((x: any) => x.code === "simulation_failed"));
  });

  it("POST /v1/intents: bad input is 400", async () => {
    const good = await selfSigned(randomAddress(), usdg(1));
    assert.equal((await a.post("/v1/intents", { ...good, pay: undefined })).status, 400, "pay or call is required");
    assert.equal((await a.post("/v1/intents", { ...good, signature: "nothex" })).status, 400);
    assert.equal((await a.post("/v1/intents", { ...good, kind: "steal" })).status, 400);
    assert.equal((await a.post("/v1/intents", { ...good, nonce: "-1" })).status, 400);
    assert.equal((await a.post("/v1/intents", { ...good, safe: "0x1" })).status, 400);
  });

  it("/v1/pay: 401 without a key, 400 for a bad amount, 422 with the verdict when refused", async () => {
    assert.equal((await a.post("/v1/pay", { to: randomAddress(), amount: "1" })).status, 401);
    assert.equal((await a.post("/v1/pay", { to: randomAddress(), amount: "1.5" }, key)).status, 400);
    assert.equal((await a.post("/v1/pay", { to: randomAddress(), amount: "1", category: "gift" }, key)).status, 400);
    const r = await a.post("/v1/pay", { to: randomAddress(), amount: usdg(300).toString() }, key);
    assert.equal(r.status, 422);
    assert.equal(r.body.verdict.decision, "block");
    assert.ok(r.body.verdict.reasons.some((x: any) => x.code === "max_single"));
    const ok = await a.post("/v1/pay", { to: randomAddress(), amount: usdg(1).toString(), memo: "ok" }, key);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.intent.status, "executed");
  });

  it("a dry run checks and simulates but never sends", async () => {
    const payee = randomAddress();
    const r = await pay(payee, usdg(2), { dryRun: true });
    assert.equal(r.verdict.decision, "allow");
    assert.equal(r.intent.status, "ready");
    assert.match(r.intent.error!, /dry run/);
    assert.equal(r.intent.txHash, null);
    assert.equal(await usdgBalance(w, payee), 0n);
    const blocked = await pay(payee, usdg(300), { dryRun: true });
    assert.equal(blocked.intent.status, "blocked");
  });

  it("above the co-sign threshold the intent waits for the second signer, then pays", async () => {
    const payee = randomAddress();
    const r = await submitIntent(w.ctx, { safe: cosafe, spec: { kind: "pay", pay: { token: w.dep.usdg, to: payee, amount: usdg(20) } }, category: "transfer", signer: w.agent });
    assert.equal(r.intent.status, "needs_cosign");
    assert.equal(r.receipt, null);
    assert.equal(await usdgBalance(w, payee), 0n);
    const b = _test.deserialize(getIntentRow(w.ctx, r.intent.id)!);
    assert.equal(b.kind, "pay");
    const typed = payTypedData(w.ctx.cfg.chainId, w.dep.module, b.intent as PayIntent);
    assert.equal((await a.post(`/v1/intents/${r.intent.id}/cosign`, { signature: "0x12zz" })).status, 400);
    const done = await a.post(`/v1/intents/${r.intent.id}/cosign`, { signature: await cosigner.signTypedData(typed) });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.intent.status, "executed", done.body.intent.error ?? "");
    assert.equal(await usdgBalance(w, payee), usdg(20));
    const again = await a.post(`/v1/intents/${r.intent.id}/cosign`, { signature: await cosigner.signTypedData(typed) });
    assert.equal(again.status, 409, "an executed intent cannot be sent again");
    assert.equal(again.body.error.code, "wrong_state");
  });

  it("a co-signature from the wrong key is refused, given up front or later", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const payee = randomAddress();
    const nonce = randomNonce();
    const deadline = BigInt((await chainNow(w.ctx)) + 600);
    const intent: PayIntent = { safe: cosafe, token: w.dep.usdg, to: payee, amount: usdg(20), service: `0x${"0".repeat(64)}`, nonce, deadline };
    const cosignature = await stranger.signTypedData(payTypedData(w.ctx.cfg.chainId, w.dep.module, intent));
    const r = await submitIntent(w.ctx, { safe: cosafe, spec: { kind: "pay", pay: { token: w.dep.usdg, to: payee, amount: usdg(20) } }, category: "transfer", signer: w.agent, nonce, deadline, cosignature });
    assert.equal(r.intent.status, "blocked");
    assert.ok(r.verdict.reasons.some((x) => x.code === "bad_cosign"));

    const waiting = await submitIntent(w.ctx, { safe: cosafe, spec: { kind: "pay", pay: { token: w.dep.usdg, to: payee, amount: usdg(20) } }, category: "transfer", signer: w.agent });
    const typed = payTypedData(w.ctx.cfg.chainId, w.dep.module, _test.deserialize(getIntentRow(w.ctx, waiting.intent.id)!).intent as PayIntent);
    const late = await resumeIntent(w.ctx, waiting.intent.id, await stranger.signTypedData(typed));
    assert.equal(late.intent.status, "blocked", "the module would refuse it, so the firewall blocks it");
    assert.equal(await usdgBalance(w, payee), 0n);
  });

  it("an account whose firewall key this engine does not hold is refused", async () => {
    const other = await createAccount(w, { config: { firewall: randomAddress() } });
    const r = await submitIntent(w.ctx, { safe: other, spec: { kind: "pay", pay: { token: w.dep.usdg, to: randomAddress(), amount: usdg(1) } }, category: "transfer", signer: w.agent });
    assert.equal(r.intent.status, "blocked");
    assert.ok(r.verdict.reasons.some((x) => x.code === "firewall_key"));
  });

  it("with broadcasting off, an allowed intent stops at ready", async () => {
    w.ctx.chain.broadcast = false;
    try {
      const payee = randomAddress();
      const r = await pay(payee, usdg(1));
      assert.equal(r.verdict.decision, "allow");
      assert.equal(r.intent.status, "ready");
      assert.equal(await usdgBalance(w, payee), 0n);
    } finally {
      w.ctx.chain.broadcast = true;
    }
  });

  it("a send that fails is recorded in plain words and audited", async () => {
    const send = w.ctx.chain.send;
    w.ctx.chain.send = async () => {
      throw new Error("execution reverted with custom error 'OverDaily()'");
    };
    try {
      const r = await pay(randomAddress(), usdg(1));
      assert.equal(r.intent.status, "failed");
      assert.equal(r.intent.error, REVERT_WORDS.OverDaily);
      assert.equal(r.receipt, null);
    } finally {
      w.ctx.chain.send = send;
    }
    const last = w.ctx.audit.list({ safe, limit: 1 })[0];
    assert.equal(last.action, "intent.failed");
  });

  it("resume: unknown intents are 404, finished ones 409", async () => {
    await assert.rejects(resumeIntent(w.ctx, "int_missing"), (e: unknown) => e instanceof ApiFailure && e.status === 404);
    const done = await pay(randomAddress(), usdg(1));
    await assert.rejects(resumeIntent(w.ctx, done.intent.id), (e: unknown) => e instanceof ApiFailure && e.status === 409);
    const blocked = await pay(randomAddress(), usdg(300));
    assert.equal((await a.post(`/v1/approvals/${blocked.intent.id}/resume`)).status, 409);
    assert.equal((await a.post(`/v1/approvals/int_missing/resume`)).status, 404);
    assert.equal((await a.get(`/v1/intents/${done.intent.id}`)).body.status, "executed");
    assert.equal(getIntent(w.ctx, "int_missing"), null);
  });

  it("lists intents per account and status, newest first", () => {
    const blocked = listIntents(w.ctx, { safe, status: "blocked" });
    assert.ok(blocked.length >= 3);
    assert.ok(blocked.every((i) => i.status === "blocked" && i.safe === safe.toLowerCase()));
    assert.equal(listIntents(w.ctx, { safe, limit: 2 }).length, 2);
    const all = listIntents(w.ctx, {});
    assert.ok(all.length > blocked.length);
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].createdAt >= all[i].createdAt);
  });

  it("stored intents rebuild exactly: pay, call and treasury", () => {
    const n = 7n;
    const d = 1_900_000_000n;
    for (const spec of [
      { kind: "pay", pay: { token: w.dep.usdg, to: randomAddress(), amount: 5n, service: "model:x" } },
      { kind: "call", call: { target: randomAddress(), value: 1n, data: "0xabcdef" as Hex, spendToken: ZERO, spendLimit: 0n } },
      { kind: "treasury", treasury: { vault: randomAddress(), deposit: true, assets: 9n, limit: 8n } },
    ] as const) {
      const b = _test.build(w.ctx, safe, spec as never, n, d);
      const row = { payload: json({ kind: b.kind, intent: b.intent }), digest: b.digest } as never;
      const back = _test.deserialize(row);
      assert.equal(back.kind, spec.kind);
      assert.equal(_test.txData(back, "0x"), _test.txData(b, "0x"), `${spec.kind}: same transaction`);
    }
  });
});
