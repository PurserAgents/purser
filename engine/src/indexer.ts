import { decodeEventLog, type Address, type Hex, type Log, type TransactionReceipt } from "viem";
import { purserEscrowAbi, purserModuleAbi, purserPasskeyAbi, purserRecurringAbi } from "../../packages/sdk/src/abi.ts";
import { upsertAccount } from "./accounts.ts";
import { getLogsChunked } from "./chain.ts";
import { requireDep, type Ctx } from "./ctx.ts";
import { kvGet, kvSet } from "./db.ts";
import { insertReceipt, type IntentRow } from "./receipts.ts";
import { lower, now, sameAddress } from "./util.ts";

type Decoded = { eventName: string; args: Record<string, unknown> };

function decode(ctx: Ctx, log: Log): { source: "module" | "recurring" | "escrow" | "passkey"; ev: Decoded } | null {
  const dep = ctx.dep!;
  const pairs: [Address, "module" | "recurring" | "escrow" | "passkey", readonly unknown[]][] = [
    [dep.module, "module", purserModuleAbi],
    [dep.recurring, "recurring", purserRecurringAbi],
    [dep.escrow, "escrow", purserEscrowAbi],
    [dep.passkey, "passkey", purserPasskeyAbi],
  ];
  for (const [addr, source, abi] of pairs) {
    if (!sameAddress(log.address, addr)) continue;
    try {
      const ev = decodeEventLog({ abi: abi as never, data: log.data, topics: log.topics }) as unknown as Decoded;
      return { source, ev };
    } catch {
      return null;
    }
  }
  return null;
}

const intentByDigest = (ctx: Ctx, digest: string) =>
  ctx.db
    .prepare("SELECT * FROM intents WHERE digest = ? ORDER BY (status IN ('submitted','approved','executed','queued')) DESC, created_at DESC, rowid DESC LIMIT 1")
    .get(lower(digest)) as IntentRow | undefined;
const intentByTx = (ctx: Ctx, tx: string) =>
  ctx.db.prepare("SELECT * FROM intents WHERE tx_hash = ? ORDER BY created_at DESC LIMIT 1").get(lower(tx)) as IntentRow | undefined;

function setSet(ctx: Ctx, safe: string, kind: string, value: string, on: boolean) {
  ctx.db
    .prepare("INSERT INTO account_sets (safe, kind, value, on_flag) VALUES (?, ?, ?, ?) ON CONFLICT(safe, kind, value) DO UPDATE SET on_flag = excluded.on_flag")
    .run(lower(safe), kind, lower(value), on ? 1 : 0);
}

/** Turns Purser events into receipts and account state. Idempotent: every log has a unique key. */
export async function ingestLogs(ctx: Ctx, logs: Log[], ts?: number) {
  const listeners: Promise<unknown>[] = [];
  // events per transaction, so a payment can be named by what happened around it (a stream settlement, a charge)
  const txEvents = new Map<string, Set<string>>();
  for (const log of logs) {
    const d = decode(ctx, log);
    if (!d) continue;
    const k = lower(log.transactionHash!);
    txEvents.set(k, (txEvents.get(k) ?? new Set()).add(d.ev.eventName));
  }
  const siblingCategory = (tx: string): string | null => {
    const ev = txEvents.get(tx);
    if (!ev) return null;
    if (ev.has("StreamSettled") || ev.has("StreamStopped")) return "stream";
    if (ev.has("SubscriptionCharged")) return "subscription";
    return null;
  };
  for (const log of logs) {
    const d = decode(ctx, log);
    if (!d) continue;
    const a = d.ev.args;
    const uniq = `${lower(log.transactionHash!)}:${log.logIndex}`;
    // every log is handled once, whether it arrives with the engine's own transaction or from the poller
    if (!ctx.db.prepare("INSERT OR IGNORE INTO seen_logs (uniq) VALUES (?)").run(uniq).changes) continue;
    const tx = lower(log.transactionHash!);
    const when = ts ?? now();
    const safe = a.safe ? lower(a.safe as string) : null;
    switch (d.ev.eventName) {
      case "AccountInitialized":
        upsertAccount(ctx, { safe: safe!, agent: a.agent as string });
        ctx.bus.emit("account", safe, { event: "initialized", safe });
        break;
      case "AgentIdSet":
        upsertAccount(ctx, { safe: safe!, agentId: (a.agentId as bigint).toString() });
        break;
      case "ConfigSet":
        upsertAccount(ctx, { safe: safe!, agent: a.agent as string });
        ctx.bus.emit("account", safe, { event: "config", safe });
        listeners.push(ctx.audit.append(`safe:${safe}`, "rules.config", safe, { agent: lower(a.agent as string), tx }));
        break;
      case "TokenRuleSet":
        listeners.push(ctx.audit.append(`safe:${safe}`, "rules.token", safe, { token: lower(a.token as string), tx }));
        break;
      case "SplitsSet":
        listeners.push(ctx.audit.append(`safe:${safe}`, "rules.splits", safe, { count: Number(a.count), tx }));
        break;
      case "ApproverSet":
      case "GuardianSet":
      case "CounterpartyLimitSet":
        listeners.push(ctx.audit.append(`safe:${safe}`, `rules.${d.ev.eventName.replace("Set", "").toLowerCase()}`, safe, { tx }));
        break;
      case "AllowedSet":
        setSet(ctx, safe!, "allow", a.target as string, a.allowed as boolean);
        break;
      case "ServiceSet":
        setSet(ctx, safe!, "service", a.service as string, a.allowed as boolean);
        break;
      case "TreasuryVaultSet":
        setSet(ctx, safe!, "vault", a.vault as string, a.allowed as boolean);
        break;
      case "ExtensionSet":
        setSet(ctx, safe!, "extension", a.extension as string, a.enabled as boolean);
        break;
      case "Frozen":
      case "Unfrozen": {
        const frozen = d.ev.eventName === "Frozen";
        ctx.bus.emit("account", safe, { event: frozen ? "frozen" : "unfrozen", safe, by: lower(a.by as string) });
        listeners.push(ctx.audit.append(`chain:${lower(a.by as string)}`, frozen ? "account.frozen" : "account.unfrozen", safe, { tx }));
        break;
      }
      case "IntentQueued": {
        const it = intentByDigest(ctx, a.digest as string);
        if (it && it.status !== "queued") ctx.db.prepare("UPDATE intents SET status = 'queued', updated_at = ? WHERE id = ?").run(now(), it.id);
        ctx.bus.emit("approval", safe, { event: "queued", digest: lower(a.digest as string), intentId: it?.id ?? null });
        break;
      }
      case "IntentApproved":
      case "IntentRejected": {
        const approved = d.ev.eventName === "IntentApproved";
        const it = intentByDigest(ctx, a.digest as string);
        if (it && (it.status === "queued" || it.status === "submitted"))
          ctx.db.prepare("UPDATE intents SET status = ?, updated_at = ? WHERE id = ?").run(approved ? "approved" : "rejected", now(), it.id);
        ctx.bus.emit("approval", safe, { event: approved ? "approved" : "rejected", digest: lower(a.digest as string), intentId: it?.id ?? null });
        listeners.push(ctx.audit.append(`owner:${lower(a.by as string)}`, approved ? "approval.approved" : "approval.rejected", safe, { digest: a.digest, intent: it?.id ?? null }));
        break;
      }
      case "Paid": {
        const digest = a.digest as string;
        const it = /^0x0+$/.test(digest) ? intentByTx(ctx, tx) : intentByDigest(ctx, digest);
        const meta = it ? JSON.parse(it.meta) : {};
        insertReceipt(ctx, {
          uniq,
          safe: safe!,
          direction: "out",
          category: it ? it.category : ((siblingCategory(tx) as never) ?? recurringCategory(ctx, tx, "transfer")),
          token: a.token as string,
          amount: a.amount as bigint,
          fee: a.fee as bigint,
          counterparty: a.to as string,
          service: meta.serviceRef ?? null,
          memo: meta.memo ?? null,
          txHash: tx,
          intentId: it?.id ?? null,
          verdictId: it?.verdict_id ?? null,
          taskId: meta.taskId ?? null,
          customer: meta.customer ?? null,
          model: meta.model ?? null,
          createdAt: when,
        });
        if (it && it.status !== "executed") ctx.db.prepare("UPDATE intents SET status = 'executed', tx_hash = ?, updated_at = ? WHERE id = ?").run(tx, now(), it.id);
        mirrorIncoming(ctx, { uniq, payer: safe!, payee: a.to as string, token: a.token as string, amount: a.amount as bigint, tx, when, category: it?.category ?? siblingCategory(tx) ?? "transfer", meta });
        break;
      }
      case "Outflow": {
        const it = intentByTx(ctx, tx);
        const meta = it ? JSON.parse(it.meta) : {};
        insertReceipt(ctx, {
          uniq,
          safe: safe!,
          direction: "out",
          category: it?.category ?? "onchain",
          token: a.token as string,
          amount: a.amount as bigint,
          fee: a.fee as bigint,
          counterparty: a.to as string,
          memo: meta.memo ?? null,
          txHash: tx,
          intentId: it?.id ?? null,
          verdictId: it?.verdict_id ?? null,
          taskId: meta.taskId ?? null,
          createdAt: when,
        });
        if (it && it.status !== "executed") ctx.db.prepare("UPDATE intents SET status = 'executed', updated_at = ? WHERE id = ?").run(now(), it.id);
        break;
      }
      case "Called": {
        const it = intentByDigest(ctx, a.digest as string);
        if (it && it.status !== "executed") ctx.db.prepare("UPDATE intents SET status = 'executed', tx_hash = ?, updated_at = ? WHERE id = ?").run(tx, now(), it.id);
        break;
      }
      case "TreasuryMoved": {
        const vault = lower(a.vault as string);
        const asset = ctx.db.prepare("SELECT value FROM kv WHERE key = ?").get(`vault_asset:${vault}`) as { value: string } | undefined;
        insertReceipt(ctx, {
          uniq,
          safe: safe!,
          direction: (a.deposit as boolean) ? "out" : "in",
          category: "treasury",
          token: asset?.value ?? ctx.dep!.usdg,
          amount: a.assets as bigint,
          counterparty: vault,
          memo: (a.deposit as boolean) ? "Moved to the vault" : "Taken back from the vault",
          txHash: tx,
          intentId: intentByTx(ctx, tx)?.id ?? null,
          createdAt: when,
        });
        break;
      }
      case "Received": {
        const ref = a.ref as string;
        const meta = ctx.db.prepare("SELECT value FROM kv WHERE key = ?").get(`ref:${lower(ref)}`) as { value: string } | undefined;
        const m = meta ? JSON.parse(meta.value) : {};
        insertReceipt(ctx, {
          uniq,
          safe: safe!,
          direction: "in",
          category: m.category ?? "transfer",
          token: a.token as string,
          amount: a.amount as bigint,
          counterparty: a.from as string,
          service: m.service ?? null,
          memo: m.memo ?? null,
          customer: m.customer ?? lower(a.from as string),
          txHash: tx,
          createdAt: when,
        });
        break;
      }
      case "SplitPaid":
        insertReceipt(ctx, {
          uniq,
          safe: safe!,
          direction: "out",
          category: "split",
          token: a.token as string,
          amount: a.amount as bigint,
          counterparty: a.to as string,
          memo: "Revenue split",
          txHash: tx,
          createdAt: when,
        });
        break;
      case "RecoveryStarted":
      case "RecoveryCancelled":
      case "RecoveryFinished":
        ctx.bus.emit("account", safe, { event: d.ev.eventName, safe });
        listeners.push(ctx.audit.append("chain", `recovery.${d.ev.eventName.replace("Recovery", "").toLowerCase()}`, safe, { tx }));
        break;
      default:
        if (d.source === "recurring" || d.source === "escrow") {
          ctx.bus.emit(d.source === "recurring" ? "stream" : "invoice", null, { event: d.ev.eventName, args: jsonable(a), tx });
          await onExtensionEvent(ctx, d.source, d.ev, tx);
        }
    }
  }
  await Promise.all(listeners);
}

/** A Paid event emitted through PurserRecurring has no intent row: tell streams from subscriptions by event order. */
function recurringCategory(ctx: Ctx, tx: string, fallback: "transfer") {
  const s = ctx.db.prepare("SELECT value FROM kv WHERE key = ?").get(`txcat:${tx}`) as { value: string } | undefined;
  return (s?.value ?? fallback) as never;
}

/** When one Purser account pays another, the payee gets an incoming receipt too. */
function mirrorIncoming(ctx: Ctx, args: { uniq: string; payer: string; payee: string; token: string; amount: bigint; tx: string; when: number; category: string; meta: Record<string, unknown> }) {
  const isAccount = ctx.db.prepare("SELECT 1 FROM accounts WHERE safe = ?").get(lower(args.payee));
  if (!isAccount) return;
  const ref = String(args.meta.serviceRef ?? "");
  const category = args.category === "internal" ? "internal" : ref.includes("/v1/store/") ? "storefront" : args.category === "x402" ? "x402" : "transfer";
  const svc = ref.includes("/v1/store/") ? ref.split("/v1/store/")[1].split(/[/?]/)[0] : null;
  insertReceipt(ctx, {
    uniq: `${args.uniq}:in`,
    safe: args.payee,
    direction: "in",
    category: category as never,
    token: args.token,
    amount: args.amount,
    counterparty: args.payer,
    service: svc,
    memo: (args.meta.memo as string) ?? null,
    customer: lower(args.payer),
    txHash: args.tx,
    createdAt: args.when,
  });
}

const extensionHandlers: ((ctx: Ctx, source: "recurring" | "escrow", ev: Decoded, tx: string) => Promise<void> | void)[] = [];
export function onExtension(h: (ctx: Ctx, source: "recurring" | "escrow", ev: Decoded, tx: string) => Promise<void> | void) {
  extensionHandlers.push(h);
}
async function onExtensionEvent(ctx: Ctx, source: "recurring" | "escrow", ev: Decoded, tx: string) {
  for (const h of extensionHandlers) await h(ctx, source, ev, tx);
}

function jsonable(o: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** Ingests the logs of a transaction the engine just sent (so receipts appear before the next poll). */
export async function ingestReceipt(ctx: Ctx, r: TransactionReceipt) {
  const block = await ctx.chain.pub.getBlock({ blockNumber: r.blockNumber }).catch(() => null);
  await ingestLogs(ctx, r.logs as Log[], block ? Number(block.timestamp) : undefined);
}

/** Polls the node for Purser events since the last cursor, in 100,000-block spans. */
export async function indexOnce(ctx: Ctx): Promise<number> {
  const dep = requireDep(ctx);
  const head = await ctx.chain.pub.getBlockNumber();
  const cursor = kvGet(ctx.db, "index_cursor");
  const start = kvGet(ctx.db, "index_start") ?? (dep.startBlock !== undefined ? String(dep.startBlock) : head.toString());
  const from = cursor ? BigInt(cursor) + 1n : BigInt(start);
  if (from > head) return 0;
  const logs = await getLogsChunked(ctx.chain.pub, {
    address: [dep.module, dep.recurring, dep.escrow, dep.passkey],
    fromBlock: from,
    toBlock: head,
  });
  const byBlock = new Map<bigint, Log[]>();
  for (const l of logs) {
    const k = l.blockNumber!;
    byBlock.set(k, [...(byBlock.get(k) ?? []), l]);
  }
  for (const [bn, ls] of [...byBlock.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const block = await ctx.chain.pub.getBlock({ blockNumber: bn }).catch(() => null);
    await ingestLogs(ctx, ls, block ? Number(block.timestamp) : undefined);
  }
  kvSet(ctx.db, "index_cursor", head.toString());
  return logs.length;
}

export function tagTx(ctx: Ctx, tx: Hex | string, category: string) {
  kvSet(ctx.db, `txcat:${lower(tx)}`, category);
}

export function tagRef(ctx: Ctx, ref: Hex | string, meta: Record<string, unknown>) {
  kvSet(ctx.db, `ref:${lower(ref)}`, JSON.stringify(meta));
}
