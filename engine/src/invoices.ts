import type { Hono } from "hono";
import { decodeEventLog, encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";
import { purserEscrowAbi } from "../../packages/sdk/src/abi.ts";
import type { Invoice, InvoiceStatus, PayResult } from "../../packages/sdk/src/schema.ts";
import { registerRoutes } from "./api/registry.ts";
import { agent, body, param, send, zAddr, zAmount128, zBytes32 } from "./api/http.ts";
import { explainRevert } from "./chain.ts";
import { chainNow, requireDep, type Ctx } from "./ctx.ts";
import { ingestReceipt, onExtension } from "./indexer.ts";
import { submitIntent } from "./intents.ts";
import { checkSafe, paymentProven } from "./proof.ts";
import { insertReceipt } from "./receipts.ts";
import { fail, id, lower, now, sameAddress, ZERO } from "./util.ts";

export interface InvoiceRow {
  id: string;
  payee: string;
  payer: string;
  arbiter: string | null;
  token: string;
  amount: string;
  description: string;
  deadline: number;
  review_period: number;
  review_until: number | null;
  status: InvoiceStatus;
  job_id: string | null;
  delivery_hash: string | null;
  created_at: number;
  updated_at: number;
}

export const invoiceRef = (iid: string): Hex => keccak256(toHex(iid));

export const invoiceView = (ctx: Ctx, r: InvoiceRow): Invoice => ({
  id: r.id,
  payee: r.payee as Address,
  payer: r.payer as Address,
  arbiter: (r.arbiter as Address) ?? null,
  money: ctx.tokens.money(r.token, BigInt(r.amount)),
  description: r.description,
  deadline: r.deadline,
  reviewPeriodSeconds: r.review_period,
  reviewUntil: r.review_until,
  status: r.status,
  jobId: r.job_id,
  deliveryHash: (r.delivery_hash as Hex) ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function invoiceRow(ctx: Ctx, iid: string): InvoiceRow {
  return (ctx.db.prepare("SELECT * FROM invoices WHERE id = ?").get(iid) as InvoiceRow | undefined) ?? fail(404, "not_found", "No such invoice.");
}

export function listInvoices(ctx: Ctx, safe?: string): Invoice[] {
  const rows = (safe
    ? ctx.db.prepare("SELECT * FROM invoices WHERE payee = ? OR payer = ? OR arbiter = ? ORDER BY created_at DESC").all(lower(safe), lower(safe), lower(safe))
    : ctx.db.prepare("SELECT * FROM invoices ORDER BY created_at DESC LIMIT 200").all()) as InvoiceRow[];
  return rows.map((r) => invoiceView(ctx, r));
}

function setStatus(ctx: Ctx, iid: string, patch: Partial<Pick<InvoiceRow, "status" | "job_id" | "delivery_hash" | "review_until">>) {
  const cur = invoiceRow(ctx, iid);
  const next = { ...cur, ...patch, updated_at: now() };
  ctx.db.prepare("UPDATE invoices SET status = ?, job_id = ?, delivery_hash = ?, review_until = ?, updated_at = ? WHERE id = ?").run(next.status, next.job_id, next.delivery_hash, next.review_until, next.updated_at, iid);
  const inv = invoiceView(ctx, next);
  ctx.bus.emit("invoice", inv.payee, inv);
  if (inv.payer !== inv.payee) ctx.bus.emit("invoice", inv.payer, inv);
  return inv;
}

/** Does a JobFunded event carry exactly this invoice's terms? */
export function fundedMatches(r: InvoiceRow, a: Record<string, unknown>): boolean {
  return (
    sameAddress(a.payer as string, r.payer) &&
    sameAddress(a.payee as string, r.payee) &&
    sameAddress(a.token as string, r.token) &&
    (a.amount as bigint) === BigInt(r.amount) &&
    Number(a.deadline as bigint) === r.deadline
  );
}

/** The token's own Transfer from the payer to the escrow for the amount (for ETH, the escrow's balance growth). */
async function fundProven(ctx: Ctx, tx: string, r: InvoiceRow): Promise<boolean> {
  return paymentProven(ctx, tx as Hex, { payer: r.payer, token: r.token, to: requireDep(ctx).escrow, amount: BigInt(r.amount) });
}

/** Stores a new open invoice. The payee asks for the money; for a hire the engine writes it from the listing. */
export function createInvoice(
  ctx: Ctx,
  i: { payee: string; payer: string; arbiter: string | null; token: string; amount: bigint; description: string; deadline: number; reviewPeriod: number },
): InvoiceRow {
  const iid = id("inv");
  ctx.db
    .prepare("INSERT INTO invoices (id, payee, payer, arbiter, token, amount, description, deadline, review_period, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
    .run(iid, lower(i.payee), lower(i.payer), i.arbiter ? lower(i.arbiter) : null, lower(i.token), i.amount.toString(), i.description, i.deadline, i.reviewPeriod, now(), now());
  return invoiceRow(ctx, iid);
}

// ---------------------------------------------------------------------------------------------------- escrow events

onExtension(async (ctx, source, ev, tx) => {
  if (source !== "escrow") return;
  const dep = requireDep(ctx);
  const a = ev.args as Record<string, unknown>;
  const jobId = (a.id as bigint).toString();
  const byJob = ctx.db.prepare("SELECT id FROM invoices WHERE job_id = ?").get(jobId) as { id: string } | undefined;
  if (ev.eventName === "JobFunded") {
    // the reference is public, so anyone could fund a job carrying it: only a job with exactly the invoice's payer,
    // payee, token, amount and deadline funds the invoice
    const all = ctx.db.prepare("SELECT * FROM invoices WHERE status = 'open'").all() as InvoiceRow[];
    const match = all.find((r) => invoiceRef(r.id) === (a.invoiceRef as string).toLowerCase() && fundedMatches(r, a));
    // and the money must be seen reaching the escrow, as for any payment
    if (match && (await fundProven(ctx, tx, match))) setStatus(ctx, match.id, { status: "funded", job_id: jobId });
    return;
  }
  if (!byJob) return;
  const job = await ctx.chain.pub.readContract({ address: dep.escrow, abi: purserEscrowAbi, functionName: "getJob", args: [a.id as bigint] });
  const incoming = async (to: string, amount: bigint, memo: string, n: number) => {
    if (!ctx.db.prepare("SELECT 1 FROM accounts WHERE safe = ?").get(lower(to)) || amount === 0n) return;
    if (!(await paymentProven(ctx, tx as Hex, { payer: dep.escrow, token: job.token, to, amount }))) return;
    insertReceipt(ctx, { uniq: `${tx}:escrow:${jobId}:${n}`, safe: to, direction: "in", category: "escrow", token: job.token, amount, counterparty: dep.escrow, memo, txHash: tx, customer: lower(job.payer) });
  };
  switch (ev.eventName) {
    case "JobDelivered":
      setStatus(ctx, byJob.id, { status: "delivered", delivery_hash: lower(a.deliveryHash as string), review_until: Number(a.reviewUntil) });
      break;
    case "JobDisputed":
      setStatus(ctx, byJob.id, { status: "disputed" });
      break;
    case "JobReleased":
      setStatus(ctx, byJob.id, { status: "released" });
      await incoming(job.payee, a.amount as bigint, "Invoice paid from escrow", 1);
      break;
    case "JobRefunded":
      setStatus(ctx, byJob.id, { status: "refunded" });
      await incoming(job.payer, a.amount as bigint, "Escrow refund", 2);
      break;
    case "JobResolved":
      setStatus(ctx, byJob.id, { status: "resolved" });
      await incoming(job.payee, a.toPayee as bigint, "Invoice paid by the arbiter's decision", 3);
      await incoming(job.payer, a.toPayer as bigint, "Refund by the arbiter's decision", 4);
      break;
  }
});

// ---------------------------------------------------------------------------------------------------- actions

/** An agent acts on the escrow from its own Safe (deliver, release, dispute, resolve): a module call. */
export async function escrowCallAsAgent(ctx: Ctx, auth: { safe: Address; session: PrivateKeyAccount | null }, data: Hex, memo: string): Promise<PayResult> {
  const dep = requireDep(ctx);
  return submitIntent(ctx, { safe: auth.safe, spec: { kind: "call", call: { target: dep.escrow, value: 0n, data, spendToken: ZERO, spendLimit: 0n } }, category: "escrow", signer: auth.session, meta: { memo } });
}

/**
 * A rule-based escrow call anyone may make (claim after the review window, refund after the deadline), relayed by
 * the engine. The gas counts against the share of the account the money goes to, and that account is checked fresh
 * as a real Purser Safe right before the transaction is sent.
 */
export async function relayEscrow(ctx: Ctx, data: Hex, account: string) {
  const dep = requireDep(ctx);
  const real = await checkSafe(ctx, account, { fresh: true }).catch(() => null);
  if (!real?.ok) return fail(409, "not_account", real ? "The account this payout is for is not a Purser Safe." : "The account could not be checked. Nothing was sent.");
  try {
    const r = await ctx.chain.send(ctx.chain.accounts.relayer!, { to: dep.escrow, data, account });
    if (r.status !== "success") throw new Error("reverted");
    await ingestReceipt(ctx, r);
    return r.transactionHash;
  } catch (e) {
    return fail(400, "escrow_refused", explainRevert(e));
  }
}

export const jobOf = (r: InvoiceRow) => (r.job_id ? BigInt(r.job_id) : fail(409, "not_funded", "This invoice is not funded yet."));
export const escrowDone = (res: PayResult) => (res.intent.status === "executed" ? res : fail(res.intent.status === "blocked" ? 422 : 400, `escrow_${res.intent.status}`, res.intent.error ?? res.verdict.summary));

/**
 * The payer's agent funds the escrow for an open invoice: a module call with an exact allowance to the escrow, so the
 * account's rules, the firewall (with the owner's hire rules) and any approval apply. The job is linked from the
 * JobFunded event in the receipt, after its terms are checked against the invoice.
 */
export async function fundInvoice(
  ctx: Ctx,
  auth: { safe: Address; session: PrivateKeyAccount | null },
  r: InvoiceRow,
  opts: { memo: string; trigger?: string | null; deadline?: bigint; category?: "escrow" },
): Promise<PayResult> {
  const dep = requireDep(ctx);
  const eth = sameAddress(r.token, ZERO);
  const data = encodeFunctionData({
    abi: purserEscrowAbi,
    functionName: "fund",
    args: [r.payee as Address, (r.arbiter ?? ZERO) as Address, r.token as Address, BigInt(r.amount), BigInt(r.deadline), r.review_period, invoiceRef(r.id)],
  });
  const res = await submitIntent(ctx, {
    safe: auth.safe,
    spec: { kind: "call", call: { target: dep.escrow, value: eth ? BigInt(r.amount) : 0n, data, spendToken: eth ? ZERO : (r.token as Address), spendLimit: eth ? 0n : BigInt(r.amount) } },
    category: "escrow",
    signer: auth.session,
    deadline: opts.deadline,
    meta: { memo: opts.memo, trigger: opts.trigger ?? null },
  });
  if (res.intent.status === "executed" && res.intent.txHash) await linkFromReceipt(ctx, r.id, res.intent.txHash);
  return res;
}

/** The JobFunded event of a transaction the engine sent, read straight from its receipt. */
export async function linkFromReceipt(ctx: Ctx, iid: string, tx: Hex) {
  if (invoiceRow(ctx, iid).job_id) return;
  const rc = await ctx.chain.pub.getTransactionReceipt({ hash: tx });
  for (const l of rc.logs) {
    if (!sameAddress(l.address, requireDep(ctx).escrow)) continue;
    try {
      const ev = decodeEventLog({ abi: purserEscrowAbi, data: l.data, topics: l.topics });
      const cur = invoiceRow(ctx, iid);
      if (ev.eventName === "JobFunded" && cur.status === "open" && invoiceRef(iid) === (ev.args as { invoiceRef: string }).invoiceRef.toLowerCase() && fundedMatches(cur, ev.args as never) && (await fundProven(ctx, tx, cur)))
        setStatus(ctx, iid, { status: "funded", job_id: (ev.args as { id: bigint }).id.toString() });
    } catch {
      /* other events */
    }
  }
}

registerRoutes((app: Hono, ctx: Ctx) => {
  app.post("/v1/invoices", async (c) => {
    const auth = agent(ctx, c, "invoices");
    const b = await body(
      c,
      z.object({
        payer: zAddr,
        amount: zAmount128,
        token: zAddr.optional(),
        description: z.string().min(1).max(500),
        deadline: z.number().int().optional(),
        dueInSeconds: z.number().int().min(60).optional(),
        reviewPeriodSeconds: z.number().int().min(60).default(86400),
        arbiter: zAddr.nullable().default(null),
      }),
    );
    if (sameAddress(b.payer, auth.safe)) fail(400, "bad_request", "An agent cannot invoice itself.");
    const deadline = b.deadline ?? (await chainNow(ctx)) + (b.dueInSeconds ?? 7 * 86400);
    const created = createInvoice(ctx, { payee: auth.safe, payer: b.payer, arbiter: b.arbiter, token: b.token ?? requireDep(ctx).usdg, amount: BigInt(b.amount), description: b.description, deadline, reviewPeriod: b.reviewPeriodSeconds });
    const iid = created.id;
    const inv = invoiceView(ctx, created);
    ctx.bus.emit("invoice", inv.payer, inv);
    await ctx.audit.append(`agent:${lower(auth.safe)}`, "invoice.created", auth.safe, { invoice: iid, payer: b.payer, amount: b.amount });
    return send(c, inv, 201);
  });
  app.get("/v1/invoices", (c) => send(c, { items: listInvoices(ctx, c.req.query("safe")), next: null }));
  app.get("/v1/accounts/:safe/invoices", (c) => send(c, { items: listInvoices(ctx, param(c, "safe")), next: null }));
  app.get("/v1/invoices/:id", (c) => send(c, invoiceView(ctx, invoiceRow(ctx, param(c, "id")))));

  /** The payer agent funds the escrow from its Safe: an exact allowance to the escrow, counted against its rules. */
  app.post("/v1/invoices/:id/pay", async (c) => {
    const auth = agent(ctx, c, "invoices");
    const r = invoiceRow(ctx, param(c, "id"));
    if (!sameAddress(r.payer, auth.safe)) fail(403, "not_payer", "Only the payer can pay this invoice.");
    if (r.status !== "open") fail(409, "wrong_state", `The invoice is ${r.status}.`);
    const res = await fundInvoice(ctx, auth, r, { memo: `Invoice ${r.id}: ${r.description.slice(0, 80)}` });
    if (res.intent.status !== "executed") return send(c, res, res.intent.status === "blocked" ? 422 : 200);
    return send(c, { ...res, invoice: invoiceView(ctx, invoiceRow(ctx, r.id)) });
  });

  app.post("/v1/invoices/:id/deliver", async (c) => {
    const auth = agent(ctx, c, "invoices");
    const b = await body(c, z.object({ deliveryHash: zBytes32.optional(), note: z.string().max(2000).optional() }));
    const r = invoiceRow(ctx, param(c, "id"));
    if (!sameAddress(r.payee, auth.safe)) fail(403, "not_payee", "Only the payee delivers.");
    const hash = b.deliveryHash ?? keccak256(toHex(b.note ?? r.id));
    const res = escrowDone(await escrowCallAsAgent(ctx, auth, encodeFunctionData({ abi: purserEscrowAbi, functionName: "deliver", args: [jobOf(r), hash] }), `Delivered invoice ${r.id}`));
    return send(c, { ...res, invoice: invoiceView(ctx, invoiceRow(ctx, r.id)) });
  });
  for (const action of ["release", "dispute"] as const) {
    app.post(`/v1/invoices/:id/${action}`, async (c) => {
      const auth = agent(ctx, c, "invoices");
      const r = invoiceRow(ctx, param(c, "id"));
      if (!sameAddress(r.payer, auth.safe)) fail(403, "not_payer", `Only the payer can ${action}.`);
      const res = escrowDone(await escrowCallAsAgent(ctx, auth, encodeFunctionData({ abi: purserEscrowAbi, functionName: action, args: [jobOf(r)] }), `${action === "release" ? "Released" : "Disputed"} invoice ${r.id}`));
      return send(c, { ...res, invoice: invoiceView(ctx, invoiceRow(ctx, r.id)) });
    });
  }
  app.post("/v1/invoices/:id/resolve", async (c) => {
    const auth = agent(ctx, c, "invoices");
    const b = await body(c, z.object({ payeeBps: z.number().int().min(0).max(10_000) }));
    const r = invoiceRow(ctx, param(c, "id"));
    if (!r.arbiter || !sameAddress(r.arbiter, auth.safe)) fail(403, "not_arbiter", "Only the arbiter resolves.");
    const res = escrowDone(await escrowCallAsAgent(ctx, auth, encodeFunctionData({ abi: purserEscrowAbi, functionName: "resolve", args: [jobOf(r), b.payeeBps] }), `Resolved invoice ${r.id}`));
    return send(c, { ...res, invoice: invoiceView(ctx, invoiceRow(ctx, r.id)) });
  });
  /** For a wallet (not an agent) that is a party: the transaction to send from that wallet. */
  app.post("/v1/invoices/:id/prepare", async (c) => {
    const b = await body(c, z.object({ action: z.enum(["deliver", "release", "dispute", "resolve"]), payeeBps: z.number().int().min(0).max(10_000).optional(), deliveryHash: zBytes32.optional() }));
    const r = invoiceRow(ctx, param(c, "id"));
    const job = jobOf(r);
    const data =
      b.action === "resolve"
        ? encodeFunctionData({ abi: purserEscrowAbi, functionName: "resolve", args: [job, b.payeeBps ?? 5000] })
        : b.action === "deliver"
          ? encodeFunctionData({ abi: purserEscrowAbi, functionName: "deliver", args: [job, b.deliveryHash ?? keccak256(toHex(r.id))] })
          : encodeFunctionData({ abi: purserEscrowAbi, functionName: b.action, args: [job] });
    return send(c, { chainId: ctx.cfg.chainId, to: requireDep(ctx).escrow, data, value: "0", description: `${b.action} invoice ${r.id}` });
  });
  /** Anyone may trigger the rule-based payouts. */
  app.post("/v1/invoices/:id/claim", async (c) => {
    const r = invoiceRow(ctx, param(c, "id"));
    return send(c, { txHash: await relayEscrow(ctx, encodeFunctionData({ abi: purserEscrowAbi, functionName: "claim", args: [jobOf(r)] }), r.payee), invoice: invoiceView(ctx, invoiceRow(ctx, r.id)) });
  });
  app.post("/v1/invoices/:id/refund", async (c) => {
    const r = invoiceRow(ctx, param(c, "id"));
    return send(c, { txHash: await relayEscrow(ctx, encodeFunctionData({ abi: purserEscrowAbi, functionName: "refund", args: [jobOf(r)] }), r.payer), invoice: invoiceView(ctx, invoiceRow(ctx, r.id)) });
  });
});
