// Phase 05: agents hire agents. Local chain only (anvil). Every attack on the hire and escrow path is tried here and
// must fail: double release, release by the wrong party, refund before the deadline, rating without paying, rating
// twice, hiring outside the owner's rules (through the API and with a raw escrow call), and a fake Safe.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createWalletClient, encodeDeployData, encodeFunctionData, http, keccak256, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { erc20Abi, purserEscrowAbi, purserModuleAbi } from "../../packages/sdk/src/abi.ts";
import { configToChain, ruleToChain } from "../src/accounts.ts";
import { decideAsTestOwner } from "../src/approvals.ts";
import { chainNow } from "../src/ctx.ts";
import { artifact } from "../src/deploy.ts";
import { indexOnce } from "../src/indexer.ts";
import { invoiceRef } from "../src/invoices.ts";
import { createApiKey, issueOwnerSession } from "../src/keys.ts";
import { APPROVAL_WINDOW, runKeeper } from "../src/market.ts";
import { submitIntent } from "../src/intents.ts";
import { createAccount, makeWorld, randomAddress, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("marketplace: agents hire agents (phase 05, local)", () => {
  let w: World;
  let e: Api;
  let owner: string; // the test owner's session: owns the buyer and the sibling
  let buyer: Address;
  let seller: Address;
  let third: Address;
  let sibling: Address;
  const keys: Record<string, string> = {};
  const listings: Record<string, string> = {};

  const key = (safe: Address) => createApiKey(w.ctx, { safe, managed: true, sessionKey: w.keys.agent! }).secret;
  const warp = async (s: number) => {
    await w.rpc("evm_increaseTime", [s]);
    await w.rpc("evm_mine", []);
  };
  const hire = (listingId: string, brief = "Do the job described in the listing.", k = keys.buyer) => e.post("/v1/market/hire", { listingId, brief }, k);
  const job = async (id: string) => (await e.get(`/v1/market/jobs/${id}`)).body;
  const setRules = (rules: unknown, token = owner) => e.put(`/v1/accounts/${buyer}/hire-rules`, rules, token);
  /** The agent's own call to the escrow, signed with its session key: no marketplace endpoint involved. */
  const rawEscrow = (safe: Address, data: Hex, spend?: { token: Address; amount: bigint }) =>
    submitIntent(w.ctx, {
      safe,
      spec: { kind: "call", call: { target: w.dep.escrow, value: 0n, data, spendToken: spend?.token ?? ("0x" + "0".repeat(40)) as Address, spendLimit: spend?.amount ?? 0n } },
      category: "escrow",
      signer: privateKeyToAccount(w.keys.agent!),
    });

  before(async () => {
    w = await makeWorld();
    e = api(w);
    owner = (await e.post("/v1/testmode/session")).body.token;
    buyer = await createAccount(w, { name: "Buyer agent" });
    seller = await createAccount(w, { name: "Research desk", owners: [randomAddress()], fund: 0n });
    third = await createAccount(w, { name: "Third agent", owners: [randomAddress()] });
    sibling = await createAccount(w, { name: "Sibling agent", fund: 0n });
    for (const [n, s] of Object.entries({ buyer, seller, third, sibling })) keys[n] = key(s);
  });
  after(async () => w?.stop());

  it("05.1 a storefront service becomes a listing; search filters and ranks", async () => {
    const svc = await e.post("/v1/storefront/services", { name: "Competitor research", description: "Ten pages on a company's rivals.", price: usdg(5).toString(), response: "{}" }, keys.seller);
    assert.equal(svc.status, 201, JSON.stringify(svc.body));
    const a = await e.post("/v1/market/listings", { serviceId: svc.body.id, deliverySeconds: 3600, reviewSeconds: 600, tags: ["Research"] }, keys.seller);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.title, "Competitor research");
    assert.equal(a.body.price.amount, usdg(5).toString());
    assert.deepEqual(a.body.tags, ["research"]);
    const b = await e.post("/v1/market/listings", { title: "Logo set", description: "Three logo options.", price: usdg(40).toString(), deliverySeconds: 86400, reviewSeconds: 3600 }, keys.seller);
    const big = await e.post("/v1/market/listings", { title: "Full audit", description: "A full code audit.", price: usdg(220).toString(), deliverySeconds: 2 * 86400, reviewSeconds: 3600 }, keys.seller);
    const sib = await e.post("/v1/market/listings", { title: "Sibling summary", price: usdg(3).toString(), deliverySeconds: 600, reviewSeconds: 600 }, keys.sibling);
    Object.assign(listings, { research: a.body.id, logo: b.body.id, audit: big.body.id, sibling: sib.body.id });

    assert.equal((await e.post("/v1/market/listings", { title: "No price", deliverySeconds: 600 }, keys.seller)).status, 400);
    assert.equal((await e.post("/v1/market/listings", { title: "Sneaky", price: "1", deliverySeconds: 600 }, keys.buyer.replace(/.$/, "x"))).status, 401);

    const found = await e.get("/v1/market/listings?q=rivals");
    assert.equal((await e.get("/v1/market/listings?q=research%20desk")).body.items.length, 3, "the seller name is searched too");
    assert.deepEqual(found.body.items.map((l: any) => l.id), [listings.research]);
    const cheap = await e.get("/v1/market/listings?sort=price");
    assert.equal(cheap.body.items[0].id, listings.sibling);
    const fast = await e.get("/v1/market/listings?maxHours=2");
    assert.deepEqual(new Set(fast.body.items.map((l: any) => l.id)), new Set([listings.research, listings.sibling]));
    const capped = await e.get(`/v1/market/listings?maxPrice=${usdg(10)}`);
    assert.ok(capped.body.items.every((l: any) => BigInt(l.price.amount) <= usdg(10)));
    assert.ok(found.body.items[0].score > 0 && found.body.items[0].score <= 1);
  });

  let first: any;
  it("05.2 hire, deliver, accept: the money goes into escrow through the module and out to the seller", async () => {
    const before = await usdgBalance(w, buyer);
    const h = await hire(listings.research, "Research Acme Corp's three biggest rivals.");
    assert.equal(h.status, 201, JSON.stringify(h.body.verdict ?? h.body));
    first = h.body.job;
    assert.equal(first.status, "funded");
    assert.ok(first.escrowJobId);
    assert.equal(await usdgBalance(w, w.dep.escrow), usdg(5));
    // the module charged its fee on the outflow: the money left through the module, not around it
    assert.ok(before - (await usdgBalance(w, buyer)) > usdg(5));
    assert.equal(h.body.intent.status, "executed");

    // the seller sees the job and the brief; a stranger sees neither the brief nor the result
    const mine = await e.get(`/v1/accounts/${seller}/jobs?role=seller`);
    assert.ok(mine.body.items.some((j: any) => j.id === first.id));
    assert.equal((await e.get(`/v1/market/jobs/${first.id}/detail`, keys.seller)).body.brief, "Research Acme Corp's three biggest rivals.");
    assert.equal((await e.get(`/v1/market/jobs/${first.id}/detail`, keys.third)).status, 403);
    assert.equal((await e.get(`/v1/market/jobs/${first.id}`)).body.brief, undefined);

    assert.equal((await e.post(`/v1/market/jobs/${first.id}/accept`, {}, keys.buyer)).status, 409, "nothing delivered yet");
    assert.equal((await e.post(`/v1/market/jobs/${first.id}/deliver`, { result: "fake" }, keys.buyer)).status, 403);
    const result = "Rivals: Globex, Initech, Umbrella. Report: https://files.example/acme.pdf";
    const d = await e.post(`/v1/market/jobs/${first.id}/deliver`, { result }, keys.seller);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.job.status, "delivered");
    assert.equal(d.body.job.deliveryHash, keccak256(toHex(result)));
    assert.equal((await e.get(`/v1/market/jobs/${first.id}/detail`, keys.buyer)).body.result, result);

    // release by the wrong party: the seller cannot accept its own job
    assert.equal((await e.post(`/v1/market/jobs/${first.id}/accept`, {}, keys.seller)).status, 403);
    const a = await e.post(`/v1/market/jobs/${first.id}/accept`, { stars: 5, review: "Fast and thorough." }, keys.buyer);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.job.status, "released");
    assert.deepEqual({ stars: a.body.job.rating.stars, review: a.body.job.rating.review }, { stars: 5, review: "Fast and thorough." });
    assert.equal(await usdgBalance(w, seller), usdg(5));
    assert.equal(await usdgBalance(w, w.dep.escrow), 0n);

    const l = (await e.get(`/v1/market/listings/${listings.research}`)).body;
    assert.equal(l.stats.completed, 1);
    assert.equal(l.stats.rating, 5);
    assert.equal(l.ratings[0].jobId, first.id);
    assert.equal(l.services.length, 1);
    const sum = (await e.get("/v1/market")).body;
    assert.equal(sum.jobsCompleted, 1);
    assert.equal(sum.paidOut.amount, usdg(5).toString());
  });

  it("05.8 double release and rating twice are refused, through the API and on chain", async () => {
    assert.equal((await e.post(`/v1/market/jobs/${first.id}/accept`, {}, keys.buyer)).status, 409);
    const again = await e.post(`/v1/market/jobs/${first.id}/rate`, { stars: 1 }, keys.buyer);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "already_rated");
    // the agent's own release call for a paid-out job: the escrow refuses it, nothing moves
    const sellerBefore = await usdgBalance(w, seller);
    const r = await rawEscrow(buyer, encodeFunctionData({ abi: purserEscrowAbi, functionName: "release", args: [BigInt(first.escrowJobId)] }));
    assert.notEqual(r.intent.status, "executed");
    assert.equal(await usdgBalance(w, seller), sellerBefore);
  });

  it("05.8 release by the wrong party on chain: the seller's own release call is refused", async () => {
    const h = await hire(listings.research, "A second report.");
    assert.equal(h.status, 201);
    const r = await rawEscrow(seller, encodeFunctionData({ abi: purserEscrowAbi, functionName: "release", args: [BigInt(h.body.job.escrowJobId)] }));
    assert.equal(r.intent.status, "blocked");
    assert.ok(r.verdict.reasons.some((x) => x.code === "simulation_failed"));
    assert.equal(await usdgBalance(w, w.dep.escrow), usdg(5));
    // the third agent cannot accept or rate it either
    assert.equal((await e.post(`/v1/market/jobs/${h.body.job.id}/accept`, {}, keys.third)).status, 403);
    // left delivered and not accepted: the keeper pays the seller after the review window
    await e.post(`/v1/market/jobs/${h.body.job.id}/deliver`, { result: "Second report." }, keys.seller);
    assert.deepEqual((await runKeeper(w.ctx)).claimed, [], "not before the review window ends");
    await warp(601);
    const before = await usdgBalance(w, seller);
    const k = await runKeeper(w.ctx);
    assert.deepEqual(k.claimed, [h.body.job.invoiceId]);
    assert.equal(await usdgBalance(w, seller), before + usdg(5));
    // the keeper's gas counts against the share of the account the payout is for
    assert.ok(w.ctx.chain.gasSpent(w.ctx.chain.accounts.relayer!.address, `acct:${seller.toLowerCase()}`) > 0n);
    assert.equal((await job(h.body.job.id)).status, "released");
    // paid out by the window, not by the buyer: the buyer may still rate it, once
    assert.equal((await e.post(`/v1/market/jobs/${h.body.job.id}/rate`, { stars: 4 }, keys.buyer)).status, 200);
  });

  it("05.8 refund before the deadline is refused; after it the keeper refunds on its own", async () => {
    const h = await hire(listings.logo, "Three logos for a coffee shop.");
    assert.equal(h.status, 201, JSON.stringify(h.body.verdict ?? h.body));
    const j = h.body.job;
    const before = await usdgBalance(w, buyer);
    const early = await e.post(`/v1/invoices/${j.invoiceId}/refund`);
    assert.equal(early.status, 400);
    assert.match(early.body.error.message, /too early/i);
    assert.deepEqual((await runKeeper(w.ctx)).refunded, []);
    // rating without paying: funded but never paid out
    const unpaid = await e.post(`/v1/market/jobs/${j.id}/rate`, { stars: 5 }, keys.buyer);
    assert.equal(unpaid.status, 409);
    assert.equal(unpaid.body.error.code, "not_paid");
    await warp(86401);
    assert.ok((await e.post(`/v1/market/jobs/${j.id}/deliver`, { result: "late" }, keys.seller)).status >= 400, "too late to deliver");
    const k = await runKeeper(w.ctx);
    assert.deepEqual(k.refunded, [j.invoiceId]);
    assert.equal(await usdgBalance(w, buyer), before + usdg(40));
    const after = await job(j.id);
    assert.equal(after.status, "refunded");
    assert.equal((await e.post(`/v1/market/jobs/${j.id}/rate`, { stars: 5 }, keys.buyer)).body.error.code, "not_paid");
    assert.equal((await e.get(`/v1/market/listings/${listings.logo}`)).body.stats.refunded, 1);
  });

  it("05.4 ratings only from the buyer of a paid job, and never between two agents of one owner", async () => {
    assert.equal((await e.post(`/v1/market/jobs/${first.id}/rate`, { stars: 5 }, keys.third)).status, 403);
    assert.equal((await e.post(`/v1/market/jobs/${first.id}/rate`, { stars: 5 }, keys.seller)).status, 403);
    // an owner session of someone else
    const stranger = issueOwnerSession(w.ctx, randomAddress()).token;
    assert.equal((await e.post(`/v1/market/jobs/${first.id}/rate`, { stars: 5 }, stranger)).status, 403);

    const h = await hire(listings.sibling, "Summarise the week.");
    assert.equal(h.status, 201, JSON.stringify(h.body.verdict ?? h.body));
    assert.equal(h.body.job.sameOwner, true);
    await e.post(`/v1/market/jobs/${h.body.job.id}/deliver`, { result: "Summary." }, keys.sibling);
    const a = await e.post(`/v1/market/jobs/${h.body.job.id}/accept`, { stars: 5 }, keys.buyer);
    assert.equal(a.status, 200);
    assert.equal(a.body.job.status, "released");
    assert.equal(a.body.job.rating, null, "a rating with accept is skipped between agents of one owner");
    const r = await e.post(`/v1/market/jobs/${h.body.job.id}/rate`, { stars: 5 }, keys.buyer);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "same_owner");
    // a job between agents of one owner does not count
    const l = (await e.get(`/v1/market/listings/${listings.sibling}`)).body;
    assert.equal(l.stats.completed, 0);
  });

  it("05.3 the owner's hire rules hold for the marketplace and for a raw escrow call", async () => {
    const stranger = issueOwnerSession(w.ctx, randomAddress()).token;
    assert.equal((await setRules({ mode: "off" }, stranger)).status, 403);
    assert.equal((await setRules({ mode: "off" }, keys.buyer)).status, 401);

    assert.equal((await setRules({ mode: "off" })).status, 200);
    const escrowBefore = await usdgBalance(w, w.dep.escrow);
    const off = await hire(listings.research);
    assert.equal(off.status, 422);
    assert.ok(off.body.verdict.reasons.some((r: any) => r.code === "hire_off"));
    assert.equal(off.body.job.status, "blocked");

    assert.equal((await setRules({ mode: "listed", sellers: [third] })).status, 200);
    const notListed = await hire(listings.research);
    assert.equal(notListed.status, 422);
    assert.ok(notListed.body.verdict.reasons.some((r: any) => r.code === "hire_seller_not_allowed"));

    const rules = await setRules({ mode: "listed", sellers: [seller, third], maxPerJob: usdg(10).toString() });
    assert.equal(rules.body.maxPerJob.amount, usdg(10).toString());
    assert.equal(rules.body.approvalAbove.amount, usdg(200).toString());
    const tooBig = await hire(listings.logo);
    assert.equal(tooBig.status, 422);
    assert.ok(tooBig.body.verdict.reasons.some((r: any) => r.code === "hire_max_per_job"));
    assert.equal(await usdgBalance(w, w.dep.escrow), escrowBefore, "nothing reached the escrow");

    // the same rules on the agent's own escrow call, around the marketplace
    const t = await chainNow(w.ctx);
    const fund = (payee: Address, amount: bigint) =>
      encodeFunctionData({ abi: purserEscrowAbi, functionName: "fund", args: [payee, "0x0000000000000000000000000000000000000000", w.dep.usdg, amount, BigInt(t + 3600), 600, invoiceRef("raw")] });
    const raw = await rawEscrow(buyer, fund(seller, usdg(40)), { token: w.dep.usdg, amount: usdg(40) });
    assert.equal(raw.intent.status, "blocked");
    assert.ok(raw.verdict.reasons.some((r) => r.code === "hire_max_per_job"));
    const rawOther = await rawEscrow(buyer, fund(randomAddress(), usdg(5)), { token: w.dep.usdg, amount: usdg(5) });
    assert.equal(rawOther.intent.status, "blocked");
    assert.ok(rawOther.verdict.reasons.some((r) => r.code === "hire_seller_not_allowed"));
    assert.equal(await usdgBalance(w, w.dep.escrow), escrowBefore);

    // inside the rules it goes through
    const ok = await hire(listings.research);
    assert.equal(ok.status, 201, JSON.stringify(ok.body.verdict ?? ok.body));
    assert.equal((await setRules({ mode: "any" })).status, 200);
  });

  it("05.3 the account's payee allowlist covers the job's payee, not just the escrow", async () => {
    const acct = (await e.get(`/v1/accounts/${buyer}`)).body;
    const on = (await e.post(`/v1/accounts/${buyer}/rules/prepare`, { config: { ...acct.config, payeeAllowlist: true } })).body;
    await e.post("/v1/testmode/safe-tx", on);
    const h = await hire(listings.research);
    assert.equal(h.status, 422);
    assert.ok(h.body.verdict.reasons.some((r: any) => r.code === "payee_not_allowed"));
    const offTx = (await e.post(`/v1/accounts/${buyer}/rules/prepare`, { config: { ...acct.config, payeeAllowlist: false } })).body;
    await e.post("/v1/testmode/safe-tx", offTx);
  });

  let waiting: any;
  it("05.3 above the approval threshold the hire waits for the owner; the seller's clock starts after the window", async () => {
    const t = await chainNow(w.ctx);
    const h = await hire(listings.audit, "Audit the vault contracts.");
    assert.equal(h.status, 202, JSON.stringify(h.body.verdict ?? h.body));
    waiting = h.body.job;
    assert.equal(waiting.status, "awaiting_owner");
    assert.equal(h.body.intent.status, "queued");
    assert.ok(waiting.deliverBy >= t + APPROVAL_WINDOW + 2 * 86400 && waiting.deliverBy <= t + APPROVAL_WINDOW + 2 * 86400 + 120);
    assert.equal((await e.post(`/v1/market/jobs/${waiting.id}/deliver`, { result: "early" }, keys.seller)).status, 409);
  });

  it("05.8 a fake Safe cannot fund someone else's hire, get a key or rate", async () => {
    const attacker = privateKeyToAccount(generatePrivateKey());
    await w.rpc("anvil_setBalance", [attacker.address, "0xDE0B6B3A7640000"]);
    const wallet = createWalletClient({ account: attacker, chain: w.ctx.chain.chain, transport: http(w.anvil.url) });
    const sendTx = async (to: Address | null, data: Hex) => w.ctx.chain.pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: attacker, chain: w.ctx.chain.chain, to: to ?? undefined, data }), pollingInterval: 50 });
    const fakeArt = artifact("PocHelpers.sol", "FakeSafe");
    const fake = (await sendTx(null, encodeDeployData({ abi: fakeArt.abi, bytecode: fakeArt.bytecode }))).contractAddress!;
    const run = (to: Address, data: Hex) => sendTx(fake, encodeFunctionData({ abi: fakeArt.abi, functionName: "run", args: [to, data] }));
    const cfg = configToChain({ agent: attacker.address, cosigner: null, firewall: null, watchdog: null, maxPerMinute: null, hoursUtc: [], weekdays: [], payeeAllowlist: false, serviceAllowlist: false });
    await run(w.dep.module, encodeFunctionData({ abi: purserModuleAbi, functionName: "initialize", args: [cfg, [{ token: w.dep.usdg, rule: ruleToChain({}) }], [], []] }));
    // the fake holds real test USDG and funds a job with the exact terms of the hire waiting for approval
    await w.ctx.chain.send(w.ctx.chain.accounts.relayer!, { to: w.dep.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [fake, usdg(220)] }) });
    await run(w.dep.usdg, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [w.dep.escrow, usdg(220)] }));
    await run(
      w.dep.escrow,
      encodeFunctionData({ abi: purserEscrowAbi, functionName: "fund", args: [seller, "0x0000000000000000000000000000000000000000", w.dep.usdg, usdg(220), BigInt(waiting.deliverBy), 3600, invoiceRef(waiting.invoiceId)] }),
    );
    await indexOnce(w.ctx);
    const still = await job(waiting.id);
    assert.equal(still.status, "awaiting_owner", "the fake's job does not fund the buyer's hire");
    assert.equal(still.escrowJobId, null);
    assert.equal((await e.post(`/v1/accounts/${fake}/keys`, { managed: true }, owner)).status, 404);
    assert.equal((await e.post(`/v1/market/listings`, { title: "Fake", price: "1", deliverySeconds: 600 }, "prs_" + "x".repeat(32))).status, 401);

    // the owner approves the real hire: now it is funded, with the buyer as the payer
    const ok = await decideAsTestOwner(w.ctx, waiting.intentId, true);
    assert.equal(ok?.intent.status, "executed");
    const funded = await job(waiting.id);
    assert.equal(funded.status, "funded");
    const onChain = await w.ctx.chain.pub.readContract({ address: w.dep.escrow, abi: purserEscrowAbi, functionName: "getJob", args: [BigInt(funded.escrowJobId)] });
    assert.equal(onChain.payer.toLowerCase(), buyer.toLowerCase());
  });

  it("05.6 the jobs list and the listing page read like the record", async () => {
    const all = (await e.get(`/v1/accounts/${buyer}/jobs`)).body.items;
    const statuses = new Set(all.map((j: any) => j.status));
    for (const s of ["released", "refunded", "blocked", "funded"]) assert.ok(statuses.has(s), s);
    const mine = (await e.get(`/v1/accounts/${seller}/listings`)).body.items;
    assert.equal(mine.length, 3);
    const paused = await e.patch(`/v1/market/listings/${listings.logo}`, { active: false }, keys.seller);
    assert.equal(paused.body.active, false);
    assert.equal((await hire(listings.logo)).status, 410);
    assert.equal((await e.patch(`/v1/market/listings/${listings.logo}`, { active: true }, keys.buyer)).status, 403);
  });
});
