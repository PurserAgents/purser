import { keccak256, pad, toEventSelector, toHex, type Address, type Hex, type Log } from "viem";
import { safeAbi } from "../../packages/sdk/src/abi.ts";
import { chainAddresses } from "../../packages/sdk/src/chain.ts";
import type { Ctx } from "./ctx.ts";
import { lower, sameAddress, ZERO } from "./util.ts";

/**
 * The module believes whatever the account answers when it asks it to move money, so an address only counts as a
 * Purser account when it is a real Safe: the Safe 1.4.1 proxy code, pointing at a known Safe 1.4.1 singleton, with
 * the Purser module enabled. And a payment only counts when the money is seen moving, never from Paid alone.
 */

/** keccak256 of the runtime code SafeProxyFactory 1.4.1 leaves at every proxy (no immutables: the same on every chain). */
export const SAFE_PROXY_CODEHASH = "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c" as Hex;
/** SafeL2 1.4.1 at its canonical address. PurserFactory deploys the plain Safe 1.4.1; an attached Safe may use L2. */
export const SAFE_L2_SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762" as Address;

export type SafeCheck = { ok: true; reason: null } | { ok: false; reason: "no_code" | "not_safe_proxy" | "unknown_singleton" | "module_not_enabled" };

const TTL_MS = 10 * 60_000;
const caches = new WeakMap<Ctx, Map<string, { res: SafeCheck; at: number }>>();
const cacheOf = (ctx: Ctx) => caches.get(ctx) ?? (caches.set(ctx, new Map()), caches.get(ctx)!);

export function singletons(ctx: Ctx): Address[] {
  return [chainAddresses.safeSingleton, SAFE_L2_SINGLETON, ...(ctx.dep?.safeSingleton ? [ctx.dep.safeSingleton] : [])].map(lower);
}

/**
 * Is this address a real Safe (and, with `module`, a Purser account)? Answers are cached per address for ten minutes;
 * "no code yet" and "module not enabled" are never cached, since both can change in the next block. `fresh` skips
 * the cache. Node errors are thrown, never read as a no.
 */
export async function checkSafe(ctx: Ctx, address: string, opts: { module?: boolean; fresh?: boolean } = {}): Promise<SafeCheck> {
  const addr = lower(address);
  const withModule = opts.module !== false;
  const key = `${addr}:${withModule ? 1 : 0}`;
  const cache = cacheOf(ctx);
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.res;
  const code = await ctx.chain.pub.getCode({ address: addr });
  let res: SafeCheck;
  if (!code || code === "0x") res = { ok: false, reason: "no_code" };
  else if (keccak256(code) !== SAFE_PROXY_CODEHASH) res = { ok: false, reason: "not_safe_proxy" };
  else {
    const slot0 = await ctx.chain.pub.getStorageAt({ address: addr, slot: "0x0" });
    const singleton = slot0 ? lower(`0x${slot0.slice(-40)}`) : ZERO;
    if (!singletons(ctx).includes(singleton)) res = { ok: false, reason: "unknown_singleton" };
    else if (withModule && ctx.dep && !(await ctx.chain.pub.readContract({ address: addr, abi: safeAbi, functionName: "isModuleEnabled", args: [ctx.dep.module] })))
      res = { ok: false, reason: "module_not_enabled" };
    else res = { ok: true, reason: null };
  }
  if (res.ok || (res.reason !== "no_code" && res.reason !== "module_not_enabled")) cache.set(key, { res, at: Date.now() });
  else cache.delete(key);
  return res;
}

/** A real Safe with the Purser module enabled. The test for anything that becomes or is treated as an account. */
export async function isPurserSafe(ctx: Ctx, address: string): Promise<boolean> {
  return (await checkSafe(ctx, address)).ok;
}

/** Tests (and an owner's change) can drop what is remembered about an address. */
export function forgetSafe(ctx: Ctx, address?: string) {
  const cache = cacheOf(ctx);
  if (!address) return cache.clear();
  for (const k of [...cache.keys()]) if (k.startsWith(`${lower(address)}:`)) cache.delete(k);
}

// ---------------------------------------------------------------------------------------------------- payment proof

export const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const MODULE_SUCCESS_TOPIC = toEventSelector("ExecutionFromModuleSuccess(address)");
const topicOf = (a: string) => pad(lower(a) as Hex, { size: 32 }).toLowerCase();

export interface PaymentClaim {
  payer: string;
  token: string; // ZERO = ETH
  to: string;
  amount: bigint;
}

const ETH_PSEUDO = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/**
 * The ETH this one transaction moved, from replaying its block up to and including it (eth_simulateV1 on the state
 * before the block, with ETH transfers traced). This sees inside the transaction: a Safe pointed at other code and
 * back around it moves nothing in the replay, whatever else happened in the block. null when the node cannot replay.
 */
async function ethMovedBy(ctx: Ctx, receipt: { blockNumber: bigint; transactionIndex?: number }): Promise<{ from: string; to: string; value: bigint }[] | null> {
  if (receipt.transactionIndex === undefined) return null;
  try {
    const block = await ctx.chain.pub.getBlock({ blockNumber: receipt.blockNumber, includeTransactions: true });
    const txs = block.transactions.slice(0, receipt.transactionIndex + 1);
    if (txs.length !== receipt.transactionIndex + 1 || typeof txs[0] === "string") return null;
    const calls = txs.map((t) => ({ from: t.from, ...(t.to ? { to: t.to } : {}), data: t.input, value: toHex(t.value), gas: toHex(t.gas) }));
    // several blocks a second share a timestamp: the node refuses a replayed block no later than its parent, so the
    // block's own time is set only when it is later
    const parent = await ctx.chain.pub.getBlock({ blockNumber: receipt.blockNumber - 1n });
    const blockOverrides = block.timestamp > parent.timestamp ? { time: toHex(block.timestamp) } : {};
    const res = (await ctx.chain.pub.request({
      method: "eth_simulateV1" as never,
      params: [{ blockStateCalls: [{ calls, blockOverrides }], traceTransfers: true, validation: false }, toHex(receipt.blockNumber - 1n)] as never,
    })) as { calls: { status: Hex; logs?: { address: string; topics: Hex[]; data: Hex }[] }[] }[];
    const ours = res[0]?.calls?.[txs.length - 1];
    if (!ours) return null;
    if (ours.status !== "0x1") return [];
    return (ours.logs ?? [])
      .filter((l) => lower(l.address) === ETH_PSEUDO && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics.length === 3)
      .map((l) => ({ from: lower(`0x${l.topics[1].slice(-40)}`), to: lower(`0x${l.topics[2].slice(-40)}`), value: BigInt(l.data) }));
  } catch {
    return null;
  }
}

/**
 * Checks payments against one transaction's receipt. ERC-20: the token's own Transfer log from the payer to the
 * payee for exactly the amount; each Transfer log proves one payment only. ETH (no log): both of these, where the node
 * can answer them: the transaction, replayed on its block, moves the ETH from the payer to the payee itself; and across
 * the block the payee's balance grew and the payer's fell by at least the ETH claimed between them. Where the node no
 * longer has the state of the block before, the replay stands with a fresh Safe check and the Safe's own module
 * execution event; where it cannot replay, the balances stand alone.
 */
export function txProof(ctx: Ctx, receipt: { logs: readonly Log[]; blockNumber: bigint; transactionIndex?: number }) {
  let replay: Promise<{ from: string; to: string; value: bigint }[] | null> | null = null;
  const used = new Set<number>();
  const ethClaimed = new Map<string, bigint>();
  const ethSent = new Map<string, bigint>();
  const delta = async (who: string) => {
    const [after, before] = await Promise.all([
      ctx.chain.pub.getBalance({ address: who as Address, blockNumber: receipt.blockNumber }),
      ctx.chain.pub.getBalance({ address: who as Address, blockNumber: receipt.blockNumber - 1n }),
    ]);
    return after - before;
  };
  return {
    async proves(c: PaymentClaim): Promise<boolean> {
      if (c.amount <= 0n) return false;
      if (sameAddress(c.token, ZERO)) {
        const to = lower(c.to);
        const from = lower(c.payer);
        const want = (ethClaimed.get(to) ?? 0n) + c.amount;
        const sent = (ethSent.get(from) ?? 0n) + c.amount;
        replay ??= ethMovedBy(ctx, receipt);
        const traced = await replay;
        let moved: { grew: bigint; fell: bigint } | null = null;
        try {
          const [g, f] = await Promise.all([delta(to), delta(from)]);
          moved = { grew: g, fell: -f };
        } catch {
          moved = null;
        }
        // both, where the node can answer both: the replay runs without fee fields, so code that looks at the gas price
        // could act differently there than on chain; the balances show what happened on chain
        const inReplay = traced ? traced.filter((t) => t.from === from && t.to === to).reduce((n, t) => n + t.value, 0n) >= want : null;
        const inBalances = moved ? moved.grew >= want && moved.fell >= sent : null;
        const fallback = async () =>
          (await checkSafe(ctx, c.payer, { fresh: true })).ok &&
          !!ctx.dep &&
          receipt.logs.some((l) => sameAddress(l.address, c.payer) && l.topics[0] === MODULE_SUCCESS_TOPIC && l.topics[1]?.toLowerCase() === topicOf(ctx.dep!.module));
        const ok =
          inReplay !== null && inBalances !== null
            ? inReplay && inBalances
            : inReplay !== null
              ? inReplay && (await fallback())
              : inBalances !== null
                ? inBalances
                : await fallback();
        if (ok) {
          ethClaimed.set(to, want);
          ethSent.set(from, sent);
        }
        return ok;
      }
      const i = receipt.logs.findIndex(
        (l, idx) =>
          !used.has(idx) &&
          sameAddress(l.address, c.token) &&
          l.topics.length === 3 &&
          l.topics[0] === TRANSFER_TOPIC &&
          l.topics[1]?.toLowerCase() === topicOf(c.payer) &&
          l.topics[2]?.toLowerCase() === topicOf(c.to) &&
          l.data !== "0x" &&
          BigInt(l.data) === c.amount,
      );
      if (i < 0) return false;
      used.add(i);
      return true;
    },
  };
}

/** One payment, one transaction: fetches the receipt when only the hash is known. */
export async function paymentProven(ctx: Ctx, tx: Hex | { logs: readonly Log[]; blockNumber: bigint; transactionIndex?: number }, c: PaymentClaim): Promise<boolean> {
  const r = typeof tx === "string" ? await ctx.chain.pub.getTransactionReceipt({ hash: tx }) : tx;
  return txProof(ctx, r).proves(c);
}

// ---------------------------------------------------------------------------------------------------- stored rows

/**
 * Rows written before this check existed: an account row whose address holds code that is not a real Safe is
 * removed, its keys revoked, its services switched off, and the income it "paid" to honest accounts taken out of
 * their books (mirrored receipts only; nothing on chain is touched). Addresses without code yet (a Safe about to
 * be created) and any node error leave the row as it is.
 */
export async function dropNonSafeAccounts(ctx: Ctx): Promise<string[]> {
  if (!ctx.dep) return [];
  const rows = ctx.db.prepare("SELECT safe FROM accounts").all() as { safe: string }[];
  const dropped: string[] = [];
  for (const r of rows) {
    let res: SafeCheck;
    try {
      res = await checkSafe(ctx, r.safe, { module: false, fresh: true });
    } catch {
      continue;
    }
    if (res.ok || res.reason === "no_code") continue;
    const safe = lower(r.safe);
    ctx.db.transaction(() => {
      ctx.db.prepare("DELETE FROM accounts WHERE safe = ?").run(safe);
      ctx.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE safe = ? AND revoked_at IS NULL").run(Math.floor(Date.now() / 1000), safe);
      ctx.db.prepare("UPDATE services SET active = 0 WHERE safe = ?").run(safe);
      ctx.db.prepare("DELETE FROM receipts WHERE direction = 'in' AND counterparty = ? AND uniq LIKE '%:in'").run(safe);
    })();
    await ctx.audit.append("engine", "account.dropped_not_safe", safe, { reason: res.reason });
    dropped.push(safe);
  }
  return dropped;
}

export const _test = { ethMovedBy };
