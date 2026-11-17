/**
 * Models at cost (phase 04).
 *
 * The agent calls a model through Purser with the key it already has (OpenAI-style /v1/chat/completions, model
 * "purser/<model>" or "auto:fast|balanced|best"). Purser calls the provider and charges the agent the provider's own
 * list price for the tokens the call used, with no markup.
 *
 * Paid before the call, never after: the owner controls the Safe, so a debt could always be emptied away before it
 * settles. Each account has a prepaid credit. A top-up is a payment from the account, through its rules and the
 * firewall, to the address in PURSER_MODELS_PAYTO, and counts only once the transfer is proven on chain. Before a
 * call the most it can cost is taken from the credit (atomically, so parallel calls cannot share the same money);
 * when the credit is short, the account tops it up first by at least PURSER_MODELS_TOPUP_MICRO (default $0.25, so
 * gas never costs more than the calls). After the call the unused part goes back to the credit. A call is never
 * answered without its maximum cost already paid.
 *
 * Settings: PURSER_MODELS_KEY (Anthropic key "Purser models"), PURSER_MODELS_PAYTO, PURSER_MODELS_URL (optional
 * base URL, used by tests), PURSER_MODELS_TOPUP_MICRO.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Hono } from "hono";
import type { Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";
import type { ModelUsage, PayResult } from "../../packages/sdk/src/schema.ts";
import { registerRoutes } from "./api/registry.ts";
import { agent, body, safeOwner, safeParam, send } from "./api/http.ts";
import { requireDep, type Ctx } from "./ctx.ts";
import { readChainAccount } from "./accounts.ts";
import { submitIntent } from "./intents.ts";
import { fail, id, lower, now, usd } from "./util.ts";

export type Level = "fast" | "balanced" | "best";

/** The provider's list prices, in millionths of a dollar per million tokens. */
export interface ModelPrice {
  id: string;
  name: string;
  provider: "anthropic";
  level: Level;
  inputMicroPer1M: number;
  outputMicroPer1M: number;
  /** Haiku has a second rate card for prompts above this many tokens. */
  longAbove?: number;
  longInputMicroPer1M?: number;
  longOutputMicroPer1M?: number;
}

export const MODELS: ModelPrice[] = [
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic", level: "fast", inputMicroPer1M: 100_000, outputMicroPer1M: 500_000, longAbove: 100_000, longInputMicroPer1M: 500_000, longOutputMicroPer1M: 2_500_000 },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", level: "balanced", inputMicroPer1M: 2_000_000, outputMicroPer1M: 10_000_000 },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", level: "best", inputMicroPer1M: 4_000_000, outputMicroPer1M: 20_000_000 },
];

const RANK: Record<Level, number> = { fast: 0, balanced: 1, best: 2 };
const PROVIDER = "purser";
const MAX_OUTPUT = 32_000;
const DEFAULT_OUTPUT = 1024;

export const modelsConfigured = () => !!process.env.PURSER_MODELS_KEY && !!process.env.PURSER_MODELS_PAYTO;
/** The smallest top-up of the prepaid credit (PURSER_MODELS_SETTLE_MICRO is the older name of the same setting). */
const topUpMicro = () => BigInt(process.env.PURSER_MODELS_TOPUP_MICRO ?? process.env.PURSER_MODELS_SETTLE_MICRO ?? "250000");
/** The service name a top-up payment carries; a payment with it to the models address is credited once proven. */
export const CREDIT_SERVICE = "model:purser/credit";
const payTo = () => (process.env.PURSER_MODELS_PAYTO ?? fail(503, "models_off", "Models at cost are not switched on for this engine.")) as Address;

/** Exact cost of a call in micro-dollars, rounded up to the next micro-dollar. */
export function costMicro(m: ModelPrice, inputTokens: number, outputTokens: number): bigint {
  const long = m.longAbove !== undefined && inputTokens > m.longAbove;
  const inRate = BigInt(long ? m.longInputMicroPer1M! : m.inputMicroPer1M);
  const outRate = BigInt(long ? m.longOutputMicroPer1M! : m.outputMicroPer1M);
  const total = BigInt(inputTokens) * inRate + BigInt(outputTokens) * outRate;
  return (total + 999_999n) / 1_000_000n;
}

/** Candidates for a model request, cheapest first: a named model, or every model at or above a level. */
export function candidates(model: string): ModelPrice[] {
  const name = model.replace(/^purser\//, "");
  const auto = /^auto(?::(fast|balanced|best))?$/.exec(name);
  if (auto) {
    const level = (auto[1] ?? "fast") as Level;
    return MODELS.filter((m) => RANK[m.level] >= RANK[level]).sort((a, b) => a.outputMicroPer1M - b.outputMicroPer1M);
  }
  const m = MODELS.find((x) => x.id === name);
  return m ? [m] : [];
}

export const isAtCostModel = (model: string) => candidates(model).length > 0;

type Msg = { role: string; content: unknown };
const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("") : c == null ? "" : JSON.stringify(c);

/** OpenAI-style messages to Anthropic: system apart, user and assistant alternating, starting with the user. */
export function toAnthropic(messages: Msg[]): { system: string | undefined; messages: { role: "user" | "assistant"; content: string }[] } {
  const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n\n") || undefined;
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const text = textOf(m.content);
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  }
  if (!out.length || out[0].role !== "user") out.unshift({ role: "user", content: "(continue)" });
  return { system, messages: out };
}

/** An upper bound for the input tokens: a token is never shorter than one byte of text, plus room for each message. */
const estimateInput = (messages: Msg[]) => messages.reduce((n, m) => n + Buffer.byteLength(textOf(m.content), "utf8") + 8, 16);

// ---------------------------------------------------------------------------------------------------- budgets

export interface ModelBudget {
  model: string;
  dailyMicro: string | null;
  perTaskMicro: string | null;
}

export function budgets(ctx: Ctx, safe: string): ModelBudget[] {
  return (ctx.db.prepare("SELECT model, daily_micro, per_task_micro FROM model_budgets WHERE safe = ? ORDER BY model").all(lower(safe)) as { model: string; daily_micro: string | null; per_task_micro: string | null }[]).map((r) => ({
    model: r.model,
    dailyMicro: r.daily_micro,
    perTaskMicro: r.per_task_micro,
  }));
}

export function setBudget(ctx: Ctx, safe: string, b: ModelBudget) {
  if (b.dailyMicro === null && b.perTaskMicro === null) ctx.db.prepare("DELETE FROM model_budgets WHERE safe = ? AND model = ?").run(lower(safe), b.model);
  else
    ctx.db
      .prepare("INSERT INTO model_budgets (safe, model, daily_micro, per_task_micro, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(safe, model) DO UPDATE SET daily_micro = excluded.daily_micro, per_task_micro = excluded.per_task_micro, updated_at = excluded.updated_at")
      .run(lower(safe), b.model, b.dailyMicro, b.perTaskMicro, now());
}

const dayStart = (t = now()) => t - (t % 86400);
const sum = (ctx: Ctx, where: string, args: unknown[]) => BigInt((ctx.db.prepare(`SELECT COALESCE(SUM(CAST(cost_micro AS INTEGER)), 0) AS n FROM model_calls WHERE provider = '${PROVIDER}' AND ${where}`).get(...args) as { n: number }).n);

/** Why a model may not take this call under the owner's budgets, or null when it may. */
function overBudget(ctx: Ctx, safe: string, m: ModelPrice, maxCost: bigint, taskId: string | null): string | null {
  const b = budgets(ctx, safe).find((x) => x.model === m.id);
  if (!b) return null;
  if (b.dailyMicro !== null && sum(ctx, "safe = ? AND model = ? AND created_at >= ?", [lower(safe), m.id, dayStart()]) + maxCost > BigInt(b.dailyMicro))
    return `This call could take ${m.name} over its daily budget of $${usd(BigInt(b.dailyMicro))}.`;
  if (taskId && b.perTaskMicro !== null && sum(ctx, "safe = ? AND model = ? AND task_id = ?", [lower(safe), m.id, taskId]) + maxCost > BigInt(b.perTaskMicro))
    return `This call could take ${m.name} over its budget of $${usd(BigInt(b.perTaskMicro))} for this task.`;
  return null;
}

// ---------------------------------------------------------------------------------------------------- owed and settlement

interface Unpaid {
  model: string;
  micro: bigint;
  prompt: number;
  completion: number;
  calls: number;
  oldest: number;
}

export function unpaid(ctx: Ctx, safe: string): Unpaid[] {
  const rows = ctx.db
    .prepare(
      `SELECT model, SUM(CAST(cost_micro AS INTEGER)) AS micro, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, COUNT(*) AS n, MIN(created_at) AS oldest
       FROM model_calls WHERE provider = '${PROVIDER}' AND safe = ? AND receipt_id IS NULL GROUP BY model ORDER BY model`,
    )
    .all(lower(safe)) as { model: string; micro: number; p: number; c: number; n: number; oldest: number }[];
  return rows.map((r) => ({ model: r.model, micro: BigInt(r.micro), prompt: r.p, completion: r.c, calls: r.n, oldest: r.oldest }));
}

const owedMicro = (u: Unpaid[]) => u.reduce((n, x) => n + x.micro, 0n);

function toUnits(ctx: Ctx, micro: bigint): bigint {
  const dep = requireDep(ctx);
  const dec = ctx.tokens.infoSync(dep.usdg).decimals;
  return dec >= 6 ? micro * 10n ** BigInt(dec - 6) : (micro + 10n ** BigInt(6 - dec) - 1n) / 10n ** BigInt(6 - dec);
}

export interface SettleResult {
  paid: { model: string; usd: string; calls: number; receipt: string | null; tx: string | null }[];
  refused: { model: string; usd: string; reason: string } | null;
}

/** Pays what the agent owes for model calls, one payment per model, from its own account. */
/**
 * The model payments go to one fixed address, so text inside a prompt can never redirect them. That is why the
 * prompt is not handed to the firewall as the reason for the payment: an agent summarising a hostile page must still
 * be able to pay for the summary.
 */
export async function settle(ctx: Ctx, auth: { safe: Address; session: PrivateKeyAccount | null }): Promise<SettleResult> {
  const dep = requireDep(ctx);
  const out: SettleResult = { paid: [], refused: null };
  for (const u of unpaid(ctx, auth.safe)) {
    if (u.micro === 0n) {
      ctx.db.prepare(`UPDATE model_calls SET receipt_id = 'free' WHERE provider = '${PROVIDER}' AND safe = ? AND model = ? AND receipt_id IS NULL`).run(lower(auth.safe), u.model);
      continue;
    }
    const name = MODELS.find((m) => m.id === u.model)?.name ?? u.model;
    const res: PayResult = await submitIntent(ctx, {
      safe: auth.safe,
      spec: { kind: "pay", pay: { token: dep.usdg, to: payTo(), amount: toUnits(ctx, u.micro), service: `model:${PROVIDER}/${u.model}` } },
      category: "model",
      signer: auth.session,
      meta: { memo: `${name}, ${u.calls} call${u.calls === 1 ? "" : "s"} at cost`, model: { provider: PROVIDER, model: u.model, promptTokens: u.prompt, completionTokens: u.completion } },
    });
    if (res.intent.status !== "executed" || !res.receipt) {
      out.refused = { model: u.model, usd: usd6(u.micro), reason: res.intent.status === "blocked" ? res.verdict.summary : !res.receipt && res.intent.status === "executed" ? "The payment was not seen reaching the payee." : res.intent.error ?? `The payment is ${res.intent.status}.` };
      break;
    }
    const usage: ModelUsage = { provider: PROVIDER, model: u.model, promptTokens: u.prompt, completionTokens: u.completion };
    if (res.receipt) ctx.db.prepare("UPDATE receipts SET model = ? WHERE id = ?").run(JSON.stringify(usage), res.receipt.id);
    ctx.db
      .prepare(`UPDATE model_calls SET receipt_id = ? WHERE provider = '${PROVIDER}' AND safe = ? AND model = ? AND receipt_id IS NULL AND created_at <= ?`)
      .run(res.receipt?.id ?? res.intent.id, lower(auth.safe), u.model, now());
    out.paid.push({ model: u.model, usd: usd6(u.micro), calls: u.calls, receipt: res.receipt?.id ?? null, tx: res.intent.txHash ?? null });
  }
  if (out.paid.length) await ctx.audit.append(`agent:${lower(auth.safe)}`, "models.settled", lower(auth.safe), { paid: out.paid });
  return out;
}

// ---------------------------------------------------------------------------------------------------- prepaid credit

export function creditMicro(ctx: Ctx, safe: string): bigint {
  const r = ctx.db.prepare("SELECT balance_micro AS b FROM model_credit WHERE safe = ?").get(lower(safe)) as { b: number } | undefined;
  return BigInt(r?.b ?? 0);
}

/** Takes `micro` from the credit only if it is all there. One statement, so two calls can never take the same money. */
function reserve(ctx: Ctx, safe: string, micro: bigint): boolean {
  return ctx.db.prepare("UPDATE model_credit SET balance_micro = balance_micro - ?, updated_at = ? WHERE safe = ? AND balance_micro >= ?").run(micro, now(), lower(safe), micro).changes === 1;
}

/** Gives back (or, with a negative amount, takes more of) the credit. */
function adjust(ctx: Ctx, safe: string, micro: bigint) {
  ctx.db.prepare("INSERT INTO model_credit (safe, balance_micro, updated_at) VALUES (?, ?, ?) ON CONFLICT(safe) DO UPDATE SET balance_micro = balance_micro + excluded.balance_micro, updated_at = excluded.updated_at").run(lower(safe), micro, now());
}

/** Micro-dollars a payment of `units` USDG is worth (exact for six decimals, rounded down otherwise). */
function unitsToMicro(ctx: Ctx, units: bigint): bigint {
  const dec = ctx.tokens.infoSync(requireDep(ctx).usdg).decimals;
  return dec >= 6 ? units / 10n ** BigInt(dec - 6) : units * 10n ** BigInt(6 - dec);
}

/**
 * Credits an executed top-up once: a payment of USDG to the models address with the credit service name, proven on
 * chain (an executed intent with its receipt; the relay only marks an intent executed when the transfer is seen).
 */
export function bookTopUp(ctx: Ctx, safe: string, intentId: string): bigint {
  const dep = requireDep(ctx);
  const it = ctx.db.prepare("SELECT safe, status, token, amount, to_addr, meta FROM intents WHERE id = ?").get(intentId) as { safe: string; status: string; token: string; amount: string; to_addr: string; meta: string } | undefined;
  if (!it || it.status !== "executed" || it.safe !== lower(safe) || !process.env.PURSER_MODELS_PAYTO) return 0n;
  if (JSON.parse(it.meta).serviceRef !== CREDIT_SERVICE || lower(it.token) !== lower(dep.usdg) || lower(it.to_addr) !== lower(process.env.PURSER_MODELS_PAYTO)) return 0n;
  const rec = ctx.db.prepare("SELECT id FROM receipts WHERE intent_id = ? AND status = 'executed' AND direction = 'out' LIMIT 1").get(intentId) as { id: string } | undefined;
  if (!rec) return 0n;
  const micro = unitsToMicro(ctx, BigInt(it.amount));
  const fresh = ctx.db.prepare("INSERT OR IGNORE INTO model_topups (intent_id, safe, receipt_id, micro, created_at) VALUES (?, ?, ?, ?, ?)").run(intentId, lower(safe), rec.id, micro, now()).changes;
  if (!fresh) return 0n;
  adjust(ctx, safe, micro);
  return micro;
}

const installed = new WeakSet<Ctx>();
/** A top-up the owner approved later (queued, then executed) is credited when it executes. */
function installHook(ctx: Ctx) {
  if (installed.has(ctx)) return;
  installed.add(ctx);
  ctx.hooks.afterExecuted.push((safe, iid) => void bookTopUp(ctx, safe, iid));
}

// one top-up at a time per account, so a burst of calls does not pay several times for the same shortfall
const locks = new Map<string, Promise<unknown>>();
function serial<T>(key: string, f: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(f);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => locks.get(key) === tail && locks.delete(key));
  return run;
}

type Funded = { ok: true; topUp: { res: PayResult; micro: bigint } | null } | { ok: false; refusal: AtCostResult };

/** Takes the most a call can cost from the credit, topping the credit up on chain first when it is short. */
async function fund(ctx: Ctx, auth: { safe: Address; session: PrivateKeyAccount | null }, maxCost: bigint, label: string): Promise<Funded> {
  const safe = lower(auth.safe);
  if (reserve(ctx, safe, maxCost)) return { ok: true, topUp: null };
  return serial(safe, async (): Promise<Funded> => {
    if (reserve(ctx, safe, maxCost)) return { ok: true, topUp: null };
    const short = maxCost - creditMicro(ctx, safe);
    const amount = short > topUpMicro() ? short : topUpMicro();
    const res = await submitIntent(ctx, {
      safe: auth.safe,
      spec: { kind: "pay", pay: { token: requireDep(ctx).usdg, to: payTo(), amount: toUnits(ctx, amount), service: CREDIT_SERVICE } },
      category: "model",
      signer: auth.session,
      meta: { memo: `Models at cost: prepaid credit for ${label} and later calls` },
    });
    if (res.intent.status === "executed" && res.receipt) bookTopUp(ctx, safe, res.intent.id);
    if (reserve(ctx, safe, maxCost)) return { ok: true, topUp: { res, micro: amount } };
    const st = res.intent.status;
    if (st === "blocked") return { ok: false, refusal: refuse(402, "payment_blocked", res.verdict.summary, { verdict: res.verdict.id }) };
    if (st === "queued" || st === "held" || st === "needs_cosign")
      return { ok: false, refusal: refuse(402, "needs_approval", `Topping up the model credit with $${usd6(amount)} needs the owner's approval under this account's rules. The call was not made.`) };
    return { ok: false, refusal: refuse(402, "payment_failed", `The model credit could not be topped up: ${res.intent.error ?? `the payment is ${st}`}. The call was not made.`) };
  });
}

// ---------------------------------------------------------------------------------------------------- the call

export interface AtCostResult {
  status: number;
  body: unknown;
}

let clientFactory: (() => Anthropic) | null = null;
/** Tests swap the provider client for a stand-in. */
export const _setClient = (f: (() => Anthropic) | null) => (clientFactory = f);
const client = () => clientFactory?.() ?? new Anthropic({ apiKey: process.env.PURSER_MODELS_KEY, ...(process.env.PURSER_MODELS_URL ? { baseURL: process.env.PURSER_MODELS_URL } : {}) });

/** Model money is tiny, so it is shown to the micro-dollar: 350 micro-dollars is "0.000350". */
export const usd6 = (micro: bigint) => `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0")}`;
/** The same with a sign: the credit is below zero only after a call that used more than its bound. */
const usd6s = (micro: bigint) => (micro < 0n ? `-${usd6(-micro)}` : usd6(micro));

const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): AtCostResult => ({ status, body: { error: { code, message, ...extra } } });

export async function chatAtCost(
  ctx: Ctx,
  auth: { safe: Address; session: PrivateKeyAccount | null },
  req: { model: string; messages: Msg[]; max_tokens?: number; max_completion_tokens?: number; [k: string]: unknown },
  meta: { taskId?: string | null },
): Promise<AtCostResult> {
  if (!modelsConfigured()) return refuse(503, "models_off", "Models at cost are not switched on for this engine yet.");
  const dep = requireDep(ctx);
  const list = candidates(req.model);
  if (!list.length) return refuse(404, "unknown_model", `Purser does not serve "${req.model}". Ask for one of ${MODELS.map((m) => m.id).join(", ")} or auto:fast, auto:balanced, auto:best.`);
  const maxOut = Math.min(Math.max(1, Number(req.max_completion_tokens ?? req.max_tokens ?? DEFAULT_OUTPUT) || DEFAULT_OUTPUT), MAX_OUTPUT);
  const inEst = estimateInput(req.messages);
  const taskId = meta.taskId ?? null;

  // 1. the cheapest model that may take the call under the owner's budgets
  let chosen: ModelPrice | null = null;
  let maxCost = 0n;
  const skipped: string[] = [];
  for (const m of list) {
    const c = costMicro(m, inEst, maxOut);
    const why = overBudget(ctx, auth.safe, m, c, taskId);
    if (why) skipped.push(why);
    else {
      chosen = m;
      maxCost = c;
      break;
    }
  }
  if (!chosen) return refuse(402, "model_budget", skipped.join(" "), { budgets: true });

  // 2. calls answered before credit existed are paid first; one that cannot be paid stops every new call
  installHook(ctx);
  let settled: SettleResult | null = null;
  if (unpaid(ctx, auth.safe).some((u) => u.micro > 0n)) {
    settled = await settle(ctx, auth);
    if (settled.refused) return refuse(402, "settlement_refused", `Paying for earlier model calls was refused: ${settled.refused.reason}`, { owedUsd: usd6(owedMicro(unpaid(ctx, auth.safe))) });
  }
  const acct = await readChainAccount(ctx, auth.safe);
  if (!acct.initialized) return refuse(402, "not_account", "This address has no Purser account.");
  if (acct.frozen) return refuse(402, "account_frozen", "The account is frozen. No model calls until the owner unfreezes it.");

  // 3. the most this call can cost is paid before the model is asked: from the credit, topped up on chain if short
  const funded = await fund(ctx, auth, maxCost, chosen.name);
  if (!funded.ok) return funded.refusal;

  // 4. the call; a call that fails gives the whole reservation back
  const a = toAnthropic(req.messages);
  let msg: Anthropic.Message;
  try {
    msg = await client().messages.create({ model: chosen.id, max_tokens: maxOut, ...(a.system ? { system: a.system } : {}), messages: a.messages });
  } catch (e) {
    adjust(ctx, auth.safe, maxCost);
    const status = (e as { status?: number }).status;
    return refuse(502, "provider_error", `${chosen.name} did not answer: ${(e as Error).message?.split("\n")[0] ?? "error"}. Nothing was charged.`, { providerStatus: status ?? null });
  }
  const input = msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0);
  const output = msg.usage.output_tokens;
  const cost = costMicro(chosen, input, output);
  // what was reserved and not used goes back; a call that used more than its bound is taken from the credit too
  adjust(ctx, auth.safe, maxCost - cost);
  const callId = id("mdl");
  const paidBy = (ctx.db.prepare("SELECT receipt_id FROM model_topups WHERE safe = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(lower(auth.safe)) as { receipt_id: string } | undefined)?.receipt_id ?? "credit";
  ctx.db
    .prepare("INSERT INTO model_calls (id, safe, provider, model, prompt_tokens, completion_tokens, cost_micro, receipt_id, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(callId, lower(auth.safe), PROVIDER, chosen.id, input, output, cost.toString(), paidBy, taskId, now());
  ctx.bus.emit("model", lower(auth.safe), { id: callId, model: chosen.id, costUsd: usd6(cost) });

  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const finish = msg.stop_reason === "max_tokens" ? "length" : "stop";
  return {
    status: 200,
    body: {
      id: msg.id,
      object: "chat.completion",
      created: now(),
      model: `${PROVIDER}/${chosen.id}`,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish }],
      usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
      purser: {
        call: callId,
        model: chosen.name,
        costUsd: usd6(cost),
        price: { inputPer1M: usd6(BigInt(chosen.inputMicroPer1M)), outputPer1M: usd6(BigInt(chosen.outputMicroPer1M)), markup: "0" },
        owedUsd: usd6(owedMicro(unpaid(ctx, auth.safe))),
        creditUsd: usd6s(creditMicro(ctx, auth.safe)),
        topUp: funded.topUp ? { usd: usd6(funded.topUp.micro), tx: funded.topUp.res.intent.txHash ?? null, receipt: funded.topUp.res.receipt?.id ?? null } : null,
        settled: settled?.paid ?? [],
        skipped,
      },
    },
  };
}

/** The public price list: the provider's own prices, nothing added. */
export const priceList = () =>
  MODELS.map((m) => ({
    id: `${PROVIDER}/${m.id}`,
    name: m.name,
    provider: m.provider,
    level: m.level,
    inputPer1MUsd: usd6(BigInt(m.inputMicroPer1M)),
    outputPer1MUsd: usd6(BigInt(m.outputMicroPer1M)),
    ...(m.longAbove ? { longPromptAbove: m.longAbove, longInputPer1MUsd: usd6(BigInt(m.longInputMicroPer1M!)), longOutputPer1MUsd: usd6(BigInt(m.longOutputMicroPer1M!)) } : {}),
    markup: "0",
  }));

// ---------------------------------------------------------------------------------------------------- routes

const zBudget = z.object({
  model: z.enum(MODELS.map((m) => m.id) as [string, ...string[]]),
  dailyUsd: z.number().nonnegative().nullable().default(null),
  perTaskUsd: z.number().nonnegative().nullable().default(null),
});
const toMicro = (v: number | null) => (v === null ? null : String(Math.round(v * 1_000_000)));

registerRoutes((app: Hono, ctx: Ctx) => {
  app.get("/v1/models/prices", (c) => send(c, { items: priceList(), topUpUsd: usd6(topUpMicro()), settleAtUsd: usd6(topUpMicro()), prepaid: true, on: modelsConfigured(), next: null }));

  app.post("/v1/models/settle", async (c) => {
    const auth = agent(ctx, c, "models");
    return send(c, await settle(ctx, auth));
  });

  app.get("/v1/models/owed", (c) => {
    const auth = agent(ctx, c, "models");
    const u = unpaid(ctx, auth.safe);
    return send(c, { owedUsd: usd6(owedMicro(u)), creditUsd: usd6s(creditMicro(ctx, auth.safe)), byModel: u.map((x) => ({ model: x.model, usd: usd6(x.micro), calls: x.calls })) });
  });

  app.get("/v1/accounts/:safe/model-budgets", (c) => {
    const safe = safeParam(c);
    return send(c, { items: budgets(ctx, safe).map((b) => ({ model: b.model, dailyUsd: b.dailyMicro === null ? null : usd6(BigInt(b.dailyMicro)), perTaskUsd: b.perTaskMicro === null ? null : usd6(BigInt(b.perTaskMicro)) })), next: null });
  });

  app.put("/v1/accounts/:safe/model-budgets", async (c) => {
    const safe = safeParam(c);
    await safeOwner(ctx, c, safe);
    const b = await body(c, zBudget);
    setBudget(ctx, safe, { model: b.model, dailyMicro: toMicro(b.dailyUsd), perTaskMicro: toMicro(b.perTaskUsd) });
    await ctx.audit.append("owner", "models.budget", lower(safe), { model: b.model, dailyUsd: b.dailyUsd, perTaskUsd: b.perTaskUsd });
    return send(c, { model: b.model, dailyUsd: b.dailyUsd, perTaskUsd: b.perTaskUsd });
  });

  app.get("/v1/accounts/:safe/model-spend", (c) => {
    const safe = lower(safeParam(c));
    const rows = ctx.db
      .prepare(`SELECT model, COUNT(*) AS calls, SUM(CAST(cost_micro AS INTEGER)) AS micro, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS o FROM model_calls WHERE provider = '${PROVIDER}' AND safe = ? AND created_at >= ? GROUP BY model`)
      .all(safe, dayStart()) as { model: string; calls: number; micro: number; p: number; o: number }[];
    return send(c, { today: rows.map((r) => ({ model: r.model, calls: r.calls, usd: usd6(BigInt(r.micro)), promptTokens: r.p, completionTokens: r.o })), owedUsd: usd6(owedMicro(unpaid(ctx, safe))), creditUsd: usd6s(creditMicro(ctx, safe)) });
  });
});

export const _test = { estimateInput, toUnits, unitsToMicro, reserve, PROVIDER, fail };
