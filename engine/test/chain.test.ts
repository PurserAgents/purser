import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { encodeErrorResult, encodeAbiParameters, type Address, type Log, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { purserModuleAbi } from "../../packages/sdk/src/abi.ts";
import { decodeRevertData, explainRevert, getLogsChunked, isLocalRpc, makeChain, REVERT_WORDS, revertName } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { newKeys } from "../src/deploy.ts";
import { freePort } from "./harness.ts";

const cfg = (rpcUrls: string[], withKeys = true) => loadConfig({ PURSER_DEPLOYMENT: "/nonexistent", PURSER_KEYS: "/nonexistent" }, { rpcUrls, keys: withKeys ? newKeys(true) : null });

describe("broadcast guard: only a local node ever gets a transaction", () => {
  it("isLocalRpc accepts only loopback hosts, and only when every URL is local", () => {
    assert.equal(isLocalRpc(["http://127.0.0.1:8545"]), true);
    assert.equal(isLocalRpc(["http://localhost:8545", "http://[::1]:8545"]), true);
    assert.equal(isLocalRpc(["https://rpc.mainnet.chain.robinhood.com"]), false);
    assert.equal(isLocalRpc(["http://127.0.0.1:8545", "https://rpc.mainnet.chain.robinhood.com"]), false, "one remote URL is enough to refuse");
    assert.equal(isLocalRpc(["http://127.0.0.1.example.com:8545"]), false);
    assert.equal(isLocalRpc(["http://10.0.0.5:8545"]), false);
    assert.equal(isLocalRpc(["not a url"]), false);
    assert.equal(isLocalRpc([]), false);
  });

  it("an engine on a remote RPC refuses to send before touching the network", async () => {
    const c = makeChain(cfg(["https://rpc.mainnet.chain.robinhood.com"]));
    assert.equal(c.broadcast, false);
    assert.ok(c.accounts.relayer, "keys are loaded, sending is still refused");
    await assert.rejects(c.send(c.accounts.relayer!, { to: privateKeyToAccount(generatePrivateKey()).address, value: 1n }), /broadcast disabled/);
  });

  it("a local node with keys broadcasts; without keys or with PURSER_BROADCAST=0 it does not", async () => {
    assert.equal(makeChain(cfg(["http://127.0.0.1:8545"])).broadcast, true);
    assert.equal(makeChain(cfg(["http://127.0.0.1:8545"], false)).broadcast, false);
    const saved = process.env.PURSER_BROADCAST;
    process.env.PURSER_BROADCAST = "0";
    try {
      const c = makeChain(cfg(["http://127.0.0.1:8545"]));
      assert.equal(c.broadcast, false);
      await assert.rejects(c.send(c.accounts.relayer!, { to: c.accounts.relayer!.address }), /broadcast disabled/);
    } finally {
      if (saved === undefined) delete process.env.PURSER_BROADCAST;
      else process.env.PURSER_BROADCAST = saved;
    }
    const noKeys = makeChain(cfg(["http://127.0.0.1:8545"], false));
    assert.equal(noKeys.accounts.relayer, null);
    assert.equal(noKeys.accounts.owner, null);
  });
});

describe("RPC failover (local stub nodes)", () => {
  let good: Server;
  let bad: Server;
  let goodUrl: string;
  let badUrl: string;
  let deadUrl: string;
  const hits = { good: 0, bad: 0 };
  before(async () => {
    const rpcServer = (name: "good" | "bad") =>
      createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
          hits[name]++;
          if (name === "bad") {
            res.writeHead(503).end("unavailable");
            return;
          }
          const msg = JSON.parse(raw);
          const answer = (m: { id: number; method: string }) => ({ jsonrpc: "2.0", id: m.id, result: m.method === "eth_chainId" ? "0x1237" : "0x2a" });
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(msg) ? msg.map(answer) : answer(msg)));
        });
      });
    good = rpcServer("good");
    bad = rpcServer("bad");
    await new Promise<void>((r) => good.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => bad.listen(0, "127.0.0.1", r));
    goodUrl = `http://127.0.0.1:${(good.address() as { port: number }).port}`;
    badUrl = `http://127.0.0.1:${(bad.address() as { port: number }).port}`;
    deadUrl = `http://127.0.0.1:${await freePort()}`; // nothing listens here
  });
  after(() => {
    good?.close();
    bad?.close();
  });

  it("falls over to the next node when the first is down or failing", async () => {
    const c = makeChain(cfg([deadUrl, badUrl, goodUrl]));
    assert.equal(await c.pub.getBlockNumber({ cacheTime: 0 }), 42n);
    assert.ok(hits.bad >= 1, "the failing node was tried");
    assert.ok(hits.good >= 1);
    assert.equal(c.broadcast, true, "all three are local");
  });

  it("a single dead node is an error, not a hang", async () => {
    const c = makeChain(cfg([deadUrl]));
    await assert.rejects(c.pub.getBlockNumber({ cacheTime: 0 }));
  });
});

describe("getLogsChunked: 100,000-block spans that halve when the node refuses", () => {
  const fakePub = (opts: { maxSpan?: bigint; failAlways?: boolean } = {}) => {
    const ranges: [bigint, bigint][] = [];
    const pub = {
      async getLogs(p: { fromBlock: bigint; toBlock: bigint }) {
        ranges.push([p.fromBlock, p.toBlock]);
        if (opts.failAlways) throw new Error("query returned more than 10000 results");
        if (opts.maxSpan && p.toBlock - p.fromBlock + 1n > opts.maxSpan) throw new Error("query timeout exceeded");
        return [{ blockNumber: p.fromBlock } as unknown as Log];
      },
    } as unknown as PublicClient;
    return { pub, ranges };
  };
  const addr = "0x0000000000000000000000000000000000000001" as Address;

  it("reads in 100,000-block spans up to the head", async () => {
    const { pub, ranges } = fakePub();
    const logs = await getLogsChunked(pub, { address: addr, fromBlock: 0n, toBlock: 250_000n });
    assert.deepEqual(ranges, [
      [0n, 99_999n],
      [100_000n, 199_999n],
      [200_000n, 250_000n],
    ]);
    assert.equal(logs.length, 3);
  });

  it("halves the span on each refusal and keeps the smaller span", async () => {
    const { pub, ranges } = fakePub({ maxSpan: 30_000n });
    const logs = await getLogsChunked(pub, { address: addr, fromBlock: 1_000n, toBlock: 100_999n });
    const ok = ranges.filter(([f, t]) => t - f + 1n <= 30_000n);
    assert.deepEqual(ranges.slice(0, 3).map(([f, t]) => t - f + 1n), [100_000n, 50_000n, 25_000n], "100k, then 50k, then 25k");
    assert.ok(ok.every(([f, t]) => t - f + 1n === 25_000n), "stays at 25k");
    assert.equal(ok[0][0], 1_000n);
    assert.equal(ok[ok.length - 1][1], 100_999n);
    for (let i = 1; i < ok.length; i++) assert.equal(ok[i][0], ok[i - 1][1] + 1n, "no gap, no overlap");
    assert.equal(logs.length, ok.length);
  });

  it("gives up only when even a single block is refused", async () => {
    const { pub, ranges } = fakePub({ failAlways: true });
    await assert.rejects(getLogsChunked(pub, { address: addr, fromBlock: 0n, toBlock: 10n }, { span: 8n }), /more than 10000 results/);
    assert.deepEqual(ranges.map(([f, t]) => t - f + 1n), [8n, 4n, 2n, 1n]);
  });

  it("an empty range asks nothing; a custom span and pause are honoured", async () => {
    const { pub, ranges } = fakePub();
    assert.deepEqual(await getLogsChunked(pub, { address: addr, fromBlock: 10n, toBlock: 9n }), []);
    assert.equal(ranges.length, 0);
    const t = Date.now();
    await getLogsChunked(pub, { address: addr, fromBlock: 0n, toBlock: 29n }, { span: 10n, pauseMs: 15 });
    assert.equal(ranges.length, 3);
    assert.ok(Date.now() - t >= 40);
  });
});

describe("revert reasons in plain words", () => {
  it("decodes Purser custom errors and Error(string)", () => {
    assert.equal(decodeRevertData(encodeErrorResult({ abi: purserModuleAbi, errorName: "OverDaily" })), "OverDaily");
    const errString = ("0x08c379a0" + encodeAbiParameters([{ type: "string" }], ["nope"]).slice(2)) as `0x${string}`;
    assert.equal(decodeRevertData(errString), "Error");
    assert.equal(decodeRevertData("0xdeadbeef"), null);
  });

  it("explains known reverts, names unknown ones, and passes plain errors through", () => {
    assert.equal(explainRevert(new Error("execution reverted with custom error 'IsFrozen()'")), REVERT_WORDS.IsFrozen);
    assert.equal(revertName(new Error("reverted with custom error 'Mystery(uint256)'")), "Mystery");
    assert.equal(explainRevert(new Error("reverted with custom error 'Mystery(uint256)'")), "The chain refused it (Mystery).");
    assert.equal(explainRevert(new Error("connection refused\nstack...")), "The chain refused it: connection refused");
    assert.equal(revertName("just a string"), null);
  });

  it("every explanation follows the copy rules", () => {
    for (const [k, v] of Object.entries(REVERT_WORDS)) {
      assert.ok(v.length > 10, k);
      assert.equal(/[—↗]/u.test(v), false, `${k}: no em dash or arrow`);
      assert.match(v, /\.$/, `${k} ends as a sentence`);
    }
    for (const e of purserModuleAbi.filter((x) => x.type === "error")) assert.ok(REVERT_WORDS[(e as { name: string }).name], `module error ${(e as { name: string }).name} has words`);
  });
});
