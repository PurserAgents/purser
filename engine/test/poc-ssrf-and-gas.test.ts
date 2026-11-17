// Regressions for GHSA-3h6j-gjj9-vwcm (fetching any URL for an agent key) and GHSA-mwgj-gf6x-gm67 (a caller with no
// key using up the relayer's gas through the facilitator), both reported by HEY Research Lab. Local chain and local
// servers only.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { createWalletClient, encodeDeployData, encodeFunctionData, http, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { transferAuthorizationTypedData } from "../../packages/sdk/src/eip712.ts";
import { GasRefused, makeChain, type GasStore } from "../src/chain.ts";
import { artifact } from "../src/deploy.ts";
import { createApiKey } from "../src/keys.ts";
import { checkUrl, FetchRefused, guardedFetch, isPrivateAddress } from "../src/netguard.ts";
import { createAccount, makeWorld, randomAddress, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

describe("the guarded fetch", () => {
  it("knows which addresses are not on the public internet", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "224.0.0.1", "::7f00:1", "::a9fe:a9fe", "64:ff9b:1::808:808", "2002:7f00:1::1", "2002:a00:1::", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "::ffff:0:7f00:1", "::ffff:0:a9fe:a9fe", "::ffff:0:10.0.0.1", "not-an-address"])
      assert.equal(isPrivateAddress(a), true, a);
    for (const a of ["1.1.1.1", "8.8.8.8", "104.16.0.1", "2606:4700::1111", "2001:4860:4860::8888", "64:ff9b::808:808", "2002:808:808::1", "::ffff:0:808:808"]) assert.equal(isPrivateAddress(a), false, a);
  });

  it("refuses plain http, credentials, private literals and internal names before anything is sent", () => {
    const prev = process.env.PURSER_FETCH_PRIVATE;
    delete process.env.PURSER_FETCH_PRIVATE;
    try {
      for (const u of ["http://example.com/", "https://user:pw@example.com/", "https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest/meta-data/", "https://localhost/", "https://engine.railway.internal/", "ftp://example.com/"])
        assert.throws(() => checkUrl(null, u), FetchRefused, u);
      assert.equal(checkUrl(null, "https://example.com/x").hostname, "example.com");
    } finally {
      if (prev !== undefined) process.env.PURSER_FETCH_PRIVATE = prev;
    }
  });
});

describe("GHSA-3h6j-gjj9-vwcm and GHSA-mwgj-gf6x-gm67", () => {
  let w: World;
  let e: Api;
  let internal: Server;
  let port = 0;
  const prev = process.env.PURSER_FETCH_PRIVATE;

  before(async () => {
    w = await makeWorld();
    e = api(w);
    internal = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
        return res.end();
      }
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("x".repeat(3_000_000));
      }
      res.writeHead(200, { "content-type": "text/plain", "x-internal": "yes" });
      res.end(`INTERNAL ONLY ${req.method} ${req.url}: admin-token=s3cr3t-not-for-agents`);
    });
    await new Promise<void>((r) => internal.listen(0, "127.0.0.1", () => r()));
    port = (internal.address() as { port: number }).port;
  });
  after(async () => {
    if (prev === undefined) delete process.env.PURSER_FETCH_PRIVATE;
    else process.env.PURSER_FETCH_PRIVATE = prev;
    internal?.close();
    await w?.stop();
  });

  it("an agent key cannot read a loopback-only service, by address or by name", async () => {
    delete process.env.PURSER_FETCH_PRIVATE; // as on the live engine
    const safe = await createAccount(w, { name: "Any agent" });
    const key = createApiKey(w.ctx, { safe, scopes: ["x402"] }).secret;
    for (const url of [`http://127.0.0.1:${port}/latest/meta-data/credentials`, `https://127.0.0.1:${port}/`, `https://localhost.:${port}/`, `https://[::ffff:127.0.0.1]:${port}/`]) {
      const r = await e.post("/v1/x402/fetch", { url, method: "GET" }, key);
      assert.equal(r.status, 400, `${url}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, "fetch_refused");
      assert.doesNotMatch(JSON.stringify(r.body), /s3cr3t/);
    }
  });

  it("webhooks, providers and storefront upstreams refuse private URLs when they are saved", async () => {
    delete process.env.PURSER_FETCH_PRIVATE;
    const owner = (await e.post("/v1/testmode/session")).body.token;
    const safe = await createAccount(w, { name: "Seller" });
    const hook = await e.post("/v1/webhooks", { url: `http://127.0.0.1:${port}/hook`, events: ["intent.executed"] }, owner);
    assert.equal(hook.status, 400, JSON.stringify(hook.body));
    const prov = await e.post(`/v1/accounts/${safe}/providers`, { id: "inside", kind: "openai", baseUrl: `https://10.0.0.5/v1`, models: [{ id: "m", inputMicroPer1M: 0, outputMicroPer1M: 0 }] }, owner);
    assert.equal(prov.status, 400, JSON.stringify(prov.body));
    const sell = createApiKey(w.ctx, { safe, scopes: ["sell"] }).secret;
    const svc = await e.post("/v1/storefront/services", { name: "Proxy", price: "1000", upstream: `http://127.0.0.1:${port}/` }, sell);
    assert.equal(svc.status, 400, JSON.stringify(svc.body));
  });

  it("a local engine that allows its own machine still never follows a redirect and caps the answer", async () => {
    process.env.PURSER_FETCH_PRIVATE = "1";
    const r = await guardedFetch(w.ctx, `http://127.0.0.1:${port}/redirect`);
    assert.equal(r.status, 302, "returned as it is, not followed");
    await assert.rejects(guardedFetch(w.ctx, `http://127.0.0.1:${port}/big`), FetchRefused);
    const ok = await guardedFetch(w.ctx, `http://127.0.0.1:${port}/ok`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("x-internal"), "yes");
  });

  it("the facilitator refuses an asset it does not list: no read, no transaction", async () => {
    const attacker = privateKeyToAccount(generatePrivateKey());
    await w.rpc("anvil_setBalance", [attacker.address, "0xDE0B6B3A7640000"]);
    const a = artifact("PocHelpers.sol", "GasBurner");
    const wallet = createWalletClient({ account: attacker, chain: w.ctx.chain.chain, transport: http(w.anvil.url) });
    const hash = await wallet.sendTransaction({ account: attacker, chain: w.ctx.chain.chain, data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode }) });
    const burner = (await w.ctx.chain.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 })).contractAddress as Address;

    const relayer = w.ctx.chain.accounts.relayer!.address;
    const nonceBefore = await w.ctx.chain.pub.getTransactionCount({ address: relayer });
    const now = (await w.ctx.chain.pub.getBlock()).timestamp;
    const loops = 250_000n;
    const authorization = { from: attacker.address, to: attacker.address, value: loops, validAfter: 0n, validBefore: now + 3600n, nonce: `0x${"ab".repeat(32)}` as Hex };
    const signature = await attacker.signTypedData(transferAuthorizationTypedData(w.ctx.cfg.chainId, burner, "Global Dollar", "1", authorization));
    const r = await e.post("/x402/settle", {
      paymentRequirements: { scheme: "exact", network: `eip155:${w.ctx.cfg.chainId}`, amount: "1", asset: burner, payTo: attacker.address },
      paymentPayload: { x402Version: 2, payload: { signature, authorization: { from: attacker.address, to: attacker.address, value: loops.toString(), validAfter: "0", validBefore: (now + 3600n).toString(), nonce: authorization.nonce } } },
    });
    assert.equal(r.body.success, false, JSON.stringify(r.body));
    assert.equal(r.body.errorReason, "unsupported_asset");
    assert.equal(await w.ctx.chain.pub.getTransactionCount({ address: relayer }), nonceBefore, "the relayer sent nothing");
  });

  it("a relayed transaction above its kind's gas limit is refused before it is sent", async () => {
    const a = artifact("PocHelpers.sol", "GasBurner");
    const relayer = w.ctx.chain.accounts.relayer!;
    const hash = await w.ctx.chain.wallet(relayer).sendTransaction({ account: relayer, chain: w.ctx.chain.chain, data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode }) });
    const burner = (await w.ctx.chain.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 })).contractAddress as Address;
    const data = encodeFunctionData({ abi: a.abi, functionName: "transferWithAuthorization", args: [relayer.address, relayer.address, 250_000n, 0n, 0n, `0x${"cd".repeat(32)}`, "0x"] });
    const nonceBefore = await w.ctx.chain.pub.getTransactionCount({ address: relayer.address });
    await assert.rejects(w.ctx.chain.send(relayer, { to: burner, data, maxGas: 250_000n }), GasRefused);
    await assert.rejects(w.ctx.chain.send(relayer, { to: burner, data }), GasRefused, "the default limit holds too");
    assert.equal(await w.ctx.chain.pub.getTransactionCount({ address: relayer.address }), nonceBefore);
  });

  it("the day's gas count survives a restart; open settlements and each account only get their share", async () => {
    const saved = { enforce: process.env.PURSER_GAS_ENFORCE, cap: process.env.PURSER_GAS_DAY_WEI, pct: process.env.PURSER_GAS_OPEN_PCT };
    delete process.env.PURSER_GAS_ACCOUNT_PCT; // the default share
    process.env.PURSER_GAS_ENFORCE = "1";
    process.env.PURSER_GAS_DAY_WEI = "1000000000000000"; // 0.001 ETH
    process.env.PURSER_GAS_OPEN_PCT = "30";
    const kv = new Map<string, string>();
    const store: GasStore = { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) };
    try {
      const relayer = w.ctx.chain.accounts.relayer!;
      const c1 = makeChain(w.ctx.cfg, store);
      await c1.send(relayer, { to: randomAddress(), value: 1n, open: true });
      const spent = c1.gasSpent(relayer.address);
      assert.ok(spent > 0n);
      const c2 = makeChain(w.ctx.cfg, store); // a restart
      assert.equal(c2.gasSpent(relayer.address), spent, "kept, not reset");
      const day = new Date().toISOString().slice(0, 10);
      kv.set(`gas_spent:${day}:${relayer.address.toLowerCase()}:open`, "300000000000000");
      await assert.rejects(c2.send(relayer, { to: randomAddress(), value: 1n, open: true }), /gas share for today is used up/);
      await c2.send(relayer, { to: randomAddress(), value: 1n }); // accounts' own payments still go
      // one account's own payments and calls get only their share (10% by default), the others keep going
      const busy = randomAddress();
      kv.set(`gas_spent:${day}:${relayer.address.toLowerCase()}:acct:${busy.toLowerCase()}`, "100000000000000");
      await assert.rejects(c2.send(relayer, { to: randomAddress(), value: 1n, account: busy }), /this account's share of the engine's gas/);
      await c2.send(relayer, { to: randomAddress(), value: 1n, account: randomAddress() });
      kv.set(`gas_spent:${day}:${relayer.address.toLowerCase()}`, "1000000000000000");
      await assert.rejects(c2.send(relayer, { to: randomAddress(), value: 1n }), /gas budget for today is used up/);
    } finally {
      for (const [k, v] of [["PURSER_GAS_ENFORCE", saved.enforce], ["PURSER_GAS_DAY_WEI", saved.cap], ["PURSER_GAS_OPEN_PCT", saved.pct]] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });
});
