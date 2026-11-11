import type { Address, PublicClient } from "viem";
import { chainlinkAbi, erc20Abi } from "../../packages/sdk/src/abi.ts";
import type { Money, TokenInfo } from "../../packages/sdk/src/schema.ts";
import type { Deployment } from "./config.ts";
import { fmt, lower, now, sameAddress, usd, ZERO } from "./util.ts";

export type Tokens = ReturnType<typeof makeTokens>;

export const ETH_INFO: TokenInfo = { address: ZERO, symbol: "ETH", decimals: 18 };

/** Token metadata and USD values. USDG counts as one US dollar; ETH uses the chain's Chainlink ETH/USD feed. */
export function makeTokens(pub: PublicClient, dep: Deployment | null) {
  const cache = new Map<string, TokenInfo>();
  cache.set(ZERO, ETH_INFO);
  if (dep) cache.set(lower(dep.usdg), { address: lower(dep.usdg), symbol: "USDG", decimals: 6 });
  let ethPrice: { micro: bigint; at: number } | null = null;
  const envEth = process.env.PURSER_ETH_USD ? BigInt(Math.round(Number(process.env.PURSER_ETH_USD) * 1e6)) : null;

  async function info(addr: string): Promise<TokenInfo> {
    const key = lower(addr);
    const hit = cache.get(key);
    if (hit) return hit;
    try {
      const [symbol, decimals] = await Promise.all([
        pub.readContract({ address: key, abi: erc20Abi, functionName: "symbol" }),
        pub.readContract({ address: key, abi: erc20Abi, functionName: "decimals" }),
      ]);
      const t = { address: key, symbol, decimals: Number(decimals) };
      cache.set(key, t);
      return t;
    } catch {
      return { address: key, symbol: "TOKEN", decimals: 18 };
    }
  }

  const infoSync = (addr: string): TokenInfo => cache.get(lower(addr)) ?? { address: lower(addr), symbol: "TOKEN", decimals: 18 };

  /** Micro-dollars per whole ETH, refreshed at most once a minute. */
  async function ethUsdMicro(): Promise<bigint | null> {
    if (ethPrice && now() - ethPrice.at < 60) return ethPrice.micro;
    if (dep?.ethUsdFeed) {
      try {
        const [, answer, , updatedAt] = await pub.readContract({
          address: dep.ethUsdFeed,
          abi: chainlinkAbi,
          functionName: "latestRoundData",
        });
        if (answer > 0n && now() - Number(updatedAt) < 26 * 3600) {
          ethPrice = { micro: answer / 100n, at: now() }; // 8 decimals -> 6
          return ethPrice.micro;
        }
      } catch {
        /* fall through */
      }
    }
    return envEth;
  }

  /** USD value in micro-dollars, or null when no price is known. */
  function usdMicroSync(token: string, amount: bigint): bigint | null {
    const t = infoSync(token);
    if (dep && sameAddress(token, dep.usdg)) return (amount * 1_000_000n) / 10n ** BigInt(t.decimals);
    if (sameAddress(token, ZERO) || (dep?.weth && sameAddress(token, dep.weth))) {
      const p = ethPrice?.micro ?? envEth;
      return p === null ? null : (amount * p) / 10n ** 18n;
    }
    return null;
  }

  async function usdMicro(token: string, amount: bigint): Promise<bigint | null> {
    if (sameAddress(token, ZERO) || (dep?.weth && sameAddress(token, dep.weth))) await ethUsdMicro();
    return usdMicroSync(token, amount);
  }

  function money(token: string, amount: bigint): Money {
    const t = infoSync(token);
    const u = usdMicroSync(token, amount);
    return { token: t, amount: amount.toString(), display: `${fmt(amount, t.decimals)} ${t.symbol}`, usd: u === null ? null : usd(u) };
  }

  return { info, infoSync, money, usdMicro, usdMicroSync, ethUsdMicro };
}

export const isEth = (a: Address | string) => sameAddress(a, ZERO);
