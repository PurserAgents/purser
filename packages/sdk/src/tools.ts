/**
 * Purser's agent tools, framework-neutral. Each tool has a name, a description written for a model, a JSON Schema for
 * its input and a run() that returns plain text the model can read. The framework packages wrap these:
 * @purseragents/ai-sdk (Vercel AI SDK), @purseragents/langchain (LangChain) and @purseragents/plugin-elizaos (ElizaOS).
 *
 *   import { Purser, purserTools } from "@purseragents/sdk";
 *   const tools = purserTools(new Purser({ baseUrl: "https://purseragents.fun", apiKey: process.env.PURSER_API_KEY }));
 *
 * Agents can also hire each other: purser_find_agents, purser_hire, purser_jobs, purser_deliver and purser_accept pay
 * through escrow, released on delivery.
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

/** Seconds as words a model reads easily: "45 minutes", "3 hours", "2 days". */
function duration(s: number): string {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} minutes`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} hour${Math.round(s / 3600) === 1 ? "" : "s"}`;
  return `${Math.round(s / 86400)} days`;
}
const when = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

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
      name: "purser_ask_model",
      title: "Ask an AI model at cost",
      description:
        "Ask an AI model and pay the provider's own price for it from the account, with no markup. level picks the cheapest model good enough: fast, balanced or best. The owner's rules and model budgets apply.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What to ask the model" },
          level: { type: "string", enum: ["fast", "balanced", "best"], default: "fast", description: "fast is cheapest, best is the strongest model" },
          system: { type: "string", description: "Optional instructions for the model" },
          max_tokens: { type: "number", minimum: 1, maximum: 32000, default: 1024, description: "The longest answer to pay for" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      movesMoney: true,
      async run(i) {
        const prompt = str(i.prompt);
        if (!prompt) throw new Error("What should the model be asked?");
        const level = ["fast", "balanced", "best"].includes(String(i.level)) ? String(i.level) : "fast";
        const messages = [...(str(i.system) ? [{ role: "system", content: str(i.system)! }] : []), { role: "user", content: prompt }];
        const r = await purser.chat.completions.create({ model: `auto:${level}`, messages, max_tokens: Number(i.max_tokens ?? 1024) || 1024 });
        const who = r.purser.model ?? r.model;
        return `${r.choices[0]?.message.content ?? ""}\n\n(${who}, ` + "$" + `${r.purser.costUsd} at the provider's price)`;
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
      name: "purser_find_agents",
      title: "Find an agent to hire",
      description:
        "Search the marketplace for an agent that sells the work you need: price per job, delivery time, rating from paid jobs and how many jobs it completed. Hire one with purser_hire.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: 'What the work is, for example "competitor research" or "logo"' },
          sort: { type: "string", enum: ["best", "price", "rating", "fastest", "jobs"], default: "best", description: "best weighs rating, completed jobs, price and speed" },
          max_price: { type: "string", description: 'The most to pay for one job in USDG, for example "20"' },
          max_hours: { type: "number", minimum: 0, description: "The longest delivery time in hours" },
        },
        required: [],
        additionalProperties: false,
      },
      movesMoney: false,
      async run(i) {
        const max = str(i.max_price);
        if (max !== undefined && !AMOUNT.test(max)) throw new Error(`"${max}" is not an amount.`);
        const sort = ["best", "price", "rating", "fastest", "jobs"].includes(String(i.sort)) ? (String(i.sort) as "best") : "best";
        const r = await purser.market.search({ q: str(i.query), sort, maxPrice: max ? parseUnits(max, 6) : undefined, maxHours: i.max_hours === undefined ? undefined : Number(i.max_hours), limit: 10 });
        if (!r.items.length) return "No agent sells that yet. Try other words, a higher price or a longer delivery time.";
        return r.items
          .map((l) => `${l.id}: ${l.title} by ${l.sellerName ?? l.seller}. ${l.price.display} per job, delivers in ${duration(l.deliverySeconds)}. ${l.stats.rating === null ? "No ratings yet" : `Rated ${l.stats.rating} of 5 by ${l.stats.ratings} paying buyer${l.stats.ratings === 1 ? "" : "s"}`}, ${l.stats.completed} paid job${l.stats.completed === 1 ? "" : "s"}.${l.description ? ` ${l.description.slice(0, 160)}` : ""}`)
          .join("\n");
      },
    },
    {
      name: "purser_hire",
      title: "Hire an agent",
      description:
        "Hire an agent from the marketplace for one job. The price goes into escrow from this account, inside the owner's rules; the seller is paid only after you accept the delivery, and you get it back if nothing is delivered in time. If it is blocked, tell the user why and do not try again another way.",
      parameters: {
        type: "object",
        properties: {
          listing_id: { type: "string", description: "The listing id from purser_find_agents (lst_...)" },
          brief: { type: "string", description: "What exactly the seller should deliver. Only the seller sees it." },
          context: payProps.context,
        },
        required: ["listing_id", "brief"],
        additionalProperties: false,
      },
      movesMoney: true,
      async run(i) {
        const id = str(i.listing_id);
        const brief = str(i.brief);
        if (!id) throw new Error("Which listing? Give its id from purser_find_agents.");
        if (!brief) throw new Error("What should the seller deliver? Give a brief.");
        const r = await purser.market.hire(id, brief, str(i.context));
        const j = r.job;
        if (r.intent.status === "executed")
          return `Hired ${j.sellerName ?? j.seller} for "${j.title}". ${j.money.display} is in escrow for job ${j.id}. The seller is paid only when you accept the delivery with purser_accept (or the review window passes). If nothing is delivered by ${when(j.deliverBy)}, the money comes back.`;
        if (r.intent.status === "blocked") return `${payText(r)}`;
        return `${payText(r)} Job ${j.id}.`;
      },
    },
    {
      name: "purser_jobs",
      title: "My jobs",
      description: "Jobs this agent hired others for and jobs it was hired for: status, deadlines, the brief to work on and the results delivered.",
      parameters: { type: "object", properties: { role: { type: "string", enum: ["all", "buyer", "seller"], default: "all", description: "buyer: jobs I hired out; seller: jobs I was hired for" } }, required: [], additionalProperties: false },
      movesMoney: false,
      async run(i) {
        const role = i.role === "buyer" || i.role === "seller" ? i.role : undefined;
        const safe = (await me()).safe.toLowerCase();
        const r = await purser.market.jobs(safe, role);
        if (!r.items.length) return "No jobs yet.";
        const lines: string[] = [];
        let details = 0;
        for (const j of r.items.slice(0, 20)) {
          const selling = j.seller.toLowerCase() === safe;
          let line = `${j.id} ${selling ? "SOLD to" : "HIRED"} ${selling ? (j.buyerName ?? j.buyer) : (j.sellerName ?? j.seller)}: "${j.title}", ${j.money.display}, ${j.status.replace("_", " ")}`;
          if (selling && j.status === "funded") line += `, deliver by ${when(j.deliverBy)} with purser_deliver`;
          if (!selling && j.status === "delivered" && j.reviewUntil) line += `, accept with purser_accept before ${when(j.reviewUntil)} or the seller is paid anyway`;
          lines.push(line);
          const needs = (selling && j.status === "funded") || (!selling && j.status === "delivered");
          if (needs && details < 5) {
            details++;
            const d = await purser.market.jobDetail(j.id);
            lines.push(selling ? `  Brief: ${d.brief.slice(0, 2000)}` : `  Delivered: ${(d.result ?? "").slice(0, 4000)}`);
          }
        }
        return lines.join("\n");
      },
    },
    {
      name: "purser_deliver",
      title: "Deliver a job",
      description: "Deliver the work for a job this agent was hired for. The result goes to the buyer and its fingerprint goes on chain; the money in escrow is paid out when the buyer accepts, or when the review window passes.",
      parameters: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "The job id (job_...)" },
          result: { type: "string", description: "The work itself, or a link to it" },
        },
        required: ["job_id", "result"],
        additionalProperties: false,
      },
      movesMoney: false,
      async run(i) {
        const id = str(i.job_id);
        const result = str(i.result);
        if (!id) throw new Error("Which job? Give its id.");
        if (!result) throw new Error("What is the result? Give the work or a link to it.");
        const r = await purser.market.deliver(id, result);
        return `Delivered job ${r.job.id}. The buyer has until ${when(r.job.reviewUntil ?? 0)} to accept or dispute; after that the escrow pays you ${r.job.money.display}.`;
      },
    },
    {
      name: "purser_accept",
      title: "Accept a delivery",
      description: "Accept the work delivered for a job this agent hired out: the escrow pays the seller. Add a rating from 1 to 5 stars; only a buyer that paid can rate, once.",
      parameters: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "The job id (job_...)" },
          stars: { type: "integer", minimum: 1, maximum: 5, description: "How good the work was, 1 to 5" },
          review: { type: "string", description: "One or two sentences about the work" },
        },
        required: ["job_id"],
        additionalProperties: false,
      },
      movesMoney: true,
      async run(i) {
        const id = str(i.job_id);
        if (!id) throw new Error("Which job? Give its id.");
        const stars = i.stars === undefined || i.stars === null || i.stars === "" ? undefined : Number(i.stars);
        if (stars !== undefined && !(Number.isInteger(stars) && stars >= 1 && stars <= 5)) throw new Error("stars is a whole number from 1 to 5.");
        const r = await purser.market.accept(id, stars === undefined ? undefined : { stars, review: str(i.review) });
        return `Accepted. The escrow paid ${r.job.money.display} to ${r.job.sellerName ?? r.job.seller}.${r.job.rating ? ` Rated ${r.job.rating.stars} of 5.` : ""}`;
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
