import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Address, PublicClient } from "viem";
import type { Deployment } from "../src/config.ts";
import { ETH_INFO, isEth, makeTokens } from "../src/tokens.ts";
import { ZERO } from "../src/util.ts";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const FEED = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9" as Address;
const OTHER = "0x00000000000000000000000000000000000000AA" as Address;

const dep = (over: Partial<Deployment> = {}) => ({ usdg: USDG, weth: WETH, ethUsdFeed: FEED, ...over }) as Deployment;

/** A stand-in node: answers token metadata and the Chainlink feed, and counts calls. */
function stubPub(opts: { answer?: bigint; updatedAt?: () => number; failTokens?: boolean; failFeed?: boolean } = {}) {
  const calls: string[] = [];
  const pub = {
    async readContract(p: { address: string; functionName: string }) {
      calls.push(`${p.address.toLowerCase()}:${p.functionName}`);
      if (p.functionName === "latestRoundData") {
        if (opts.failFeed) throw new Error("feed down");
        return [1n, opts.answer ?? 3_000_00000000n, 0n, BigInt(opts.updatedAt?.() ?? Math.floor(Date.now() / 1000)), 1n];
      }
      if (opts.failTokens) throw new Error("not a token");
      if (p.functionName === "symbol") return "TST";
      if (p.functionName === "decimals") return 8;
      throw new Error("unexpected");
    },
  } as unknown as PublicClient;
  return { pub, calls };
}

describe("tokens and USD values (pure, stub node)", () => {
  const savedEth = process.env.PURSER_ETH_USD;
  afterEach(() => {
    if (savedEth === undefined) delete process.env.PURSER_ETH_USD;
    else process.env.PURSER_ETH_USD = savedEth;
  });

  it("knows ETH and USDG without asking the node; USDG is one dollar", async () => {
    delete process.env.PURSER_ETH_USD;
    const { pub, calls } = stubPub();
    const t = makeTokens(pub, dep());
    assert.deepEqual(await t.info(ZERO), ETH_INFO);
    assert.deepEqual(await t.info(USDG.toUpperCase().replace("0X", "0x")), { address: USDG.toLowerCase(), symbol: "USDG", decimals: 6 });
    assert.equal(calls.length, 0);
    assert.equal(t.usdMicroSync(USDG, 2_500_000n), 2_500_000n);
    const m = t.money(USDG, 1_234_560_000n);
    assert.equal(m.display, "1,234.56 USDG");
    assert.equal(m.usd, "1234.56");
    assert.equal(m.amount, "1234560000");
  });

  it("reads and caches an unknown token's symbol and decimals; falls back when it is not a token", async () => {
    const { pub, calls } = stubPub();
    const t = makeTokens(pub, dep());
    const info = await t.info(OTHER);
    assert.deepEqual(info, { address: OTHER.toLowerCase(), symbol: "TST", decimals: 8 });
    await t.info(OTHER);
    assert.equal(calls.filter((c) => c.endsWith(":symbol")).length, 1, "cached after the first read");
    assert.equal(t.infoSync(OTHER).symbol, "TST");
    assert.equal(t.usdMicroSync(OTHER, 100n), null, "no price for unknown tokens");
    assert.equal(t.money(OTHER, 100_000_000n).usd, null);

    const bad = makeTokens(stubPub({ failTokens: true }).pub, dep());
    assert.deepEqual(await bad.info(OTHER), { address: OTHER.toLowerCase(), symbol: "TOKEN", decimals: 18 });
    assert.equal(bad.infoSync("0x00000000000000000000000000000000000000bb").symbol, "TOKEN");
  });

  it("prices ETH and WETH from the Chainlink feed (8 decimals to micro-dollars), at most once a minute", async () => {
    delete process.env.PURSER_ETH_USD;
    const { pub, calls } = stubPub({ answer: 2_500_12345678n });
    const t = makeTokens(pub, dep());
    assert.equal(t.usdMicroSync(ZERO, 10n ** 18n), null, "unknown before the first read");
    assert.equal(await t.ethUsdMicro(), 2_500_123_456n);
    assert.equal(await t.usdMicro(ZERO, 2n * 10n ** 18n), 5_000_246_912n);
    assert.equal(await t.usdMicro(WETH, 10n ** 17n), 250_012_345n);
    assert.equal(calls.filter((c) => c.endsWith("latestRoundData")).length, 1, "cached");
    assert.equal(t.money(ZERO, 10n ** 18n).usd, "2500.12");
    assert.equal(isEth(ZERO), true);
    assert.equal(isEth(USDG), false);
  });

  it("ignores a stale or failing feed and uses PURSER_ETH_USD instead; null without either", async () => {
    process.env.PURSER_ETH_USD = "1800.5";
    const stale = makeTokens(stubPub({ updatedAt: () => Math.floor(Date.now() / 1000) - 27 * 3600 }).pub, dep());
    assert.equal(await stale.ethUsdMicro(), 1_800_500_000n);
    const down = makeTokens(stubPub({ failFeed: true }).pub, dep());
    assert.equal(await down.ethUsdMicro(), 1_800_500_000n);
    const noFeed = makeTokens(stubPub().pub, dep({ ethUsdFeed: null }));
    assert.equal(await noFeed.usdMicro(ZERO, 10n ** 18n), 1_800_500_000n);
    delete process.env.PURSER_ETH_USD;
    const none = makeTokens(stubPub({ answer: 0n }).pub, dep());
    assert.equal(await none.ethUsdMicro(), null, "a zero answer is not a price");
    assert.equal(none.money(ZERO, 10n ** 18n).usd, null);
  });

  it("works without a deployment: only ETH is known", async () => {
    delete process.env.PURSER_ETH_USD;
    const t = makeTokens(stubPub().pub, null);
    assert.equal(t.infoSync(USDG).symbol, "TOKEN");
    assert.equal(t.usdMicroSync(USDG, 1n), null);
    assert.equal(await t.ethUsdMicro(), null);
  });
});
