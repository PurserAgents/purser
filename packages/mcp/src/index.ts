#!/usr/bin/env node
/**
 * Purser MCP server (stdio). Gives an AI agent its own Purser account as tools.
 *
 *   PURSER_ENGINE_URL=http://localhost:8787 PURSER_API_KEY=prs_... npx @purser/mcp
 *
 * Every payment goes through the account's rules and the firewall; a blocked payment is reported with its reasons.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Purser, type PayResult, type Verdict } from "@purser/sdk";
import { z } from "zod";
import { formatUnits, parseUnits } from "./units.js";

export function createServer(purser: Purser) {
  const server = new McpServer({ name: "purser", version: "0.1.0" });
  let cached: { safe: string; usdg: string; tokens: { address: string; symbol: string; decimals: number }[] } | null = null;

  async function me() {
    if (cached) return cached;
    const [who, cfg] = await Promise.all([purser.me(), purser.config()]);
    const tokens = (cfg.tokens as { address: string; symbol: string; decimals: number }[]) ?? [];
    cached = { safe: who.safe, usdg: tokens.find((t) => t.symbol === "USDG")?.address ?? "", tokens };
    return cached;
  }
  async function token(symbol = "USDG") {
    const m = await me();
    const t = m.tokens.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
    if (!t) throw new Error(`Unknown token ${symbol}. Use USDG or ETH.`);
    return t;
  }
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
  const reasons = (v: Verdict) => v.reasons.filter((r) => r.severity !== "info").map((r) => `- ${r.title}: ${r.detail}`).join("\n");
  const payText = (r: PayResult) => {
    const s = r.intent.status;
    if (s === "executed") return `Paid ${r.intent.money?.display ?? ""} to ${r.intent.to}. Receipt ${r.receipt?.id ?? "pending"}, transaction ${r.intent.txHash}.`;
    if (s === "queued") return `Waiting for the owner's approval: ${r.intent.summary}. Intent ${r.intent.id}. Nothing was paid yet.`;
    if (s === "blocked") return `Blocked. ${r.verdict.summary}\n${reasons(r.verdict)}\nNothing was paid. Do not try to get around this; tell the user.`;
    if (s === "needs_cosign") return `Needs a second signature before it can be paid. Intent ${r.intent.id}.`;
    return `Status ${s}. ${r.intent.error ?? ""}`;
  };

  server.registerTool(
    "purser_account",
    { title: "My account", description: "The agent's Purser account: balances, what it spent today and what is left, whether it is frozen." },
    async () => {
      const a = await purser.accounts.get((await me()).safe);
      const lines = [
        `Account ${a.safe} (${a.name})${a.frozen ? " is FROZEN: no payments are possible until the owner unfreezes it." : ""}`,
        `Balances: ${a.balances.map((b) => b.display).join(", ")}`,
        ...a.spentToday.map((s) => `Spent today: ${s.display}${s.remaining ? `, left today: ${formatUnits(BigInt(s.remaining), s.token.decimals)} ${s.token.symbol}` : ""}`),
        `Pending approvals: ${a.pendingApprovals}`,
      ];
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "purser_rules",
    { title: "My spending rules", description: "The owner's rules for this agent: budgets, limits, allowed hours, allowlists, approval thresholds." },
    async () => {
      const r = await purser.accounts.rules((await me()).safe);
      const show = (v: string | null, d: number, sym: string) => (v === null ? "no cap" : `${formatUnits(BigInt(v), d)} ${sym}`);
      const lines = r.rules.filter((x) => x.enabled).map((x) => `${x.token.symbol}: up to ${show(x.maxSingle, x.token.decimals, x.token.symbol)} per payment, ${show(x.daily, x.token.decimals, x.token.symbol)} a day, ${show(x.weekly, x.token.decimals, x.token.symbol)} a week; owner approval above ${show(x.approvalAbove, x.token.decimals, x.token.symbol)}`);
      if (r.config.hoursUtc.length) lines.push(`Allowed hours (UTC): ${r.config.hoursUtc.join(", ")}`);
      if (r.config.payeeAllowlist) lines.push(`Only these payees: ${r.allowlist.join(", ")}`);
      if (r.config.maxPerMinute) lines.push(`At most ${r.config.maxPerMinute} payments a minute`);
      return text(lines.join("\n"));
    },
  );

  const payShape = {
    to: z.string().describe("The payee address (0x...)"),
    amount: z.string().describe('Amount in whole units, for example "2.50"'),
    token: z.enum(["USDG", "ETH"]).default("USDG"),
    memo: z.string().optional().describe("What the payment is for"),
    service: z.string().optional().describe('A service id, for example "model:frontier-1"'),
    context: z.string().optional().describe("The request or text that led to this payment. The firewall reads it."),
  };

  server.registerTool(
    "purser_pay",
    { title: "Pay", description: "Pay from the agent's account. The rules and the firewall check it first; the owner may need to approve.", inputSchema: payShape },
    async (a) => {
      const t = await token(a.token);
      const r = await purser.pay({ to: a.to, amount: parseUnits(a.amount, t.decimals), token: t.address, memo: a.memo, service: a.service, trigger: a.context });
      return text(payText(r));
    },
  );

  server.registerTool(
    "purser_check_payment",
    { title: "Check a payment", description: "Ask the firewall about a payment without making it.", inputSchema: payShape },
    async (a) => {
      const t = await token(a.token);
      const v = await purser.checkPayment({ to: a.to, amount: parseUnits(a.amount, t.decimals), token: t.address, service: a.service, trigger: a.context });
      return text(`${v.summary}${v.reasons.length ? `\n${reasons(v)}` : ""}`);
    },
  );

  server.registerTool(
    "purser_receipts",
    { title: "Receipts", description: "The latest receipts of this account.", inputSchema: { limit: z.number().int().min(1).max(50).default(10) } },
    async ({ limit }) => {
      const r = await purser.accounts.receipts((await me()).safe, { limit });
      return text(r.items.map((x) => `${new Date(x.createdAt * 1000).toISOString().slice(0, 16)} ${x.direction === "in" ? "+" : "-"}${x.money.display} ${x.category} ${x.counterpartyName ?? x.counterparty}${x.memo ? ` (${x.memo})` : ""}`).join("\n") || "No receipts yet.");
    },
  );

  server.registerTool(
    "purser_x402_fetch",
    {
      title: "Fetch a paid URL",
      description: "Fetch a URL that may ask for payment over x402; pays from the account within the rules.",
      inputSchema: { url: z.string().url(), method: z.string().default("GET"), body: z.string().optional(), max_amount: z.string().optional().describe('Most to pay in USDG, e.g. "0.50"'), context: z.string().optional() },
    },
    async (a) => {
      const r = await purser.x402Fetch(a.url, { method: a.method, body: a.body, maxAmount: a.max_amount ? parseUnits(a.max_amount, 6) : undefined, trigger: a.context });
      return text(`${r.paid ? "Paid and fetched." : r.status === 402 ? "Not paid." : "Fetched."} HTTP ${r.status}\n${r.body.slice(0, 8000)}`);
    },
  );

  server.registerTool(
    "purser_sell",
    {
      title: "Sell a service",
      description: "Put a service on sale over x402. Buyers pay into this account; returns the paid URL.",
      inputSchema: { name: z.string(), description: z.string().default(""), price: z.string().describe('Price in USDG, e.g. "0.25"'), pricing: z.enum(["per_call", "per_minute", "subscription"]).default("per_call"), upstream: z.string().url().optional().describe("Where the work is done"), response: z.string().optional().describe("A fixed answer, if there is no upstream") },
    },
    async (a) => {
      const s = await purser.store.create({ name: a.name, description: a.description, price: parseUnits(a.price, 6), model: a.pricing, upstream: a.upstream, response: a.response });
      return text(`On sale: ${s.name} at ${s.pricing.price.display} (${s.pricing.model}). Buyers call ${s.endpoint}`);
    },
  );

  server.registerTool(
    "purser_services",
    { title: "My services", description: "Services this account sells, with uses and revenue." },
    async () => {
      const s = await purser.store.list((await me()).safe);
      return text(s.items.map((x) => `${x.name}: ${x.pricing.price.display} ${x.pricing.model}, ${x.uses} uses, revenue ${x.revenue.display}, ${x.endpoint}`).join("\n") || "Nothing on sale.");
    },
  );

  server.registerTool(
    "purser_invoice",
    { title: "Invoice another agent", description: "Send an invoice; the payer funds an escrow and the money is released on delivery.", inputSchema: { payer: z.string(), amount: z.string().describe("USDG"), description: z.string(), due_in_hours: z.number().default(72) } },
    async (a) => {
      const inv = await purser.invoices.create({ payer: a.payer, amount: parseUnits(a.amount, 6), description: a.description, dueInSeconds: Math.round(a.due_in_hours * 3600) });
      return text(`Invoice ${inv.id} for ${inv.money.display} sent to ${inv.payer}.`);
    },
  );

  server.registerTool(
    "purser_pay_invoice",
    { title: "Pay an invoice", description: "Fund the escrow for an invoice addressed to this account.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const r = await purser.invoices.pay(id);
      return text(payText(r));
    },
  );

  server.registerTool(
    "purser_pnl",
    { title: "Profit and loss", description: "Income, spending, fees and profit over the last 30 days, with the biggest costs and customers." },
    async () => {
      const p = await purser.accounts.pnl((await me()).safe);
      return text(
        [`Income $${p.incomeUsd}, spend $${p.spendUsd}, fees $${p.feesUsd}, profit $${p.profitUsd}`, ...p.byModel.slice(0, 5).map((l) => `Model ${l.label}: $${l.spend}`), ...p.byCustomer.slice(0, 5).map((l) => `Customer ${l.label}: $${l.income}`)].join("\n"),
      );
    },
  );
  return server;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("purser-mcp") || process.argv[1]?.endsWith("/src/index.ts") || process.argv[1]?.endsWith("/dist/index.js");
if (isMain) {
  const baseUrl = process.env.PURSER_ENGINE_URL ?? "http://localhost:8787";
  const apiKey = process.env.PURSER_API_KEY;
  if (!apiKey) {
    process.stderr.write("PURSER_API_KEY is not set.\n");
    process.exit(1);
  }
  const server = createServer(new Purser({ baseUrl, apiKey }));
  await server.connect(new StdioServerTransport());
}
