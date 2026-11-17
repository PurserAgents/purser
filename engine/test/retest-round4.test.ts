// Regressions for HEY Research Lab's re-test of b5cea77 / 316ac1f: the small leftovers. Local chain only (anvil).
//   1. the shared list never takes Purser's own payees (the models address, the engine's keys);
//   2. a stale or replayed heartbeat is not relayed, and heartbeats are rate limited;
//   3. ETH: the replay and the balances must both show the payment;
//   4. a takeover function named as text (a timelock call) is blocked;
//   5. withdrawals: a minimum, a cap on waiting ones, and paging that never pushes the oldest off;
//   6. Shield standing counts only money that cannot come back;
//   7. the watchdog lets six model top-ups an hour through, not more;
//   8. a withdrawal leaves running calls' reservations in the credit.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { createWalletClient, encodeDeployData, encodeFunctionData, http, pad, parseAbi, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { purserModuleAbi, purserRecurringAbi } from "../../packages/sdk/src/abi.ts";
import { heartbeatTypedData, packSignatures, payDigest, payTypedData, randomNonce } from "../../packages/sdk/src/eip712.ts";
import { readChainAccount } from "../src/accounts.ts";
import { chainNow } from "../src/ctx.ts";
import { artifact } from "../src/deploy.ts";
import { dangerousNamed } from "../src/firewall.ts";
import { indexOnce } from "../src/indexer.ts";
import { submitIntent } from "../src/intents.ts";
import { createApiKey } from "../src/keys.ts";
import { creditMicro, CREDIT_SERVICE } from "../src/models.ts";
import { _test as proofTest, txProof } from "../src/proof.ts";
import { createRecurring } from "../src/recurring.ts";
import { inStanding, recordThreats, trusted } from "../src/shield.ts";
import { listWatchEvents } from "../src/watchdog.ts";
import { ZERO } from "../src/util.ts";
import { createAccount, makeWorld, randomAddress, usdg, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

const ZERO32 = `0x${"0".repeat(64)}` as Hex;

const deploy = async (w: World, file: string, name: string, args: unknown[] = []) => {
  const a = artifact(file, name);
  const relayer = w.ctx.chain.accounts.relayer!;
  const hash = await w.ctx.chain.wallet(relayer).sendTransaction({ account: relayer, chain: w.ctx.chain.chain, data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) });
  return (await w.ctx.chain.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 })).contractAddress!;
};

function standIn() {
  let delayMs = 0;
  const app = new Hono();
  app.post("/v1/messages", async (c) => {
    const b = await c.req.json();
    await new Promise((r) => setTimeout(r, delayMs));
    return c.json({ id: "msg", type: "message", role: "assistant", model: b.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 20, output_tokens: 50 } });
  });
  return { app, delay: (ms: number) => (delayMs = ms) };
}

describe("re-test round 4", () => {
  let w: World;
  let e: Api;
  let owner: string;
  let server: ServerType;
  const provider = standIn();
  const company = randomAddress();
  const saved = { url: process.env.PURSER_MODELS_URL, key: process.env.PURSER_MODELS_KEY, payTo: process.env.PURSER_MODELS_PAYTO };

  const keyFor = async (safe: Address) => {
    const k = await e.post(`/v1/accounts/${safe}/keys`, { managed: true }, owner);
    const acct = (await e.get(`/v1/accounts/${safe}`)).body;
    await e.post("/v1/testmode/safe-tx", (await e.post(`/v1/accounts/${safe}/rules/prepare`, { config: { ...acct.config, agent: k.body.key.sessionAddress } })).body);
    return k.body.secret as string;
  };
  const pay = (safe: Address, to: Address, amount: bigint, service?: string) =>
    submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to, amount, service } }, category: "transfer", signer: w.agent });

  before(async () => {
    w = await makeWorld();
    server = serve({ fetch: provider.app.fetch, port: 0 });
    await new Promise((r) => server.once("listening", r));
    process.env.PURSER_MODELS_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.PURSER_MODELS_KEY = "sk-ant-test";
    process.env.PURSER_MODELS_PAYTO = company;
    e = api(w);
    owner = (await e.post("/v1/testmode/session")).body.token;
  });
  after(async () => {
    for (const [k, v] of [["PURSER_MODELS_URL", saved.url], ["PURSER_MODELS_KEY", saved.key], ["PURSER_MODELS_PAYTO", saved.payTo]] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    server?.close();
    await w?.stop();
  });

  it("1. the models address and the engine's own keys are never put on the shared list", async () => {
    for (const a of [company, w.ctx.chain.accounts.relayer!.address, w.ctx.chain.accounts.firewall!.address, w.ctx.chain.accounts.watchdog!.address, w.dep.feeRecipient, w.dep.escrow])
      assert.equal(trusted(w.ctx, a), true, a);
    const safe = await createAccount(w, { name: "Reporter" });
    assert.deepEqual(recordThreats(w.ctx, safe, "v1", [{ address: company, kind: "planted_payee" }], [], Math.floor(Date.now() / 1000)), []);
    assert.equal(w.ctx.db.prepare("SELECT 1 FROM shield_threats WHERE address = ?").get(company.toLowerCase()), undefined, "not even a local entry");
  });

  it("2. a heartbeat not newer than the last one is refused before any gas is spent; heartbeats are rate limited", async () => {
    const payee = privateKeyToAccount(generatePrivateKey());
    const safe = await createAccount(w, { name: "Streamer" });
    const s = await createRecurring(w.ctx, safe, w.agent, { kind: "stream", payee: payee.address, token: w.dep.usdg, rate: 1000n, maxDuration: 86_400n, grace: 600 });
    assert.equal(s.intent.status, "executed", s.intent.error ?? "");
    const sid = s.streamId!;
    await w.rpc("evm_increaseTime", [60]);
    await w.rpc("evm_mine", []);
    const upTo = await chainNow(w.ctx);
    const sign = (t: number) => payee.signTypedData(heartbeatTypedData(4663, w.dep.recurring, BigInt(sid), BigInt(t)));
    const first = await e.post(`/v1/streams/${sid}/heartbeat`, { upTo, signature: await sign(upTo) });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const relayer = w.ctx.chain.accounts.relayer!.address;
    const nonce = await w.ctx.chain.pub.getTransactionCount({ address: relayer });
    // the same signed heartbeat again, read from the chain by anyone
    const replay = await e.post(`/v1/streams/${sid}/heartbeat`, { upTo, signature: await sign(upTo) });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, "stale_heartbeat");
    // an older one
    assert.equal((await e.post(`/v1/streams/${sid}/heartbeat`, { upTo: upTo - 10, signature: await sign(upTo - 10) })).status, 409);
    // a newer one right after the last: too soon
    await w.rpc("evm_increaseTime", [5]);
    await w.rpc("evm_mine", []);
    const newer = (await chainNow(w.ctx)) - 1;
    assert.equal((await e.post(`/v1/streams/${sid}/heartbeat`, { upTo: newer, signature: await sign(newer) })).status, 429);
    assert.equal(await w.ctx.chain.pub.getTransactionCount({ address: relayer }), nonce, "nothing was relayed for any of them");
    const chain = await w.ctx.chain.pub.readContract({ address: w.dep.recurring, abi: purserRecurringAbi, functionName: "streams", args: [BigInt(sid)] });
    assert.equal(Number(chain[7]), upTo);
  });

  it("3. ETH: code that pays only when the gas price is zero passes the replay but not the balances, and is not booked", async () => {
    const safe = await createAccount(w, { name: "Gas price trick" });
    const payee = randomAddress();
    const amount = 10n ** 15n;
    const impl = await deploy(w, "RetestHelpers.sol", "GasPriceSafe");
    await w.rpc("anvil_setStorageAt", [safe, "0x0", pad(impl, { size: 32 })]);
    const block = await w.ctx.chain.pub.getBlock();
    const intent = { safe, token: ZERO, to: payee, amount, service: ZERO32, nonce: randomNonce(), deadline: block.timestamp + 600n };
    const sig = await w.agent.signTypedData(payTypedData(w.ctx.cfg.chainId, w.dep.module, intent));
    const fw = await w.ctx.chain.accounts.firewall!.sign({ hash: payDigest(w.ctx.cfg.chainId, w.dep.module, intent) });
    const sender = privateKeyToAccount(generatePrivateKey());
    await w.rpc("anvil_setBalance", [sender.address, "0xDE0B6B3A7640000"]);
    const wallet = createWalletClient({ account: sender, chain: w.ctx.chain.chain, transport: http(w.anvil.url) });
    const hash = await wallet.sendTransaction({ account: sender, chain: w.ctx.chain.chain, to: w.dep.module, data: encodeFunctionData({ abi: purserModuleAbi, functionName: "pay", args: [intent, packSignatures(sig, fw)] }), gas: 600_000n });
    const r = await w.ctx.chain.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    assert.equal(r.status, "success");
    assert.ok(r.effectiveGasPrice > 0n);
    assert.equal(await w.ctx.chain.pub.getBalance({ address: payee }), 0n, "on chain nothing moved");
    const traced = await proofTest.ethMovedBy(w.ctx, r);
    assert.ok(traced?.some((t) => t.from === safe.toLowerCase() && t.to === payee.toLowerCase() && t.value === amount), "the replay alone would have shown the payment");
    assert.equal(await txProof(w.ctx, r).proves({ payer: safe, token: ZERO, to: payee, amount }), false, "the balances did not move: not proven");
    await indexOnce(w.ctx);
    assert.equal(w.ctx.db.prepare("SELECT 1 FROM receipts WHERE safe = ? AND counterparty = ?").get(safe.toLowerCase(), payee.toLowerCase()), undefined);
  });

  it("4. a takeover named as text in a timelock call is blocked", async () => {
    const timelockAbi = parseAbi(["function executeTransaction(address target, uint256 value, string signature, bytes data, uint256 eta)"]);
    const inner = pad(randomAddress(), { size: 32 });
    const data = encodeFunctionData({ abi: timelockAbi, functionName: "executeTransaction", args: [randomAddress(), 0n, "transferOwnership(address)", inner, 0n] });
    assert.deepEqual(dangerousNamed(data), ["transferOwnership"]);
    assert.deepEqual(dangerousNamed(encodeFunctionData({ abi: timelockAbi, functionName: "executeTransaction", args: [randomAddress(), 0n, "transfer(address,uint256)", inner, 0n] })), []);
    const timelock = await deploy(w, "RetestHelpers.sol", "BurnOnReceive"); // any contract the owner allowed
    const safe = await createAccount(w, { name: "Timelock admin", allow: [timelock] });
    const r = await submitIntent(w.ctx, { safe, spec: { kind: "call", call: { target: timelock, value: 0n, data, spendToken: ZERO, spendLimit: 0n } }, category: "onchain", signer: w.agent, dryRun: true });
    assert.ok(r.verdict.reasons.some((x) => x.code === "dangerous_call" && /names transferOwnership/.test(x.detail)), JSON.stringify(r.verdict.reasons));
  });

  it("5. withdrawals: at least $0.25 (or all that is left), at most three waiting per account, pages that keep the oldest first", async () => {
    const safe = await createAccount(w, { name: "Withdrawer" });
    const secret = createApiKey(w.ctx, { safe, managed: false }).secret;
    void secret;
    assert.equal((await pay(safe, company, usdg(2), CREDIT_SERVICE)).intent.status, "executed");
    assert.equal(creditMicro(w.ctx, safe), 2_000_000n);
    const tiny = await e.post(`/v1/accounts/${safe}/model-credit/withdraw`, { usd: 0.000001 }, owner);
    assert.equal(tiny.status, 409);
    assert.equal(tiny.body.error.code, "too_small");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await e.post(`/v1/accounts/${safe}/model-credit/withdraw`, { usd: 0.25 }, owner);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      ids.push(r.body.id);
    }
    const fourth = await e.post(`/v1/accounts/${safe}/model-credit/withdraw`, { usd: 0.25 }, owner);
    assert.equal(fourth.body.error.code, "too_many_pending");
    const p1 = await e.get("/v1/models/withdrawals?limit=2");
    assert.equal(p1.body.items.length, 2);
    assert.ok(p1.body.next);
    const p2 = await e.get(`/v1/models/withdrawals?limit=2&after=${p1.body.next}`);
    const all = [...p1.body.items, ...p2.body.items].map((x: { id: string }) => x.id);
    assert.deepEqual(all.slice(-3), ids, "oldest first, nothing skipped across pages");
    // less than the minimum left: all of it may go
    const other = await createAccount(w, { name: "Small credit" });
    assert.equal((await pay(other, company, 100_000n, CREDIT_SERVICE)).intent.status, "executed");
    const rest = await e.post(`/v1/accounts/${other}/model-credit/withdraw`, {}, owner);
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    assert.equal(rest.body.usd, "0.100000");
  });

  it("6. standing: credit that was only bought, or money paid to an account of the same owner or one that pays back, does not count", async () => {
    const safe = await createAccount(w, { name: "Standing" });
    for (let i = 0; i < 3; i++) assert.equal((await pay(safe, randomAddress(), usdg(7))).intent.status, "executed");
    assert.equal((await pay(safe, company, usdg(5), CREDIT_SERVICE)).intent.status, "executed");
    const own = randomAddress().toLowerCase();
    const setOwners = (s: Address, o: string) => {
      w.ctx.db.prepare("UPDATE accounts SET owners = ? WHERE safe = ?").run(JSON.stringify([o]), s.toLowerCase());
      w.ctx.db.prepare("DELETE FROM kv WHERE key = ?").run(`owners_seen:${s.toLowerCase()}`);
    };
    setOwners(safe, own);
    const age = () => w.ctx.db.prepare("UPDATE receipts SET created_at = created_at - 31 * 86400 WHERE safe = ? AND created_at > ?").run(safe.toLowerCase(), Math.floor(Date.now() / 1000) - 86400);
    age();
    assert.equal(inStanding(w.ctx, safe), false, "$5 of credit bought and not used can be withdrawn");
    // a fourth account of the same owner
    const sibling = await createAccount(w, { name: "Sibling" });
    setOwners(sibling, own);
    assert.equal((await pay(safe, sibling, usdg(5))).intent.status, "executed");
    age();
    assert.equal(inStanding(w.ctx, safe), false, "paid to its own owner's account");
    // an independent account that pays it back
    const friend = await createAccount(w, { name: "Friend" });
    setOwners(friend, randomAddress().toLowerCase());
    assert.equal((await pay(safe, friend, usdg(5))).intent.status, "executed");
    age();
    assert.equal((await pay(friend, safe, usdg(5))).intent.status, "executed");
    assert.equal(inStanding(w.ctx, safe), false, "the money came back");
    // an independent account that does not
    const vendor = await createAccount(w, { name: "Vendor" });
    setOwners(vendor, randomAddress().toLowerCase());
    assert.equal((await pay(safe, vendor, usdg(5))).intent.status, "executed");
    age();
    assert.equal(inStanding(w.ctx, safe), true, "paid to an independent account, not paid back");
  });

  it("7. six model top-ups an hour pass the watchdog; more are counted like any payment", async () => {
    const safe = await createAccount(w, { name: "Top-up loop" });
    const secret = await keyFor(safe);
    const statuses: string[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await e.post("/v1/pay", { to: company, amount: usdg(5).toString(), service: CREDIT_SERVICE }, secret)).body.intent.status);
    assert.deepEqual(statuses.slice(0, 6), ["executed", "executed", "executed", "executed", "executed", "executed"]);
    assert.ok(statuses.some((s) => s !== "executed"), statuses.join(", "));
    assert.ok(listWatchEvents(w.ctx, safe).some((x) => x.kind === "loop" || x.kind === "burst"));
    assert.equal((await readChainAccount(w.ctx, safe)).frozen, true);
  });

  it("8. a withdrawal while a call runs leaves that call's reservation in the credit", async () => {
    const safe = await createAccount(w, { name: "Running" });
    const top = await pay(safe, company, usdg(1), CREDIT_SERVICE);
    assert.equal(top.intent.status, "executed", JSON.stringify(top.verdict.reasons));
    const secret = await keyFor(safe);
    provider.delay(400);
    const call = e.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: "purser/claude-opus-5-5", messages: [{ role: "user", content: "Write it." }], max_tokens: 4000 }),
    });
    await new Promise((r) => setTimeout(r, 150));
    const during = creditMicro(w.ctx, safe); // the credit after the call's reservation
    const reserved = 1_000_000n - during;
    assert.ok(reserved > 0n);
    const wd = await e.post(`/v1/accounts/${safe}/model-credit/withdraw`, {}, owner);
    assert.equal(wd.status, 201, JSON.stringify(wd.body));
    assert.equal(BigInt(Math.round(Number(wd.body.usd) * 1e6)), during - reserved, "as much as the call reserved stays behind");
    assert.equal((await call).status, 200);
    provider.delay(0);
    assert.ok(creditMicro(w.ctx, safe) >= 0n);
    void toHex;
  });
});
