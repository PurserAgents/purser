/**
 * Models at cost (phase 04).
 *
 * The agent calls a model through Purser with the key it already has (OpenAI-style /v1/chat/completions, model
 * "purser/<model>" or "auto:fast|balanced|best"). Purser calls the provider and charges the agent the provider's own
 * list price for the tokens the call used: no markup, nothing prepaid. The charge is paid from the agent's account,
 * through its rules and the firewall, to the address in PURSER_MODELS_PAYTO.
 *
 * Gas would cost more than one cheap call, so calls settle on chain together: as soon as the agent owes
 * PURSER_MODELS_SETTLE_MICRO (default $0.25) or its oldest unpaid call is an hour old, the next call pays first,
 * one payment per model. Before every call the engine checks that the account may pay what it owes plus the most
 * this call can cost; if it may not, the call is refused before the model is ever asked.
 *
 * Settings: PURSER_MODELS_KEY (Anthropic key "Purser models"), PURSER_MODELS_PAYTO, PURSER_MODELS_URL (optional
 * base URL, used by tests), PURSER_MODELS_SETTLE_MICRO.
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
const settleAtMicro = () => BigInt(process.env.PURSER_MODELS_SETTLE_MICRO ?? "250000");
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

/** A safe upper bound for the input tokens, so the check before the call never underestimates. */
const estimateInput = (messages: Msg[]) => messages.reduce((n, m) => n + Math.ceil(textOf(m.content).length / 2.5) + 8, 16);

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
    if (res.intent.status !== "executed") {
      out.refused = { model: u.model, usd: usd6(u.micro), reason: res.intent.status === "blocked" ? res.verdict.summary : res.intent.error ?? `The payment is ${res.intent.status}.` };
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

const dueForSettlement = (u: Unpaid[]) => owedMicro(u) >= settleAtMicro() || u.some((x) => x.micro > 0n && now() - x.oldest >= 3600);

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

  // 2. settle what is owed first when it is due, so unpaid calls never pile up
  let owed = unpaid(ctx, auth.safe);
  let settled: SettleResult | null = null;
  if (dueForSettlement(owed)) {
    settled = await settle(ctx, auth);
    if (settled.refused) return refuse(402, "settlement_refused", `Paying for earlier model calls was refused: ${settled.refused.reason}`, { owedUsd: usd6(owedMicro(unpaid(ctx, auth.safe))) });
    owed = unpaid(ctx, auth.safe);
  }

  // 3. the account must be able to pay what it owes plus the most this call can cost, under its rules and the firewall
  const check = await submitIntent(ctx, {
    safe: auth.safe,
    spec: { kind: "pay", pay: { token: dep.usdg, to: payTo(), amount: toUnits(ctx, owedMicro(owed) + maxCost), service: `model:${PROVIDER}/${chosen.id}` } },
    category: "model",
    signer: auth.session,
    dryRun: true,
    meta: { memo: `${chosen.name}, check before the call` },
  });
  if (check.verdict.decision === "block") return refuse(402, "payment_blocked", check.verdict.summary, { verdict: check.verdict.id });
  if (check.verdict.reasons.some((r) => r.code === "needs_approval" || r.code === "needs_cosign") || /would hold/.test(check.intent.error ?? ""))
    return refuse(402, "needs_approval", `A call to ${chosen.name} could cost up to $${usd6(maxCost)}, which needs the owner's approval under this account's rules.`);
  ctx.db.prepare("DELETE FROM intents WHERE id = ? AND status = 'ready'").run(check.intent.id);

  // 4. the call
  const a = toAnthropic(req.messages);
  let msg: Anthropic.Message;
  try {
    msg = await client().messages.create({ model: chosen.id, max_tokens: maxOut, ...(a.system ? { system: a.system } : {}), messages: a.messages });
  } catch (e) {
    const status = (e as { status?: number }).status;
    return refuse(502, "provider_error", `${chosen.name} did not answer: ${(e as Error).message?.split("\n")[0] ?? "error"}. Nothing was charged.`, { providerStatus: status ?? null });
  }
  const input = msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0);
  const output = msg.usage.output_tokens;
  const cost = costMicro(chosen, input, output);
  const callId = id("mdl");
  ctx.db
    .prepare("INSERT INTO model_calls (id, safe, provider, model, prompt_tokens, completion_tokens, cost_micro, receipt_id, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)")
    .run(callId, lower(auth.safe), PROVIDER, chosen.id, input, output, cost.toString(), taskId, now());
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
  app.get("/v1/models/prices", (c) => send(c, { items: priceList(), settleAtUsd: usd6(settleAtMicro()), on: modelsConfigured(), next: null }));

  app.post("/v1/models/settle", async (c) => {
    const auth = agent(ctx, c, "models");
    return send(c, await settle(ctx, auth));
  });

  app.get("/v1/models/owed", (c) => {
    const auth = agent(ctx, c, "models");
    const u = unpaid(ctx, auth.safe);
    return send(c, { owedUsd: usd6(owedMicro(u)), byModel: u.map((x) => ({ model: x.model, usd: usd6(x.micro), calls: x.calls })) });
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
    return send(c, { today: rows.map((r) => ({ model: r.model, calls: r.calls, usd: usd6(BigInt(r.micro)), promptTokens: r.p, completionTokens: r.o })), owedUsd: usd6(owedMicro(unpaid(ctx, safe))) });
  });
});

export const _test = { estimateInput, dueForSettlement, toUnits, PROVIDER, fail };
