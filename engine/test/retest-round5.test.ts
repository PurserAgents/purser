// Regressions for HEY Research Lab's fourth re-test (at 1018dbc) and their marketplace review: M-1 to M-5, the
// heartbeat leftovers, more takeover names and the smaller marketplace notes. Local chain only (anvil).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { erc20Abi, purserEscrowAbi, purserRecurringAbi } from "../../packages/sdk/src/abi.ts";
import { heartbeatTypedData } from "../../packages/sdk/src/eip712.ts";
import { readChainAccount } from "../src/accounts.ts";
import { chainNow } from "../src/ctx.ts";
import { dangerousNamed } from "../src/firewall.ts";
import { indexOnce } from "../src/indexer.ts";
import { invoiceRef } from "../src/invoices.ts";
import { submitIntent } from "../src/intents.ts";
import { createApiKey } from "../src/keys.ts";
import { failureWeight, runKeeper } from "../src/market.ts";
import { createRecurring } from "../src/recurring.ts";
import { ZERO } from "../src/util.ts";
import { createAccount, makeWorld, randomAddress, usdg, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("re-test round 5: the marketplace and the leftovers", () => {
  let w: World;
  let e: Api;
  let owner: string;
  let buyer: Address;
  let seller: Address;
  let buyerKey: string;
  let sellerKey: string;
  let listing: string;

  const key = (safe: Address) => createApiKey(w.ctx, { safe, managed: true, sessionKey: w.keys.agent! }).secret;
  const warp = async (s: number) => {
    await w.rpc("evm_increaseTime", [s]);
    await w.rpc("evm_mine", []);
  };
  const newSeller = async (name: string, price = usdg(5), review = 600) => {
    const s = await createAccount(w, { name, owners: [randomAddress()], fund: 0n });
    const k = key(s);
    const l = await e.post("/v1/market/listings", { title: name, price: price.toString(), deliverySeconds: 600, reviewSeconds: review }, k);
    assert.equal(l.status, 201, JSON.stringify(l.body));
    return { safe: s, key: k, listing: l.body.id as string };
  };
  const hire = (listingId: string, extra: Record<string, unknown> = {}, k = buyerKey) => e.post("/v1/market/hire", { listingId, brief: "Write the secret plan for project Falcon.", ...extra }, k);

  before(async () => {
    w = await makeWorld();
    e = api(w);
    owner = (await e.post("/v1/testmode/session")).body.token;
    buyer = await createAccount(w, { name: "Buyer" });
    buyerKey = key(buyer);
    const s = await newSeller("Seller desk");
    seller = s.safe;
    sellerKey = s.key;
    listing = s.listing;
  });
  after(async () => w?.stop());

  it("M-2: the bus never carries a job's brief or result, and the verdict keeps only the brief's hash", async () => {
    const seen: string[] = [];
    const off = w.ctx.bus.subscribe((ev) => seen.push(JSON.stringify(ev)));
    const h = await hire(listing);
    assert.equal(h.status, 201, JSON.stringify(h.body));
    const d = await e.post(`/v1/market/jobs/${h.body.job.id}/deliver`, { result: "THE SECRET RESULT for Falcon" }, sellerKey);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.job.result, "THE SECRET RESULT for Falcon", "the seller's own answer still has it");
    off();
    const all = seen.join("\n") + JSON.stringify(w.ctx.bus.since(0));
    assert.doesNotMatch(all, /SECRET RESULT/);
    assert.doesNotMatch(all, /secret plan for project Falcon/);
    const v = await e.get(`/v1/verdicts/${h.body.verdict.id}`);
    assert.match(v.body.trigger, /^sha256:[0-9a-f]{64} /);
    assert.doesNotMatch(JSON.stringify(v.body), /Falcon/);
    const detail = await e.get(`/v1/market/jobs/${h.body.job.id}/detail`, buyerKey);
    assert.equal(detail.body.result, "THE SECRET RESULT for Falcon", "the buyer reads it");
    assert.equal(keccak256(toHex(detail.body.result)), detail.body.deliveryHash, "the result kept is the one on chain");
  });

  it("M-1: a job funded with another arbiter or review window does not fund the invoice; a failed hire's invoice is closed", async () => {
    const arbiter = randomAddress();
    const inv = await e.post("/v1/invoices", { payer: buyer, amount: usdg(3).toString(), description: "With an arbiter", arbiter, reviewPeriodSeconds: 3600 }, sellerKey);
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const r = inv.body;
    for (const [arb, review] of [[ZERO, 3600], [arbiter, 4_294_967_295]] as const) {
      const data = encodeFunctionData({ abi: purserEscrowAbi, functionName: "fund", args: [seller, arb as Address, w.dep.usdg, usdg(3), BigInt(r.deadline), review, invoiceRef(r.id) as Hex] });
      const res = await submitIntent(w.ctx, { safe: buyer, spec: { kind: "call", call: { target: w.dep.escrow, value: 0n, data, spendToken: w.dep.usdg, spendLimit: usdg(3) } }, category: "escrow", signer: privateKeyToAccount(w.keys.agent!) });
      assert.equal(res.intent.status, "executed", res.intent.error ?? "");
      await indexOnce(w.ctx);
      assert.equal((await e.get(`/v1/invoices/${r.id}`)).body.status, "open", `a job with arbiter ${arb} and review ${review} does not count`);
    }
    // a hire the owner's rules block: its invoice can never be funded afterwards
    assert.equal((await e.put(`/v1/accounts/${buyer}/hire-rules`, { mode: "off" }, owner)).status, 200);
    const blocked = await hire(listing);
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.job.status, "blocked");
    assert.equal((await e.get(`/v1/invoices/${blocked.body.job.invoiceId}`)).body.status, "cancelled");
    assert.equal((await e.put(`/v1/accounts/${buyer}/hire-rules`, { mode: "any" }, owner)).status, 200);
    // and it does not fill the seller's job list
    assert.ok(!(await e.get(`/v1/accounts/${seller}/jobs`)).body.items.some((j: { id: string }) => j.id === blocked.body.job.id));
    assert.ok((await e.get(`/v1/accounts/${buyer}/jobs`)).body.items.some((j: { id: string }) => j.id === blocked.body.job.id), "the buyer still sees it");
  });

  it("M-3: the buyer names the most it pays; an arbiter tied to the seller is refused; hire rules are private", async () => {
    const changed = await hire(listing, { maxPrice: usdg(4).toString() });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, "price_changed");
    const l = (await e.get(`/v1/market/listings/${listing}`)).body;
    assert.equal((await hire(listing, { listingUpdatedAt: l.updatedAt - 1 })).body.error.code, "listing_changed");
    const tied = randomAddress();
    const s = await createAccount(w, { name: "Tied seller", owners: [tied], fund: 0n });
    const bad = await e.post("/v1/market/listings", { title: "Judged by me", price: usdg(5).toString(), deliverySeconds: 600, arbiter: tied }, key(s));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "arbiter_not_independent");
    assert.equal((await e.get(`/v1/accounts/${buyer}/hire-rules`)).status, 401);
    assert.equal((await e.get(`/v1/accounts/${buyer}/hire-rules`, sellerKey)).status, 403);
    assert.equal((await e.get(`/v1/accounts/${buyer}/hire-rules`, buyerKey)).status, 200);
  });

  it("M-4: payouts the engine will never relay stop holding the keeper's queue; invoices have a floor", async () => {
    assert.equal((await e.post("/v1/invoices", { payer: buyer, amount: "1", description: "Dust" }, sellerKey)).body.error.code, "too_small");
    // a real job past its deadline, behind 25 dust jobs whose refunds go to plain wallets
    const h = await hire(listing);
    assert.equal(h.status, 201, JSON.stringify(h.body));
    const t = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 25; i++)
      w.ctx.db
        .prepare("INSERT INTO invoices (id, payee, payer, arbiter, token, amount, description, deadline, review_period, status, job_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, '10000', 'dust', 1, 600, 'funded', ?, 1, 1)")
        .run(`inv_dust_${i}`, seller.toLowerCase(), randomAddress().toLowerCase(), w.dep.usdg.toLowerCase(), String(900000 + i));
    void t;
    await warp(700);
    const first = await runKeeper(w.ctx);
    const second = await runKeeper(w.ctx);
    const refunded = [...first.refunded, ...second.refunded];
    assert.ok(refunded.includes(h.body.job.invoiceId), "the real refund went out despite the dust");
    const never = (w.ctx.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'keeper:inv_dust_%' AND value = '9999999999'").get() as { n: number }).n;
    assert.ok(never >= 20, `${never} dust rows marked never`);
  });

  it("M-5: an owner's daily limit for one payee holds through the escrow", async () => {
    const limited = await createAccount(w, { name: "Limited buyer", rule: { maxSingle: usdg(250).toString(), daily: usdg(1000).toString(), weekly: usdg(5000).toString(), perCounterpartyDaily: usdg(5).toString(), approvalAbove: usdg(200).toString(), cosignAbove: null } });
    const pricey = await newSeller("Pricey desk", usdg(20));
    const r = await hire(pricey.listing, {}, key(limited));
    assert.equal(r.status, 422, JSON.stringify(r.body.verdict?.reasons ?? r.body));
    assert.ok(r.body.verdict.reasons.some((x: { code: string }) => x.code === "counterparty_limit"));
  });

  it("7. heartbeats: none ahead of the chain's time, one relay per 30 seconds even at once, gas on the payee or the open share", async () => {
    const payee = privateKeyToAccount(generatePrivateKey());
    const s = await createRecurring(w.ctx, buyer, privateKeyToAccount(w.keys.agent!), { kind: "stream", payee: payee.address, token: w.dep.usdg, rate: 1000n, maxDuration: 86_400n, grace: 600 });
    assert.equal(s.intent.status, "executed", s.intent.error ?? "");
    const sid = s.streamId!;
    const sign = (t: number) => payee.signTypedData(heartbeatTypedData(4663, w.dep.recurring, BigInt(sid), BigInt(t)));
    const now0 = await chainNow(w.ctx);
    const future = now0 + 86_000;
    assert.equal((await e.post(`/v1/streams/${sid}/heartbeat`, { upTo: future, signature: await sign(future) })).body.error.code, "future_heartbeat");
    await warp(60);
    const t = await chainNow(w.ctx);
    const relayer = w.ctx.chain.accounts.relayer!.address;
    const openBefore = w.ctx.chain.gasSpent(relayer, "open");
    const payerBefore = w.ctx.chain.gasSpent(relayer, `acct:${buyer.toLowerCase()}`);
    const sigs = await Promise.all([0, 1, 2, 3, 4].map((i) => sign(t - i)));
    const out = await Promise.all(sigs.map((signature, i) => e.post(`/v1/streams/${sid}/heartbeat`, { upTo: t - i, signature })));
    assert.equal(out.filter((r) => r.status === 200).length, 1, out.map((r) => r.status).join(", "));
    assert.ok(w.ctx.chain.gasSpent(relayer, "open") > openBefore, "a plain wallet's heartbeat counts against the open share");
    assert.equal(w.ctx.chain.gasSpent(relayer, `acct:${buyer.toLowerCase()}`), payerBefore, "not against the paying account");
    const chain = await w.ctx.chain.pub.readContract({ address: w.dep.recurring, abi: purserRecurringAbi, functionName: "streams", args: [BigInt(sid)] });
    assert.ok(Number(chain[7]) <= t);
  });

  it("8. more takeover functions named as text", () => {
    for (const n of ["setPendingAdmin", "acceptOwnership", "setAdmin", "upgrade", "upgradeAndCall", "setImplementation", "nominateNewOwner", "setGovernance"])
      assert.deepEqual(dangerousNamed(toHex(`call ${n}(address)`)), [n], n);
    assert.deepEqual(dangerousNamed(toHex("upgradeable(uint256)")), []);
  });

  it("9. hire rules per seller per day, review window and arbiters; hiring five sellers at one price is not a loop", async () => {
    const hb = await createAccount(w, { name: "Busy buyer" });
    const hk = key(hb);
    const sellers = [] as { safe: Address; listing: string }[];
    for (let i = 0; i < 5; i++) sellers.push(await newSeller(`Worker ${i}`));
    for (const s of sellers) assert.equal((await hire(s.listing, {}, hk)).status, 201);
    assert.equal((await readChainAccount(w.ctx, hb)).frozen, false, "five sellers at one price is not a loop");
    assert.equal((await e.put(`/v1/accounts/${hb}/hire-rules`, { mode: "any", maxPerSellerPerDay: usdg(10).toString(), minReviewSeconds: 3600 }, owner)).status, 200);
    const short = await hire(sellers[0].listing, {}, hk);
    assert.ok(short.body.verdict.reasons.some((x: { code: string }) => x.code === "hire_review_too_short"));
    const slow = await newSeller("Careful reviewer", usdg(6), 7200);
    assert.equal((await hire(slow.listing, {}, hk)).status, 201);
    const again = await hire(slow.listing, {}, hk);
    assert.ok(again.body.verdict.reasons.some((x: { code: string }) => x.code === "hire_max_per_seller"), "$12 to one seller in a day is over $10");
    assert.equal((await e.put(`/v1/accounts/${hb}/hire-rules`, { mode: "any", arbiters: [randomAddress()] }, owner)).status, 200);
    const noArb = await hire(slow.listing, {}, hk);
    assert.ok(noArb.body.verdict.reasons.some((x: { code: string }) => x.code === "hire_arbiter_not_allowed"));
  });

  it("9. one delivery at a time; listings are rate limited; buyer-caused disputes weigh less; linked accounts do not rate", async () => {
    const h = await hire(listing);
    assert.equal(h.status, 201, JSON.stringify(h.body));
    const both = await Promise.all(["first answer", "second answer"].map((result) => e.post(`/v1/market/jobs/${h.body.job.id}/deliver`, { result }, sellerKey)));
    assert.equal(both.filter((r) => r.status === 200).length, 1, both.map((r) => `${r.status} ${r.body.error?.code ?? ""}`).join(", "));
    const detail = (await e.get(`/v1/market/jobs/${h.body.job.id}/detail`, buyerKey)).body;
    assert.equal(keccak256(toHex(detail.result)), detail.deliveryHash);

    const spammer = await createAccount(w, { name: "Spammer", owners: [randomAddress()], fund: 0n });
    const sk = key(spammer);
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await e.post("/v1/market/listings", { title: `Listing ${i}`, price: usdg(1).toString(), deliverySeconds: 600 }, sk)).status);
    assert.equal(codes.filter((c) => c === 201).length, 20);
    assert.equal(codes[20], 429);

    assert.equal(failureWeight({ status: "refunded", arbiter: null, delivered_at: null }), 1, "nothing delivered: a real failure");
    assert.equal(failureWeight({ status: "refunded", arbiter: null, delivered_at: 1 }), 0.25, "the buyer disputed with no arbiter");
    assert.equal(failureWeight({ status: "resolved", arbiter: "0x1", delivered_at: 1 }), 0.5);
    assert.equal(failureWeight({ status: "released", arbiter: null, delivered_at: 1 }), 0);

    // accounts that paid each other count as one owner: their jobs never rate or count
    const friend = await newSeller("Friend desk");
    const direct = await submitIntent(w.ctx, { safe: buyer, spec: { kind: "pay", pay: { token: w.dep.usdg, to: friend.safe, amount: usdg(1) } }, category: "transfer", signer: privateKeyToAccount(w.keys.agent!) });
    assert.equal(direct.intent.status, "executed");
    const linked = await hire(friend.listing);
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.job.sameOwner, true);
    void erc20Abi;
  });
});
