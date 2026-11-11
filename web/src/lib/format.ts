import type { Amount, Money } from "./types";

/** Anything with a symbol and decimals (TokenInfo from the engine). */
export interface Token {
  symbol: string;
  decimals: number;
}
type Units = Amount;

/** Parse a decimal string ("12.5") into base units. Display input only, never floats. */
export function parseUnits(value: string, decimals: number): bigint {
  const negative = value.startsWith("-");
  const [whole, frac = ""] = (negative ? value.slice(1) : value).split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const units = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
  return negative ? -units : units;
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Base units to a grouped decimal string with a fixed number of fraction digits (rounded half up). */
export function formatUnits(amount: Units | bigint, decimals: number, fractionDigits = 2): string {
  let value = typeof amount === "bigint" ? amount : BigInt(amount);
  const negative = value < 0n;
  if (negative) value = -value;
  const drop = decimals - fractionDigits;
  if (drop > 0) {
    const unit = 10n ** BigInt(drop);
    value = (value + unit / 2n) / unit;
  } else if (drop < 0) {
    value = value * 10n ** BigInt(-drop);
  }
  const text = value.toString().padStart(fractionDigits + 1, "0");
  const whole = text.slice(0, text.length - fractionDigits);
  const frac = fractionDigits > 0 ? "." + text.slice(-fractionDigits) : "";
  const isZero = value === 0n;
  return (negative && !isZero ? "-" : "") + group(whole) + frac;
}

function isDollar(token: Token): boolean {
  return token.symbol.toUpperCase() === "USDG";
}

/** "$1,240.50" for the dollar token, "0.42 ETH" for everything else. */
export function formatMoney(amount: Units | bigint, token: Token, fractionDigits?: number): string {
  if (isDollar(token)) {
    const text = formatUnits(amount, token.decimals, fractionDigits ?? 2);
    return text.startsWith("-") ? "-$" + text.slice(1) : "$" + text;
  }
  return formatUnits(amount, token.decimals, fractionDigits ?? 4) + " " + token.symbol;
}

/** Signed variant for P&L and receipts: "+$12.00" / "-$3.10". */
export function formatSigned(amount: Units | bigint, token: Token): string {
  const value = typeof amount === "bigint" ? amount : BigInt(amount);
  const text = formatMoney(value < 0n ? -value : value, token);
  return (value < 0n ? "-" : "+") + text;
}

/** Whole number of the token, for display math like chart heights and counters. Never for money arithmetic. */
export function toDisplayNumber(amount: Units | bigint, decimals: number): number {
  const value = typeof amount === "bigint" ? amount : BigInt(amount);
  const unit = 10n ** BigInt(decimals);
  return Number(value / unit) + Number(value % unit) / Number(unit);
}

/** Share of `part` in `whole` as 0..100, computed in base units. */
export function percentOf(part: Units | bigint, whole: Units | bigint): number {
  const p = typeof part === "bigint" ? part : BigInt(part);
  const w = typeof whole === "bigint" ? whole : BigInt(whole);
  if (w <= 0n) return 0;
  const basisPoints = (p * 10000n) / w;
  return Math.max(0, Math.min(100, Number(basisPoints) / 100));
}

export function sub(a: Units, b: Units): Units {
  return (BigInt(a) - BigInt(b)).toString();
}

export function shortAddress(address: string): string {
  return address.length > 12 ? address.slice(0, 6) + "..." + address.slice(-4) : address;
}

/** EVM addresses are compared without case. */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function formatCount(value: number): string {
  return group(Math.round(value).toString());
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "11 Nov, 14:32" in UTC, stable between server and client. Takes unix seconds or an ISO string. */
export function formatTime(when: number | string): string {
  const d = typeof when === "number" ? new Date(when * 1000) : new Date(when);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm}`;
}

export function formatDay(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "11 Nov 2026" in UTC. */
export function formatDate(when: number): string {
  const d = new Date(when * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** An engine Money value for people: "$12.50" for USDG, "0.0100 ETH" otherwise. */
export function money(m: Money | null | undefined, fractionDigits?: number): string {
  if (!m) return "None";
  return formatMoney(m.amount, m.token, fractionDigits);
}

/** A US dollar string from the engine ("12.5", "-3.45") as "$12.50" / "-$3.45". */
export function usd(value: string | null | undefined, fractionDigits = 2): string {
  if (value === null || value === undefined || value === "") return "$0.00";
  const negative = value.trim().startsWith("-");
  const units = parseUnits(negative ? value.trim().slice(1) : value.trim(), 6);
  const text = formatUnits(units, 6, fractionDigits);
  return (negative && units !== 0n ? "-$" : "$") + text;
}

/** "+$12.40" / "-$3.45" from a dollar string. */
export function usdSigned(value: string): string {
  const negative = value.trim().startsWith("-");
  const text = usd(value);
  return negative ? text : "+" + text;
}

/** Whole dollars from a dollar string, for display math only (chart heights). */
export function usdNumber(value: string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** "in 3 h", "2 min ago" against a reference time (unix seconds). */
export function relativeTime(when: number, nowSeconds: number): string {
  const diff = when - nowSeconds;
  const abs = Math.abs(diff);
  const unit = abs < 90 ? `${Math.max(1, Math.round(abs))} s` : abs < 5400 ? `${Math.round(abs / 60)} min` : abs < 172800 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86400)} days`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** "30 days", "1 hour", "per minute" helpers. */
export function formatDuration(seconds: number): string {
  if (seconds % 86400 === 0) return seconds === 86400 ? "1 day" : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "1 hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "1 minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
