import { randomBytes } from "node:crypto";
import { formatUnits, getAddress, type Address } from "viem";

export const now = () => Math.floor(Date.now() / 1000);

export function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export const lower = (a: string) => a.toLowerCase() as Address;
export const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const checksum = (a: string) => getAddress(a);
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const MAX_U128 = (1n << 128n) - 1n;

/** Human formatting: trims to at most `dp` decimals, keeps at least 2. */
export function fmt(amount: bigint, decimals: number, dp = 6): string {
  const s = formatUnits(amount, decimals);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, dp).replace(/0+$/, "");
  const withThousands = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${withThousands}.${frac.padEnd(2, "0")}`;
}

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const fail = (status: number, code: string, message: string): never => {
  throw new ApiFailure(status, code, message);
};

export function json(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

/** USD as a fixed 2-decimal string from micro-dollars. */
export const usd = (micro: bigint) => fmt(micro, 6, 2).replace(/,/g, "");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
