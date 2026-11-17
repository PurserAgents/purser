// Regression for GHSA-gx7f-32pr-9pmr (reported by HEY Research Lab). Local chain only (anvil).
//
// The firewall's takeover-call check (transferOwnership, upgradeTo, setOwner ...) read only the calls the simulation
// reported, and eth_simulateV1 (what the live node has) reports only the outer call into the module. The agent's own
// call data is now always checked, so the same intent is blocked with both backends. And when no simulation backend
// answers at all, nothing is signed or sent.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createWalletClient, encodeDeployData, encodeFunctionData, http, parseAbi, type Address } from "viem";
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
