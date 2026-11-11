/**
 * The owner's side of every action. The engine never signs for the owner: it returns a transaction (PreparedTx)
 * or a Safe transaction (PreparedSafeTx), and the owner's wallet signs and sends it.
 *
 * Two signers:
 * - MetaMask over EIP-1193: eth_sendTransaction, eth_signTypedData_v4 + execTransaction on the Safe, personal_sign
 *   for the owner session.
 * - The test wallet, only when the engine runs in test mode on a local node: the engine's /v1/testmode endpoints play
 *   the owner's wallet with a test key. It never exists on a live engine.
 */
import { encodeExecTransaction, encodeTransfer, toHexQuantity } from "./abi";
import { EngineError, api } from "./client";
import type { PreparedSafeTx, PreparedTx, TokenInfo } from "./types";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: never[]) => void): void;
  removeListener?(event: string, listener: (...args: never[]) => void): void;
  isMetaMask?: boolean;
  providers?: Eip1193Provider[];
}

export type SignerKind = "metamask" | "test";

export interface OwnerSigner {
  kind: SignerKind;
  address: string;
  /** An owner session token (own_...) for owner settings; signs in once and caches it. */
  session(force?: boolean): Promise<string>;
  /** Sends a prepared transaction from the owner's wallet and waits until it is mined. */
  sendTx(tx: PreparedTx): Promise<string>;
  /** Signs a prepared Safe transaction and executes it on the Safe; waits until it is mined. */
  execSafeTx(tx: PreparedSafeTx): Promise<string>;
  /** Moves money from the owner's wallet into an agent's Safe. */
  topUp(safe: string, token: TokenInfo, amount: bigint): Promise<string>;
  /** Approves or rejects a queued payment. */
  decide(intentId: string, decision: "approve" | "reject"): Promise<void>;
}

const SESSION_KEY = "purser-owner-session:";

/** The owner session saved in this browser, if it is still valid. */
export function cachedSession(address: string): string | null {
  return readSession(address);
}

function readSession(address: string): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY + address.toLowerCase());
    if (!raw) return null;
    const { token, expires } = JSON.parse(raw) as { token: string; expires: number };
    return expires * 1000 > Date.now() + 60_000 ? token : null;
  } catch {
    return null;
  }
}

function writeSession(address: string, token: string | null, expires = 0) {
  try {
    if (token) localStorage.setItem(SESSION_KEY + address.toLowerCase(), JSON.stringify({ token, expires }));
    else localStorage.removeItem(SESSION_KEY + address.toLowerCase());
  } catch {
    /* storage blocked: sign in again next time */
  }
}

function utf8Hex(text: string): string {
  return "0x" + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** eth_signTypedData_v4 needs the domain type spelled out. */
function withDomainType(typed: unknown): unknown {
  const t = typed as { types: Record<string, unknown>; domain: Record<string, unknown> };
  if (t.types.EIP712Domain) return t;
  const order: [string, string][] = [
    ["name", "string"],
    ["version", "string"],
    ["chainId", "uint256"],
    ["verifyingContract", "address"],
    ["salt", "bytes32"],
  ];
  const domainType = order.filter(([key]) => t.domain[key] !== undefined).map(([name, type]) => ({ name, type }));
  return { ...t, types: { EIP712Domain: domainType, ...t.types } };
}

async function waitForReceipt(provider: Eip1193Provider, hash: string): Promise<string> {
  for (let i = 0; i < 180; i++) {
    const receipt = (await provider.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null)) as { status?: string } | null;
    if (receipt) {
      if (receipt.status && receipt.status !== "0x1") throw new Error("The transaction failed on chain. Nothing changed.");
      return hash;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The transaction was sent but is not mined yet. Check MetaMask.");
}

export function metamaskSigner(provider: Eip1193Provider, address: string): OwnerSigner {
  const from = address;
  const send = async (tx: { to: string; data: string; value?: string }) => {
    const hash = (await provider.request({
      method: "eth_sendTransaction",
      params: [{ from, to: tx.to, data: tx.data, value: toHexQuantity(tx.value ?? "0") }],
    })) as string;
    return waitForReceipt(provider, hash);
  };
  const signer: OwnerSigner = {
    kind: "metamask",
    address,
    async session(force) {
      const cached = force ? null : readSession(address);
      if (cached) return cached;
      const { nonce, issued, message } = await api<{ nonce: string; issued: number; message: string }>("/v1/auth/nonce", { body: { address } });
      const signature = (await provider.request({ method: "personal_sign", params: [utf8Hex(message), from] })) as string;
      const session = await api<{ token: string; expires: number }>("/v1/auth/verify", { body: { address, nonce, issued, signature } });
      writeSession(address, session.token, session.expires);
      return session.token;
    },
    sendTx: (tx) => send(tx),
    async execSafeTx(tx) {
      const typed = JSON.stringify(withDomainType(tx.typedData));
      const signature = (await provider.request({ method: "eth_signTypedData_v4", params: [from, typed] })) as string;
      return send({ to: tx.safe, data: encodeExecTransaction(tx, signature) });
    },
    async topUp(safe, token, amount) {
      if (/^0x0{40}$/i.test(token.address)) return send({ to: safe, data: "0x", value: amount.toString() });
      return send({ to: token.address, data: encodeTransfer(safe, amount) });
    },
    async decide(intentId, decision) {
      const tx = await api<PreparedTx>(`/v1/approvals/${intentId}/prepare`, { body: { decision } });
      await send(tx);
    },
  };
  return signer;
}

export function testSigner(address: string): OwnerSigner {
  return {
    kind: "test",
    address,
    async session(force) {
      const cached = force ? null : readSession(address);
      if (cached) return cached;
      const s = await api<{ token: string; expires: number }>("/v1/testmode/session", { body: {} });
      writeSession(address, s.token, s.expires);
      return s.token;
    },
    async sendTx(tx) {
      return (await api<{ txHash: string }>("/v1/testmode/tx", { body: tx })).txHash;
    },
    async execSafeTx(tx) {
      return (await api<{ txHash: string }>("/v1/testmode/safe-tx", { body: tx })).txHash;
    },
    async topUp(safe, token, amount) {
      await api("/v1/testmode/fund", { body: { to: safe, amount: amount.toString() } });
      return "";
    },
    async decide(intentId, decision) {
      await api(`/v1/testmode/approvals/${intentId}`, { body: { decision } });
    },
  };
}

/** Runs an owner-session call; signs in again once if the engine no longer knows the session. */
export async function withOwner<T>(signer: OwnerSigner, call: (token: string) => Promise<T>): Promise<T> {
  try {
    return await call(await signer.session());
  } catch (error) {
    if (error instanceof EngineError && error.status === 401) {
      writeSession(signer.address, null);
      return call(await signer.session(true));
    }
    throw error;
  }
}
