import { concat, hashTypedData, keccak256, toHex, type Address, type Hex } from "viem";

/** EIP-712 types for Purser intents. They match contracts/src/PurserModule.sol exactly. */

export const intentTypes = {
  Pay: [
    { name: "safe", type: "address" },
    { name: "token", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "service", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Call: [
    { name: "safe", type: "address" },
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "dataHash", type: "bytes32" },
    { name: "spendToken", type: "address" },
    { name: "spendLimit", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Treasury: [
    { name: "safe", type: "address" },
    { name: "vault", type: "address" },
    { name: "deposit", type: "bool" },
    { name: "assets", type: "uint256" },
    { name: "limit", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  AgentOp: [
    { name: "safe", type: "address" },
    { name: "extension", type: "address" },
    { name: "opHash", type: "bytes32" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface PayIntent {
  safe: Address;
  token: Address;
  to: Address;
  amount: bigint;
  service: Hex;
  nonce: bigint;
  deadline: bigint;
}

export interface CallIntent {
  safe: Address;
  target: Address;
  value: bigint;
  data: Hex;
  spendToken: Address;
  spendLimit: bigint;
  nonce: bigint;
  deadline: bigint;
}

export interface TreasuryIntent {
  safe: Address;
  vault: Address;
  deposit: boolean;
  assets: bigint;
  limit: bigint;
  nonce: bigint;
  deadline: bigint;
}

export interface AgentOpIntent {
  safe: Address;
  extension: Address;
  opHash: Hex;
  token: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
}

export function purserDomain(chainId: number, module: Address) {
  return { name: "Purser", version: "1", chainId, verifyingContract: module } as const;
}

export function recurringDomain(chainId: number, recurring: Address) {
  return { name: "Purser Recurring", version: "2", chainId, verifyingContract: recurring } as const; // v2: a fresh firewall signature on every payout
}

export function payTypedData(chainId: number, module: Address, p: PayIntent) {
  return { domain: purserDomain(chainId, module), types: { Pay: intentTypes.Pay }, primaryType: "Pay" as const, message: p };
}

export function callTypedData(chainId: number, module: Address, c: CallIntent) {
  return {
    domain: purserDomain(chainId, module),
    types: { Call: intentTypes.Call },
    primaryType: "Call" as const,
    message: {
      safe: c.safe,
      target: c.target,
      value: c.value,
      dataHash: keccak256(c.data),
      spendToken: c.spendToken,
      spendLimit: c.spendLimit,
      nonce: c.nonce,
      deadline: c.deadline,
    },
  };
}

export function treasuryTypedData(chainId: number, module: Address, t: TreasuryIntent) {
  return {
    domain: purserDomain(chainId, module),
    types: { Treasury: intentTypes.Treasury },
    primaryType: "Treasury" as const,
    message: t,
  };
}

export function agentOpTypedData(chainId: number, module: Address, o: AgentOpIntent) {
  return {
    domain: purserDomain(chainId, module),
    types: { AgentOp: intentTypes.AgentOp },
    primaryType: "AgentOp" as const,
    message: o,
  };
}

export function heartbeatTypedData(chainId: number, recurring: Address, streamId: bigint, upTo: bigint) {
  return {
    domain: recurringDomain(chainId, recurring),
    types: {
      Heartbeat: [
        { name: "streamId", type: "uint256" },
        { name: "upTo", type: "uint256" },
      ],
    },
    primaryType: "Heartbeat" as const,
    message: { streamId, upTo },
  };
}

export const payDigest = (chainId: number, module: Address, p: PayIntent) => hashTypedData(payTypedData(chainId, module, p));
export const callDigest = (chainId: number, module: Address, c: CallIntent) =>
  hashTypedData(callTypedData(chainId, module, c));
export const treasuryDigest = (chainId: number, module: Address, t: TreasuryIntent) =>
  hashTypedData(treasuryTypedData(chainId, module, t));
export const agentOpDigest = (chainId: number, module: Address, o: AgentOpIntent) =>
  hashTypedData(agentOpTypedData(chainId, module, o));

/** Signatures go to the module as one blob: agent, then co-signer (if needed), then firewall (if set). */
export function packSignatures(...sigs: (Hex | null | undefined)[]): Hex {
  const list = sigs.filter((s): s is Hex => !!s);
  return list.length ? concat(list) : "0x";
}

/** An unordered nonce: 128 random bits, as a bigint. */
export function randomNonce(): bigint {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return BigInt(toHex(b));
}

/** Service ids are keccak256 of a readable name, e.g. serviceId("model:frontier-1"). */
export const serviceId = (name: string): Hex => keccak256(new TextEncoder().encode(name));

// ---------------------------------------------------------------------------------------------------- EIP-3009 / x402

export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export function transferAuthorizationTypedData(
  chainId: number,
  token: Address,
  tokenName: string,
  tokenVersion: string,
  auth: Eip3009Authorization,
) {
  return {
    domain: { name: tokenName, version: tokenVersion, chainId, verifyingContract: token },
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization" as const,
    message: auth,
  };
}
