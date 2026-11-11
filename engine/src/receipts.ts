import type { Address, Hex } from "viem";
import type { Intent, IntentStatus, ModelUsage, Receipt, ReceiptCategory } from "../../packages/sdk/src/schema.ts";
import type { Ctx } from "./ctx.ts";
import { id, lower, now, parseJson } from "./util.ts";

export interface ReceiptRow {
  id: string;
  uniq: string | null;
  safe: string;
  direction: "out" | "in";
  category: ReceiptCategory;
  token: string;
  amount: string;
  fee: string | null;
  usd_micro: string;
  counterparty: string;
  service: string | null;
  memo: string | null;
  status: IntentStatus;
  tx_hash: string | null;
  intent_id: string | null;
  verdict_id: string | null;
  task_id: string | null;
  customer: string | null;
  model: string | null;
  created_at: number;
}

export function insertReceipt(
  ctx: Ctx,
  r: {
    uniq?: string | null;
    safe: string;
    direction: "out" | "in";
    category: ReceiptCategory;
    token: string;
    amount: bigint;
    fee?: bigint | null;
    counterparty: string;
    service?: string | null;
    memo?: string | null;
    status?: IntentStatus;
    txHash?: string | null;
    intentId?: string | null;
    verdictId?: string | null;
    taskId?: string | null;
    customer?: string | null;
    model?: ModelUsage | null;
    createdAt?: number;
  },
): Receipt | null {
  const rid = id("rcp");
  const usdMicro = ctx.tokens.usdMicroSync(r.token, r.amount) ?? 0n;
  const res = ctx.db
    .prepare(
      `INSERT OR IGNORE INTO receipts (id, uniq, safe, direction, category, token, amount, fee, usd_micro, counterparty, service, memo, status,
        tx_hash, intent_id, verdict_id, task_id, customer, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rid,
      r.uniq ?? null,
      lower(r.safe),
      r.direction,
      r.category,
      lower(r.token),
      r.amount.toString(),
      r.fee === undefined || r.fee === null ? null : r.fee.toString(),
      usdMicro.toString(),
      lower(r.counterparty),
      r.service ?? null,
      r.memo ?? null,
      r.status ?? "executed",
      r.txHash ?? null,
      r.intentId ?? null,
      r.verdictId ?? null,
      r.taskId ?? null,
      r.customer ?? null,
      r.model ? JSON.stringify(r.model) : null,
      r.createdAt ?? now(),
    );
  if (!res.changes) return null;
  const receipt = receiptFromRow(ctx, ctx.db.prepare("SELECT * FROM receipts WHERE id = ?").get(rid) as ReceiptRow);
  ctx.bus.emit("receipt", receipt.safe, receipt);
  return receipt;
}

export function receiptFromRow(ctx: Ctx, r: ReceiptRow): Receipt {
  const name = ctx.db.prepare("SELECT name FROM accounts WHERE safe = ?").get(r.counterparty) as { name: string } | undefined;
  const svc = r.service ? (ctx.db.prepare("SELECT name FROM services WHERE id = ?").get(r.service) as { name: string } | undefined) : undefined;
  return {
    id: r.id,
    safe: r.safe as Address,
    direction: r.direction,
    category: r.category,
    money: ctx.tokens.money(r.token, BigInt(r.amount)),
    fee: r.fee === null ? null : ctx.tokens.money(r.token, BigInt(r.fee)),
    counterparty: r.counterparty as Address,
    counterpartyName: name?.name ?? svc?.name ?? null,
    service: r.service,
    memo: r.memo,
    status: r.status,
    txHash: r.tx_hash as Hex | null,
    intentId: r.intent_id,
    verdictId: r.verdict_id,
    taskId: r.task_id,
    customer: r.customer,
    model: parseJson<ModelUsage | null>(r.model, null),
    createdAt: r.created_at,
  };
}

export function listReceipts(
  ctx: Ctx,
  opts: { safe?: string; direction?: string; category?: string; before?: number; limit?: number; publicOnly?: boolean },
): { items: Receipt[]; next: string | null } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.safe) {
    where.push("safe = ?");
    args.push(lower(opts.safe));
  }
  if (opts.direction) {
    where.push("direction = ?");
    args.push(opts.direction);
  }
  if (opts.category) {
    where.push("category = ?");
    args.push(opts.category);
  }
  if (opts.before) {
    where.push("created_at < ?");
    args.push(opts.before);
  }
  const limit = Math.min(opts.limit ?? 50, 200);
  const rows = ctx.db
    .prepare(`SELECT * FROM receipts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...args, limit + 1) as ReceiptRow[];
  const items = rows.slice(0, limit).map((r) => receiptFromRow(ctx, r));
  return { items, next: rows.length > limit ? String(items[items.length - 1].createdAt) : null };
}

export function getReceipt(ctx: Ctx, rid: string): Receipt | null {
  const r = ctx.db.prepare("SELECT * FROM receipts WHERE id = ?").get(rid) as ReceiptRow | undefined;
  return r ? receiptFromRow(ctx, r) : null;
}

// ---------------------------------------------------------------------------------------------------- intents

export interface IntentRow {
  id: string;
  safe: string;
  kind: Intent["kind"];
  digest: string;
  payload: string;
  sigs: string | null;
  status: IntentStatus;
  summary: string;
  token: string | null;
  amount: string | null;
  to_addr: string | null;
  category: ReceiptCategory;
  verdict_id: string | null;
  tx_hash: string | null;
  error: string | null;
  meta: string;
  created_at: number;
  updated_at: number;
}

export function intentFromRow(ctx: Ctx, r: IntentRow): Intent {
  return {
    id: r.id,
    safe: r.safe as Address,
    kind: r.kind,
    digest: r.digest as Hex,
    status: r.status,
    summary: r.summary,
    money: r.token && r.amount ? ctx.tokens.money(r.token, BigInt(r.amount)) : null,
    to: (r.to_addr as Address) ?? null,
    verdictId: r.verdict_id,
    txHash: r.tx_hash as Hex | null,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getIntentRow(ctx: Ctx, iid: string): IntentRow | undefined {
  return ctx.db.prepare("SELECT * FROM intents WHERE id = ?").get(iid) as IntentRow | undefined;
}

export function setIntent(ctx: Ctx, iid: string, patch: Partial<Pick<IntentRow, "status" | "verdict_id" | "tx_hash" | "error" | "sigs">>) {
  const cur = getIntentRow(ctx, iid);
  if (!cur) return;
  const next = { ...cur, ...patch, updated_at: now() };
  ctx.db
    .prepare("UPDATE intents SET status = ?, verdict_id = ?, tx_hash = ?, error = ?, sigs = ?, updated_at = ? WHERE id = ?")
    .run(next.status, next.verdict_id, next.tx_hash, next.error, next.sigs, next.updated_at, iid);
  const intent = intentFromRow(ctx, next);
  ctx.bus.emit("intent", intent.safe, intent);
  return intent;
}
