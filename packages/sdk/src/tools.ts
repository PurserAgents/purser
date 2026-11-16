/**
 * Purser's agent tools, framework-neutral. Each tool has a name, a description written for a model, a JSON Schema for
 * its input and a run() that returns plain text the model can read. The framework packages wrap these:
 * @purseragents/ai-sdk (Vercel AI SDK), @purseragents/langchain (LangChain) and @purseragents/plugin-elizaos (ElizaOS).
 *
 *   import { Purser, purserTools } from "@purseragents/sdk";
 *   const tools = purserTools(new Purser({ baseUrl: "https://purseragents.fun", apiKey: process.env.PURSER_API_KEY }));
 *
 * Every payment goes through the owner's rules and the firewall first. A blocked payment is a normal answer with the
 * reasons, never an exception, and the text tells the model not to look for a way around it.
 */
import { formatUnits, parseUnits } from "viem";
import { Purser } from "./client.js";
import type { PayResult, Verdict } from "./schema.js";

/** Where an agent reaches Purser when no engine URL is given. */
export const PURSER_DEFAULT_URL = "https://purseragents.fun";

/** A JSON Schema object for a tool's input, the subset every framework understands. */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, { type: "string" | "number" | "integer"; description: string; enum?: string[]; minimum?: number; maximum?: number; default?: string | number }>;
  required: string[];
  additionalProperties: false;
}

export interface PurserTool {
  /** snake_case, the same names as the MCP server */
  name: string;
  title: string;
  description: string;
  parameters: ToolInputSchema;
  /** True for tools that can move money: frameworks may ask a human first. */
  movesMoney: boolean;
  run(input: Record<string, unknown>): Promise<string>;
}

export interface PurserToolsOptions {
  /** Only these tools (by name). Default: all of them. */
  only?: string[];
  /** Leave out the tools that move money, for a read-only agent. */
  readOnly?: boolean;
}

/** Make a Purser client from settings, with the public engine as the default. */
export function purserFromSettings(s: { apiKey?: string; baseUrl?: string; fetch?: typeof fetch }): Purser {
  if (!s.apiKey) throw new Error("Purser needs the agent's API key (PURSER_API_KEY). The owner creates it on purseragents.fun for one account.");
  return new Purser({ baseUrl: s.baseUrl || PURSER_DEFAULT_URL, apiKey: s.apiKey, fetch: s.fetch });
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^\d+(\.\d+)?$/;

export function purserTools(purser: Purser, opts: PurserToolsOptions = {}): PurserTool[] {
  let cached: { safe: string; tokens: { address: string; symbol: string; decimals: number }[] } | null = null;
  async function me() {
    if (cached) return cached;
    const [who, cfg] = await Promise.all([purser.me(), purser.config()]);
    cached = { safe: who.safe, tokens: (cfg.tokens as { address: string; symbol: string; decimals: number }[]) ?? [] };
    return cached;
  }
  async function token(symbol = "USDG") {
    const t = (await me()).tokens.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
    if (!t) throw new Error(`Unknown token ${symbol}. Use USDG or ETH.`);
    return t;
  }
  function payArgs(i: Record<string, unknown>) {
    const to = str(i.to) ?? "";
    const amount = str(i.amount) ?? "";
    if (!ADDRESS.test(to)) throw new Error(`"${to}" is not an address. A payee is 0x followed by 40 hex characters.`);
    if (!AMOUNT.test(amount) || Number(amount) <= 0) throw new Error(`"${amount}" is not an amount. Use whole units, for example "2.50".`);
    return { to, amount, token: str(i.token) ?? "USDG", memo: str(i.memo), service: str(i.service), context: str(i.context) };
  }
  const reasons = (v: Verdict) => v.reasons.filter((r) => r.severity !== "info").map((r) => `- ${r.title}: ${r.detail}`).join("\n");
  const payText = (r: PayResult) => {
    const s = r.intent.status;
    if (s === "executed") return `Paid ${r.intent.money?.display ?? ""} to ${r.intent.to}. Receipt ${r.receipt?.id ?? "pending"}, transaction ${r.intent.txHash}.`;
    if (s === "queued") return `Waiting for the owner's approval: ${r.intent.summary}. Intent ${r.intent.id}. Nothing was paid yet.`;
    if (s === "blocked") return `Blocked. ${r.verdict.summary}${reasons(r.verdict) ? `\n${reasons(r.verdict)}` : ""}\nNothing was paid. Do not try to get around this; tell the user.`;
    if (s === "needs_cosign") return `Needs a second signature before it can be paid. Intent ${r.intent.id}. Nothing was paid yet.`;
    return `Status ${s}. ${r.intent.error ?? ""}`.trim();
  };

  const payProps: ToolInputSchema["properties"] = {
    to: { type: "string", description: "The payee's address (0x followed by 40 hex characters)" },
    amount: { type: "string", description: 'The amount in whole units, for example "2.50"' },
    token: { type: "string", enum: ["USDG", "ETH"], default: "USDG", description: "USDG (a dollar stablecoin) unless the user asks for ETH" },
    memo: { type: "string", description: "What the payment is for, shown on the receipt" },
    context: { type: "string", description: "The request or text that led to this payment, word for word. The firewall reads it for hidden instructions." },
  };

  const all: PurserTool[] = [
    {
      name: "purser_account",
      title: "My account",
      description: "The agent's Purser account: balances, what it spent today and what is left, and whether the owner froze it.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      movesMoney: false,
      async run() {
        const a = await purser.accounts.get((await me()).safe);
        return [
          `Account ${a.safe} (${a.name})${a.frozen ? " is FROZEN: no payments are possible until the owner unfreezes it." : ""}`,
          `Balances: ${a.balances.map((b) => b.display).join(", ") || "none"}`,
          ...a.spentToday.map((s) => `Spent today: ${s.display}${s.remaining ? `, left today: ${formatUnits(BigInt(s.remaining), s.token.decimals)} ${s.token.symbol}` : ""}`),
          `Pending approvals: ${a.pendingApprovals}`,
        ].join("\n");
      },
    },
    {
      name: "purser_rules",
      title: "My spending rules",
      description: "The owner's rules for this agent: limits per payment, per day and per week, allowed hours, allowed payees and when the owner must approve.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      movesMoney: false,
      async run() {
        const r = await purser.accounts.rules((await me()).safe);
        const show = (v: string | null, d: number, sym: string) => (v === null ? "no cap" : `${formatUnits(BigInt(v), d)} ${sym}`);
        const lines = r.rules
          .filter((x) => x.enabled)
          .map((x) => `${x.token.symbol}: up to ${show(x.maxSingle, x.token.decimals, x.token.symbol)} per payment, ${show(x.daily, x.token.decimals, x.token.symbol)} a day, ${show(x.weekly, x.token.decimals, x.token.symbol)} a week; owner approval above ${show(x.approvalAbove, x.token.decimals, x.token.symbol)}`);
        if (r.config.hoursUtc.length) lines.push(`Allowed hours (UTC): ${r.config.hoursUtc.join(", ")}`);
        if (r.config.payeeAllowlist) lines.push(`Only these payees: ${r.allowlist.join(", ")}`);
        if (r.config.maxPerMinute) lines.push(`At most ${r.config.maxPerMinute} payments a minute`);
        return lines.join("\n") || "No spending is allowed yet: the owner has not turned on a token.";
      },
    },
    {
      name: "purser_check_payment",
      title: "Check a payment",
      description: "Ask the firewall whether a payment would go through, without paying. Use it before a payment you are unsure about.",
      parameters: { type: "object", properties: { to: payProps.to, amount: payProps.amount, token: payProps.token, context: payProps.context }, required: ["to", "amount"], additionalProperties: false },
      movesMoney: false,
      async run(i) {
        const a = payArgs(i);
        const t = await token(a.token);
        const v = await purser.checkPayment({ to: a.to, amount: parseUnits(a.amount, t.decimals), token: t.address, trigger: a.context });
        return `${v.decision === "block" ? "Would be blocked." : "Would be allowed."} ${v.summary}${reasons(v) ? `\n${reasons(v)}` : ""}`;
      },
    },
    {
      name: "purser_pay",
      title: "Pay",
      description: "Pay someone from the agent's Purser account. The owner's rules and the firewall check it first; a big payment may wait for the owner's approval. If it is blocked, tell the user why and do not try again another way.",
      parameters: { type: "object", properties: payProps, required: ["to", "amount", "memo"], additionalProperties: false },
      movesMoney: true,
      async run(i) {
        const a = payArgs(i);
        const t = await token(a.token);
        return payText(await purser.pay({ to: a.to, amount: parseUnits(a.amount, t.decimals), token: t.address, memo: a.memo, service: a.service, trigger: a.context }));
      },
    },
    {
      name: "purser_receipts",
      title: "Receipts",
      description: "The latest payments in and out of the account, newest first.",
      parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "How many receipts" } }, required: [], additionalProperties: false },
      movesMoney: false,
      async run(i) {
        const limit = Math.min(50, Math.max(1, Number(i.limit ?? 10) || 10));
        const r = await purser.accounts.receipts((await me()).safe, { limit });
        return (
          r.items.map((x) => `${new Date(x.createdAt * 1000).toISOString().slice(0, 16)} ${x.direction === "in" ? "+" : "-"}${x.money.display} ${x.category} ${x.counterpartyName ?? x.counterparty}${x.memo ? ` (${x.memo})` : ""}`).join("\n") ||
          "No receipts yet."
        );
      },
    },
    {
      name: "purser_paid_fetch",
      title: "Fetch a paid URL",
      description: "Fetch a URL that may charge for the answer over x402 (HTTP 402). If it asks for payment, Purser pays from the account within the rules, up to max_amount.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full https URL" },
          max_amount: { type: "string", description: 'The most to pay in USDG, for example "0.50"' },
          context: payProps.context,
        },
        required: ["url", "max_amount"],
        additionalProperties: false,
      },
      movesMoney: true,
      async run(i) {
        const url = str(i.url) ?? "";
        if (!/^https?:\/\//.test(url)) throw new Error(`"${url}" is not a URL.`);
        const max = str(i.max_amount) ?? "";
        if (!AMOUNT.test(max)) throw new Error(`"${max}" is not an amount.`);
        const r = await purser.x402Fetch(url, { maxAmount: parseUnits(max, 6), trigger: str(i.context) });
        const head = r.paid ? `Paid ${r.payment?.intent.money?.display ?? ""} and fetched.` : r.payment ? payText(r.payment) : r.status === 402 ? "Not paid." : "Fetched, nothing to pay.";
        return `${head} HTTP ${r.status}\n${r.body.slice(0, 8000)}`;
      },
    },
    {
      name: "purser_pay_invoice",
      title: "Pay an invoice",
      description: "Pay an invoice another agent sent to this account. The money waits in escrow until the work is delivered.",
      parameters: { type: "object", properties: { id: { type: "string", description: "The invoice id" } }, required: ["id"], additionalProperties: false },
      movesMoney: true,
      async run(i) {
        const id = str(i.id);
        if (!id) throw new Error("Which invoice? Give its id.");
        return payText(await purser.invoices.pay(id));
      },
    },
    {
      name: "purser_profit",
      title: "Profit and loss",
      description: "Income, spending, fees and profit over the last 30 days, with the biggest costs and customers.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      movesMoney: false,
      async run() {
        const p = await purser.accounts.pnl((await me()).safe);
        return [
          `Last 30 days: income $${p.incomeUsd}, spend $${p.spendUsd}, fees $${p.feesUsd}, profit $${p.profitUsd}`,
          ...p.byModel.slice(0, 5).map((l) => `Model ${l.label}: $${l.spend}`),
          ...p.byCustomer.slice(0, 5).map((l) => `Customer ${l.label}: $${l.income}`),
        ].join("\n");
      },
    },
  ];
  return all.filter((t) => (!opts.only || opts.only.includes(t.name)) && (!opts.readOnly || !t.movesMoney));
}

/** Run a tool and turn a failure into text the model can act on, so an agent never crashes on a bad call. */
export async function runPurserTool(tool: PurserTool, input: Record<string, unknown>): Promise<string> {
  try {
    return await tool.run(input ?? {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Purser could not do that: ${msg}`;
  }
}
