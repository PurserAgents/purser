import type { Address, Hex, LocalAccount } from "viem";
import { payTypedData, randomNonce, serviceId, transferAuthorizationTypedData, type Eip3009Authorization } from "./eip712.js";

/** x402 version 2 wire types (scheme "exact", EVM). */

export interface PaymentRequirements {
  scheme: "exact";
  network: string; // CAIP-2, e.g. "eip155:4663"
  amount: string; // base units
  asset: Address; // token address; 0x000...0 = ETH (Purser accounts only)
  payTo: Address;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string; purser?: boolean; [k: string]: unknown };
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface ExactEvmPayload {
  signature: Hex;
  authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
}

/** Purser accounts pay with a signed Purser intent; the facilitator settles it through the Purser module. */
export interface PurserIntentPayload {
  purser: {
    kind: "pay";
    safe: Address;
    token: Address;
    to: Address;
    amount: string;
    service: Hex;
    nonce: string;
    deadline: string;
    signature: Hex;
  };
}

export interface PaymentPayload {
  x402Version: 1 | 2;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: ExactEvmPayload | PurserIntentPayload;
  extensions?: Record<string, unknown>;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: Address;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: Address;
  transaction: Hex | "";
  network: string;
  amount?: string;
}

export const HEADER_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_RESPONSE = "PAYMENT-RESPONSE";
export const HEADER_V1_PAYMENT = "X-PAYMENT";

const b64 = (s: string) => (typeof Buffer !== "undefined" ? Buffer.from(s, "utf8").toString("base64") : btoa(unescape(encodeURIComponent(s))));
const unb64 = (s: string) => (typeof Buffer !== "undefined" ? Buffer.from(s, "base64").toString("utf8") : decodeURIComponent(escape(atob(s))));

export const encodeHeader = (v: unknown) => b64(JSON.stringify(v));
export function decodeHeader<T>(v: string | null | undefined): T | null {
  if (!v) return null;
  try {
    return JSON.parse(unb64(v)) as T;
  } catch {
    return null;
  }
}

export const isPurserPayload = (p: PaymentPayload["payload"]): p is PurserIntentPayload => !!(p as PurserIntentPayload).purser;

function randomBytes32(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/** Builds an "exact" payload from a wallet that can sign EIP-712 (EIP-3009 TransferWithAuthorization). */
export async function createExactPayload(
  account: LocalAccount,
  req: PaymentRequirements,
  opts: { chainId?: number; resource?: ResourceInfo; validForSeconds?: number } = {},
): Promise<PaymentPayload> {
  const chainId = opts.chainId ?? Number(req.network.split(":")[1]);
  const now = Math.floor(Date.now() / 1000);
  const auth: Eip3009Authorization = {
    from: account.address,
    to: req.payTo,
    value: BigInt(req.amount),
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + (opts.validForSeconds ?? req.maxTimeoutSeconds ?? 120)),
    nonce: randomBytes32(),
  };
  const signature = await account.signTypedData(
    transferAuthorizationTypedData(chainId, req.asset, req.extra?.name ?? "Global Dollar", req.extra?.version ?? "1", auth),
  );
  return {
    x402Version: 2,
    resource: opts.resource,
    accepted: req,
    payload: {
      signature,
      authorization: {
        from: auth.from,
        to: auth.to,
        value: auth.value.toString(),
        validAfter: auth.validAfter.toString(),
        validBefore: auth.validBefore.toString(),
        nonce: auth.nonce,
      },
    },
  };
}

/** Picks the first requirement this payer can meet on the given network. */
export function pickRequirement(pr: PaymentRequired, network: string, assets?: Address[]): PaymentRequirements | null {
  return (
    pr.accepts.find(
      (a) => a.scheme === "exact" && a.network === network && (!assets || assets.some((x) => x.toLowerCase() === a.asset.toLowerCase())),
    ) ?? null
  );
}

/** Builds a payload for a Purser account: the agent's session key signs a Purser Pay intent to the merchant. */
export async function createPurserPayload(
  agent: LocalAccount,
  account: { safe: Address; module: Address; chainId: number },
  req: PaymentRequirements,
  opts: { resource?: ResourceInfo; service?: string; validForSeconds?: number } = {},
): Promise<PaymentPayload> {
  const intent = {
    safe: account.safe,
    token: req.asset,
    to: req.payTo,
    amount: BigInt(req.amount),
    service: serviceId(opts.service ?? opts.resource?.url ?? "x402"),
    nonce: randomNonce(),
    deadline: BigInt(Math.floor(Date.now() / 1000) + (opts.validForSeconds ?? 600)),
  };
  const signature = await agent.signTypedData(payTypedData(account.chainId, account.module, intent));
  return {
    x402Version: 2,
    resource: opts.resource,
    accepted: req,
    payload: {
      purser: {
        kind: "pay",
        safe: intent.safe,
        token: intent.token,
        to: intent.to,
        amount: intent.amount.toString(),
        service: intent.service,
        nonce: intent.nonce.toString(),
        deadline: intent.deadline.toString(),
        signature,
      },
    },
  };
}
