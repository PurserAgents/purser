/**
 * The two calls the site encodes itself, so it needs no wallet library: Safe execTransaction (after the owner
 * signed the Safe transaction the engine prepared) and an ERC-20 transfer (topping up an agent from the wallet).
 */
import type { PreparedSafeTx } from "./types";

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const uint = (value: bigint | number | string) => word(BigInt(value).toString(16));
const bytes = (hex: string) => {
  const body = hex.replace(/^0x/, "").toLowerCase();
  const padded = body.padEnd(Math.ceil(body.length / 64) * 64, "0");
  return uint(body.length / 2) + padded;
};

/** execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) */
export function encodeExecTransaction(tx: PreparedSafeTx, signature: string): string {
  const message = ((tx.typedData as { message?: Record<string, string | number> } | null)?.message ?? {}) as Record<string, string | number>;
  const data = tx.data.replace(/^0x/, "");
  const dataWords = Math.ceil(data.length / 64);
  const dataOffset = 10 * 32;
  const sigOffset = dataOffset + 32 + dataWords * 32;
  return (
    "0x6a761202" +
    word(tx.to) +
    uint(tx.value) +
    uint(dataOffset) +
    uint(tx.operation) +
    uint(message.safeTxGas ?? 0) +
    uint(message.baseGas ?? 0) +
    uint(message.gasPrice ?? 0) +
    word(String(message.gasToken ?? "0x0")) +
    word(String(message.refundReceiver ?? "0x0")) +
    uint(sigOffset) +
    bytes(tx.data) +
    bytes(normaliseSignature(signature))
  );
}

/** Safe expects v as 27 or 28 for a plain ECDSA signature over the Safe transaction hash. */
export function normaliseSignature(signature: string): string {
  const hex = signature.replace(/^0x/, "");
  if (hex.length !== 130) return "0x" + hex;
  let v = parseInt(hex.slice(128), 16);
  if (v < 27) v += 27;
  return "0x" + hex.slice(0, 128) + v.toString(16).padStart(2, "0");
}

/** transfer(address,uint256) */
export function encodeTransfer(to: string, amount: bigint): string {
  return "0xa9059cbb" + word(to) + uint(amount);
}

export function toHexQuantity(value: bigint | string | number): string {
  return "0x" + BigInt(value).toString(16);
}
