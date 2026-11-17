// Regression for GHSA-gx7f-32pr-9pmr (reported by HEY Research Lab). Local chain only (anvil).
//
// The firewall's takeover-call check (transferOwnership, upgradeTo, setOwner ...) read only the calls the simulation
// reported, and eth_simulateV1 (what the live node has) reports only the outer call into the module. The agent's own
// call data is now always checked, so the same intent is blocked with both backends. And when no simulation backend
// answers at all, nothing is signed or sent.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createWalletClient, encodeDeployData, encodeFunctionData, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { execAsTestOwner, prepareSafeTx, ruleChangeCalls } from "../src/accounts.ts";
import { artifact } from "../src/deploy.ts";
import { forceBackend } from "../src/firewall.ts";
import { indexOnce, ingestReceipt } from "../src/indexer.ts";
import { submitIntent } from "../src/intents.ts";
import { ZERO } from "../src/util.ts";
import { createAccount, makeWorld, randomAddress, usdg, type World } from "./harness.ts";

const ownedAbi = parseAbi(["function owner() view returns (address)", "function transferOwnership(address)"]);

describe("GHSA-gx7f-32pr-9pmr: the takeover-call check works with every simulation backend", () => {
  let w: World;
  let safe: Address;
  let thing: Address;
  const attacker = randomAddress();

  before(async () => {
    w = await makeWorld();
    safe = await createAccount(w, { name: "Agent that runs a contract" });
    const a = artifact("PocHelpers.sol", "OwnedThing");
    const relayer = w.ctx.chain.accounts.relayer!;
    const wallet = createWalletClient({ account: relayer, chain: w.ctx.chain.chain, transport: http(w.anvil.url) });
    const hash = await wallet.sendTransaction({ account: relayer, chain: w.ctx.chain.chain, data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: [safe] }) });
    thing = (await w.ctx.chain.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 })).contractAddress!;
    const r = await execAsTestOwner(w.ctx, await prepareSafeTx(w.ctx, safe, ruleChangeCalls(w.ctx, { allow: [thing] }), "allow the contract"));
    await ingestReceipt(w.ctx, r);
    await indexOnce(w.ctx);
  });
  after(async () => {
    forceBackend(null);
    await w?.stop();
  });

  const takeover = () =>
    submitIntent(w.ctx, {
      safe,
      spec: { kind: "call", call: { target: thing, value: 0n, data: encodeFunctionData({ abi: ownedAbi, functionName: "transferOwnership", args: [attacker] }), spendToken: ZERO, spendLimit: 0n } },
      category: "onchain",
      signer: w.agent,
    });
  const ownerOf = () => w.ctx.chain.pub.readContract({ address: thing, abi: ownedAbi, functionName: "owner" });

  for (const backend of ["debug_traceCall", "eth_simulateV1"] as const) {
    it(`${backend}: blocked as a takeover-style call, nothing sent`, async () => {
      forceBackend(backend);
      const r = await takeover();
      assert.equal(r.verdict.simulation?.backend, backend);
      assert.equal(r.intent.status, "blocked");
      assert.ok(r.verdict.reasons.some((x) => x.code === "dangerous_call"), JSON.stringify(r.verdict.reasons));
      assert.equal((await ownerOf()).toLowerCase(), safe.toLowerCase(), "the Safe still owns its contract");
    });
  }

  describe("variants: a takeover inside a batch, or one no decoder can see, is caught by what the simulation shows", () => {
    let multi: Address;
    let roles: Address;
    let factory: Address;
    const multiAbi = () => artifact("TakeoverHelpers.sol", "OwnedMulti").abi;
    const deploy = async (name: string, args: unknown[] = []) => {
      const a = artifact("TakeoverHelpers.sol", name);
      const relayer = w.ctx.chain.accounts.relayer!;
      const hash = await w.ctx.chain.wallet(relayer).sendTransaction({ account: relayer, chain: w.ctx.chain.chain, data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) });
      return (await w.ctx.chain.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 })).contractAddress!;
    };
    const callOn = (target: Address, data: Hex) =>
      submitIntent(w.ctx, { safe, spec: { kind: "call", call: { target, value: 0n, data, spendToken: ZERO, spendLimit: 0n } }, category: "onchain", signer: w.agent });
    const owned = (a: Address) => w.ctx.chain.pub.readContract({ address: a, abi: ownedAbi, functionName: "owner" });

    before(async () => {
      multi = await deploy("OwnedMulti", [safe]);
      roles = await deploy("RoleThing", [safe]);
      factory = await deploy("OwnedFactory");
      const r = await execAsTestOwner(w.ctx, await prepareSafeTx(w.ctx, safe, ruleChangeCalls(w.ctx, { allow: [multi, roles, factory] }), "allow the helpers"));
      await ingestReceipt(w.ctx, r);
      await indexOnce(w.ctx);
    });

    for (const backend of ["eth_simulateV1", "debug_traceCall"] as const) {
      it(`${backend}: transferOwnership wrapped in the target's own multicall is blocked`, async () => {
        forceBackend(backend);
        const inner = encodeFunctionData({ abi: ownedAbi, functionName: "transferOwnership", args: [attacker] });
        const r = await callOn(multi, encodeFunctionData({ abi: multiAbi(), functionName: "multicall", args: [[inner]] }));
        assert.equal(r.intent.status, "blocked", JSON.stringify(r.verdict.reasons));
        assert.ok(r.verdict.reasons.some((x) => x.code === "dangerous_call"));
        assert.equal((await owned(multi)).toLowerCase(), safe.toLowerCase());
      });

      it(`${backend}: a wrapper no decoder knows is caught by its call data and the OwnershipTransferred log`, async () => {
        forceBackend(backend);
        const inner = encodeFunctionData({ abi: ownedAbi, functionName: "transferOwnership", args: [attacker] });
        const r = await callOn(multi, encodeFunctionData({ abi: multiAbi(), functionName: "poke", args: [7, inner] }));
        assert.equal(r.intent.status, "blocked", JSON.stringify(r.verdict.reasons));
        const reason = r.verdict.reasons.find((x) => x.code === "dangerous_call");
        // the selector is found anywhere in the call data, and the log shows the change of owner: either one blocks
        // (the admin role test below is caught by the log alone)
        assert.match(reason!.detail, /transferOwnership|a change of owner/);
        assert.equal((await owned(multi)).toLowerCase(), safe.toLowerCase());
      });

      it(`${backend}: granting the admin role is blocked, an ordinary role is not`, async () => {
        forceBackend(backend);
        const grant = (role: Hex) => callOn(roles, encodeFunctionData({ abi: artifact("TakeoverHelpers.sol", "RoleThing").abi, functionName: "grantRole", args: [role, attacker] }));
        const admin = await grant(`0x${"0".repeat(64)}`);
        assert.equal(admin.intent.status, "blocked");
        assert.ok(admin.verdict.reasons.some((x) => x.code === "dangerous_call" && /admin role/.test(x.detail)));
        const reader = await grant(keccak256(toHex("READER_ROLE")));
        assert.equal(reader.verdict.reasons.some((x) => x.code === "dangerous_call"), false);
      });

      it(`${backend}: deploying a new contract the Safe owns is not a takeover`, async () => {
        forceBackend(backend);
        const r = await callOn(factory, encodeFunctionData({ abi: artifact("TakeoverHelpers.sol", "OwnedFactory").abi, functionName: "make" }));
        assert.equal(r.verdict.reasons.some((x) => x.code === "dangerous_call"), false, JSON.stringify(r.verdict.reasons));
      });
    }
  });

  it("no simulation backend: blocked, never signed or sent", async () => {
    forceBackend(null);
    const pub = w.ctx.chain.pub;
    const real = pub.request;
    pub.request = (async (args: { method: string }) => {
      if (args.method === "eth_simulateV1" || args.method === "debug_traceCall") throw new Error("the method does not exist/is not available");
      return (real as (a: unknown) => Promise<unknown>)(args);
    }) as never;
    try {
      const to = randomAddress();
      const r = await submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to, amount: usdg(1) } }, category: "transfer", signer: w.agent });
      assert.equal(r.verdict.simulation?.backend, "none");
      assert.equal(r.intent.status, "blocked");
      assert.ok(r.verdict.reasons.some((x) => x.code === "no_simulation"));
    } finally {
      pub.request = real;
      forceBackend(null);
    }
  });
});
