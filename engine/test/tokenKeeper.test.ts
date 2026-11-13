import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address, Hex } from "viem";
import { createTokenKeeper, LOW_GAS_BALANCE, reason, tokenKeeperConfig, type KeeperCall, type KeeperIO } from "../src/tokenKeeper.ts";

const POT = "0xD3049f1ef0569D3c9Bf9c44f114a76Bf7CFD404f";
const SPLITTER = "0x265a0376e7E6e82300474292F6322554D1Dc0629";
const TOKEN = "0x2380a5F707adf77064dE0065837D6ef42D4Fae39" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
// anvil's first well-known test key: never a real wallet's
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("token keeper: config (pure)", () => {
  it("is off by default and for anything but exactly 'on'", () => {
    assert.equal(tokenKeeperConfig({}), null);
    for (const v of ["", "1", "true", "ON", "yes", "off"]) {
      assert.equal(tokenKeeperConfig({ TOKEN_KEEPER: v, PURSER_BURN_POT: POT, PURSER_SPLITTER: SPLITTER, BOT_PRIVATE_KEY: KEY }), null, v);
    }
  });

  it("on: reads the two contracts, the key, the node and the intervals", () => {
    const c = tokenKeeperConfig({ TOKEN_KEEPER: "on", PURSER_BURN_POT: POT, PURSER_SPLITTER: SPLITTER, BOT_PRIVATE_KEY: KEY });
    assert.ok(c);
    assert.equal(c.burnPot, POT);
    assert.equal(c.splitter, SPLITTER);
    assert.equal(c.key, KEY);
    assert.equal(c.chainId, 4663);
    assert.deepEqual(c.rpcUrls, ["https://rpc.mainnet.chain.robinhood.com"]);
    assert.equal(c.tickMs, 5 * 60_000);
    assert.equal(c.sweepMs, 30 * 60_000);
    const d = tokenKeeperConfig({
      TOKEN_KEEPER: "on",
      PURSER_BURN_POT: POT,
      PURSER_SPLITTER: SPLITTER,
      BOT_PRIVATE_KEY: KEY.slice(2) + "\n", // without 0x, with a newline, as a file would hold it
      TOKEN_KEEPER_RPC_URL: "https://paid.example/node",
      PURSER_RPC_FALLBACK_URLS: "https://second.example",
      TOKEN_KEEPER_TICK_MS: "60000",
      TOKEN_KEEPER_SWEEP_MS: "600000",
    });
    assert.ok(d);
    assert.equal(d.key, KEY);
    assert.deepEqual(d.rpcUrls, ["https://paid.example/node", "https://second.example", "https://rpc.mainnet.chain.robinhood.com"]);
    assert.equal(d.tickMs, 60_000);
    assert.equal(d.sweepMs, 600_000);
  });

  it("on with something missing or malformed: refuses, naming the variable and never the key", () => {
    const base = { TOKEN_KEEPER: "on", PURSER_BURN_POT: POT, PURSER_SPLITTER: SPLITTER, BOT_PRIVATE_KEY: KEY };
    const cases: [Record<string, string>, RegExp][] = [
      [{ PURSER_BURN_POT: "" }, /PURSER_BURN_POT/],
      [{ PURSER_SPLITTER: "0x1234" }, /PURSER_SPLITTER/],
      [{ BOT_PRIVATE_KEY: "" }, /BOT_PRIVATE_KEY/],
      [{ BOT_PRIVATE_KEY: KEY + "00" }, /BOT_PRIVATE_KEY/],
      [{ BOT_PRIVATE_KEY: KEY.replace("a", "z") }, /BOT_PRIVATE_KEY/],
      [{ TOKEN_KEEPER_TICK_MS: "100" }, /TICK_MS/],
      [{ TOKEN_KEEPER_SWEEP_MS: "10000" }, /SWEEP_MS/],
    ];
    for (const [patch, msg] of cases) {
      assert.throws(
        () => tokenKeeperConfig({ ...base, ...patch }),
        (e: Error) => msg.test(e.message) && !e.message.includes(KEY.slice(2, 20)),
      );
    }
  });

  it("reasons never carry a node URL or the key", () => {
    const r = reason(new Error(`call to https://node.example/v2/secret-api-key failed with ${KEY} and ${KEY.slice(2)}`), KEY);
    assert.ok(!r.includes("secret-api-key"));
    assert.ok(!r.includes(KEY.slice(2)));
    assert.match(r, /<rpc>/);
    assert.match(r, /<key>/);
  });
});

/** A stand-in chain: what each call would return in simulation, which ones revert, and what was sent. */
function fakeIO(opts: {
  token?: Address;
  ready?: boolean;
  sweep?: bigint | Error;
  claimToken?: bigint | Error;
  burn?: bigint | Error;
  sendFails?: KeeperCall[];
  balance?: bigint;
}) {
  const sent: KeeperCall[] = [];
  const io: KeeperIO = {
    sender: "0x8F7177314D3C5C2A8301C95858148b27C6f44b9D",
    token: async () => opts.token ?? TOKEN,
    preview: async () => ({ amount: 0n, nextAt: 0n, ready: opts.ready ?? false, tokens: 0n }),
    simulate: async (call) => {
      const v = opts[call] ?? 0n;
      if (v instanceof Error) throw v;
      return v;
    },
    send: async (call) => {
      if (opts.sendFails?.includes(call)) throw new Error("replacement transaction underpriced");
      sent.push(call);
      return { hash: `0x${"ab".repeat(32)}` as Hex, ok: true };
    },
    balance: async () => opts.balance ?? 10n ** 18n,
  };
  return { io, sent };
}

describe("token keeper: what it does each tick (pure)", () => {
  const quiet = { tickMs: 300_000, sweepMs: 1_800_000, log: () => {} };

  it("waits, sending nothing, until setToken has run", async () => {
    const { io, sent } = fakeIO({ token: ZERO, sweep: 5n, ready: true });
    const k = createTokenKeeper(io, quiet);
    assert.deepEqual(await k.tick(), []);
    assert.deepEqual(sent, []);
  });

  it("sweeps, claims tokens and burns when each has something to do", async () => {
    const { io, sent } = fakeIO({ sweep: 1000n, claimToken: 7n, ready: true, burn: 3n });
    const k = createTokenKeeper(io, quiet);
    const done = await k.tick();
    assert.deepEqual(sent, ["sweep", "claimToken", "burn"]);
    assert.deepEqual(done.map((a) => [a.call, a.ok, a.amount]), [["sweep", true, "1000"], ["claimToken", true, "7"], ["burn", true, "3"]]);
  });

  it("sends nothing when there is nothing: no fees, no tokens, the pot not ready", async () => {
    const { io, sent } = fakeIO({ sweep: 0n, claimToken: 0n, ready: false });
    const k = createTokenKeeper(io, quiet);
    await k.tick();
    assert.deepEqual(sent, []);
  });

  it("sweeps at most once per sweep interval, but checks the burn every tick", async () => {
    let t = 0;
    const { io, sent } = fakeIO({ sweep: 10n, ready: true, burn: 1n });
    const k = createTokenKeeper(io, { ...quiet, now: () => t });
    await k.tick();
    t += 300_000;
    await k.tick();
    t += 1_500_000;
    await k.tick();
    assert.deepEqual(sent, ["sweep", "burn", "burn", "sweep", "burn"]);
  });

  it("a call that reverts in simulation is not sent, and does not stop the others", async () => {
    const lines: string[] = [];
    const { io, sent } = fakeIO({ sweep: new Error("execution reverted: Reentered()"), claimToken: 4n, ready: true, burn: 2n });
    const k = createTokenKeeper(io, { ...quiet, log: (l) => lines.push(l) });
    await k.tick();
    assert.deepEqual(sent, ["claimToken", "burn"]);
    assert.ok(lines.some((l) => /sweep: not sent/.test(l)));
  });

  it("the pot's own waits (TooSoon and the like) are expected and not logged as problems", async () => {
    const lines: string[] = [];
    const { io, sent } = fakeIO({ ready: true, burn: new Error("execution reverted: TooSoon(1794572000)") });
    const k = createTokenKeeper(io, { ...quiet, log: (l) => lines.push(l) });
    await k.tick();
    assert.deepEqual(sent, []);
    assert.deepEqual(lines, []);
  });

  it("a send that fails is recorded as failed and the tick goes on", async () => {
    const { io, sent } = fakeIO({ sweep: 9n, sendFails: ["sweep"], ready: true, burn: 1n });
    const k = createTokenKeeper(io, quiet);
    const done = await k.tick();
    assert.deepEqual(sent, ["burn"]);
    assert.equal(done[0].call, "sweep");
    assert.equal(done[0].ok, false);
    assert.match(done[0].error ?? "", /underpriced/);
    assert.equal(k.status().actions.length, 2);
  });

  it("warns when the bot wallet runs low on gas", async () => {
    const lines: string[] = [];
    const { io } = fakeIO({ balance: LOW_GAS_BALANCE - 1n });
    const k = createTokenKeeper(io, { ...quiet, log: (l) => lines.push(l) });
    await k.tick();
    assert.ok(lines.some((l) => /low on gas/.test(l)));
  });

  it("never runs two ticks at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { io, sent } = fakeIO({ sweep: 1n });
    const slow: KeeperIO = { ...io, token: async () => (await gate, TOKEN) };
    const k = createTokenKeeper(slow, quiet);
    const first = k.tick();
    assert.deepEqual(await k.tick(), [], "the second returns at once");
    release();
    await first;
    assert.deepEqual(sent, ["sweep"]);
  });

  it("start and stop", () => {
    const { io } = fakeIO({ token: ZERO });
    const k = createTokenKeeper(io, quiet);
    k.start();
    assert.equal(k.status().running, true);
    k.stop();
    assert.equal(k.status().running, false);
  });
});

/** The live code path (viem, simulate, sign, send, receipt) against a local anvil fork where the pot and the
 *  splitter are deployed and the token is set (token/token-deploy.sh and token/set-token.sh with PURSER_DEPLOY_RPC).
 *  Skipped unless TOKEN_KEEPER_FORK_RPC, PURSER_BURN_POT and PURSER_SPLITTER are given. Signs with anvil's test key:
 *  every call the keeper makes is one anyone may make. */
describe("token keeper: on a local fork (opt-in)", { skip: !process.env.TOKEN_KEEPER_FORK_RPC }, () => {
  it("sweeps the fees of a real trade and burns, and the supply falls", async () => {
    const { createPublicClient, createWalletClient, http, parseAbi, parseEther } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { makeKeeperIO } = await import("../src/tokenKeeper.ts");
    const rpc = process.env.TOKEN_KEEPER_FORK_RPC!;
    const cfg = tokenKeeperConfig({
      TOKEN_KEEPER: "on",
      PURSER_BURN_POT: process.env.PURSER_BURN_POT,
      PURSER_SPLITTER: process.env.PURSER_SPLITTER,
      BOT_PRIVATE_KEY: KEY,
      TOKEN_KEEPER_RPC_URL: rpc,
    })!;
    cfg.rpcUrls = [rpc]; // the fork only, never the public node
    const pub = createPublicClient({ transport: http(rpc) });
    const trader = createWalletClient({ account: privateKeyToAccount(KEY), transport: http(rpc) });
    const abi = parseAbi([
      "function curve() view returns (address)",
      "function token() view returns (address)",
      "function totalSupply() view returns (uint256)",
      "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)",
    ]);
    const curve = await pub.readContract({ address: cfg.splitter, abi, functionName: "curve" });
    const token = await pub.readContract({ address: cfg.burnPot, abi, functionName: "token" });
    const hash = await trader.writeContract({ address: curve, abi, functionName: "buy", args: [parseEther("0.5"), 0n, trader.account.address], value: parseEther("0.5"), chain: null });
    await pub.waitForTransactionReceipt({ hash });
    await pub.request({ method: "evm_increaseTime" as never, params: [31 * 60] as never });
    await pub.request({ method: "evm_mine" as never, params: [] as never });
    const supply = await pub.readContract({ address: token, abi, functionName: "totalSupply" });
    const potBefore = await pub.getBalance({ address: cfg.burnPot });

    const k = createTokenKeeper(makeKeeperIO(cfg), { tickMs: 300_000, sweepMs: 1_800_000, log: () => {}, secret: KEY });
    const done = await k.tick();
    assert.deepEqual(done.map((a) => [a.call, a.ok]), [["sweep", true], ["burn", true]]);
    assert.ok(BigInt(done[0].amount!) > 0n, "fees were split");
    const after = await pub.readContract({ address: token, abi, functionName: "totalSupply" });
    assert.ok(after < supply, "the total supply fell");
    assert.ok((await pub.getBalance({ address: cfg.burnPot })) <= potBefore + BigInt(done[0].amount!), "the pot spent its ETH");
    assert.deepEqual(await k.tick(), [], "and the next tick, right after, has nothing to do");
  });
});
