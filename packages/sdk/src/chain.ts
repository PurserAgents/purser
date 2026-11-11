import type { Address } from "viem";

/** Robinhood Chain (4663). Every address here was checked on chain on 2026-11-11 (docs/ARCHITECTURE.md). */
export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const X402_NETWORK = "eip155:4663";

export const chainAddresses = {
  safeSingleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  safeProxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  safeFallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  entryPoint07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  validationRegistry: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  swapRouter02: "0xCaf681a66D020601342297493863E78C959E5cb2",
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  uniswapV4PoolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  usdgWethPool100: "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca",
  steakhouseUsdgVault: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd",
  sparkUsdgVault: "0xde770c84fe66e063336b31737cfe9790f18c4087",
  ethUsdFeed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
} as const satisfies Record<string, Address>;

/** USDG's EIP-712 domain (name "Global Dollar", version "1"), needed for EIP-3009 signatures. */
export const USDG_DOMAIN = { name: "Global Dollar", version: "1" } as const;

export const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
