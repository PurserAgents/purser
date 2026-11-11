/**
 * @purser/sdk: a bank account for your AI agent, on Robinhood Chain.
 *
 *   import { Purser, usdg } from "@purser/sdk";
 *   const purser = new Purser({ baseUrl: "http://localhost:8787", apiKey: process.env.PURSER_API_KEY });
 *   const r = await purser.pay({ to: "0x...", amount: usdg("2.50"), memo: "data report" });
 *   if (r.intent.status === "blocked") console.log(r.verdict.summary);
 */
import { parseUnits, type Hex, type LocalAccount } from "viem";
import { callTypedData, payTypedData, randomNonce, serviceId, type CallIntent, type PayIntent } from "./eip712.js";

export { Purser, PurserError, type PurserOptions } from "./client.js";
export { verifyWebhook } from "./webhooks.js";
export * from "./eip712.js";
export * from "./chain.js";
export * from "./x402.js";
export { purserModuleAbi, purserFactoryAbi, purserRecurringAbi, purserEscrowAbi, purserPasskeyAbi, safeAbi, erc20Abi, erc4626Abi } from "./abi.js";
export type * from "./schema.js";

/** USDG amount in base units (6 decimals): usdg("2.50") === 2500000n. */
export const usdg = (v: string | number) => parseUnits(String(v), 6);
/** ETH amount in wei. */
export const eth = (v: string | number) => parseUnits(String(v), 18);

/**
 * For agents that keep their own session key: sign a payment intent locally and send it with
 * `purser.submitIntent(...)`. The engine still checks the rules and runs the firewall before relaying it.
 */
export async function signPayIntent(
  agent: LocalAccount,
  account: { safe: `0x${string}`; module: `0x${string}`; chainId?: number },
  p: { token: `0x${string}`; to: `0x${string}`; amount: bigint; service?: string; validForSeconds?: number },
) {
  const intent: PayIntent = {
    safe: account.safe,
    token: p.token,
    to: p.to,
    amount: p.amount,
    service: p.service ? serviceId(p.service) : (`0x${"0".repeat(64)}` as Hex),
    nonce: randomNonce(),
    deadline: BigInt(Math.floor(Date.now() / 1000) + (p.validForSeconds ?? 900)),
  };
  const signature = await agent.signTypedData(payTypedData(account.chainId ?? 4663, account.module, intent));
  return {
    kind: "pay" as const,
    safe: intent.safe,
    nonce: intent.nonce.toString(),
    deadline: intent.deadline.toString(),
    signature,
    pay: { token: intent.token, to: intent.to, amount: intent.amount.toString(), service: intent.service },
  };
}

export async function signCallIntent(
  agent: LocalAccount,
  account: { safe: `0x${string}`; module: `0x${string}`; chainId?: number },
  c: { target: `0x${string}`; data: Hex; value?: bigint; spendToken?: `0x${string}`; spendLimit?: bigint; validForSeconds?: number },
) {
  const intent: CallIntent = {
    safe: account.safe,
    target: c.target,
    value: c.value ?? 0n,
    data: c.data,
    spendToken: c.spendToken ?? "0x0000000000000000000000000000000000000000",
    spendLimit: c.spendLimit ?? 0n,
    nonce: randomNonce(),
    deadline: BigInt(Math.floor(Date.now() / 1000) + (c.validForSeconds ?? 900)),
  };
  const signature = await agent.signTypedData(callTypedData(account.chainId ?? 4663, account.module, intent));
  return {
    kind: "call" as const,
    safe: intent.safe,
    nonce: intent.nonce.toString(),
    deadline: intent.deadline.toString(),
    signature,
    call: { target: intent.target, value: intent.value.toString(), data: intent.data, spendToken: intent.spendToken, spendLimit: intent.spendLimit.toString() },
  };
}
