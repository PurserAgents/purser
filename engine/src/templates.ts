import type { Address } from "viem";
import type { AccountConfig, AgentKind, Template } from "../../packages/sdk/src/schema.ts";
import type { SetupInput } from "./accounts.ts";
import { requireDep, type Ctx } from "./ctx.ts";
import { fail, ZERO } from "./util.ts";

const u = (dollars: number) => String(Math.round(dollars * 1_000_000)); // USDG base units

/** One-click rule sets per kind of agent. Amounts are USDG base units (6 decimals). */
export const TEMPLATES: Template[] = [
  {
    id: "research",
    name: "Research assistant",
    kind: "research",
    description: "Reads, searches and summarises. Pays for models and x402 data services in small amounts.",
    highlights: ["$25 a day", "$5 per payment at most", "Approval above $5", "Firewall and watchdog on"],
    config: { maxPerMinute: 20, hoursUtc: [], weekdays: [], payeeAllowlist: false, serviceAllowlist: false, useFirewall: true, useWatchdog: true },
    rules: { maxSingle: u(5), daily: u(25), weekly: u(120), perCounterpartyDaily: u(15), approvalAbove: u(5), cosignAbove: null, keepLiquid: "0" },
    alerts: [{ kind: "payment_blocked", threshold: null }, { kind: "spend_over", threshold: u(20) }],
  },
  {
    id: "trading",
    name: "Trading agent",
    kind: "trading",
    description: "Swaps on allowlisted routers only. Larger amounts need a second signer and the owner's approval.",
    highlights: ["Allowlisted routers only", "Co-sign above $500", "Approval above $1,000", "Weekdays only"],
    config: { maxPerMinute: 10, hoursUtc: [], weekdays: [0, 1, 2, 3, 4], payeeAllowlist: true, serviceAllowlist: false, useFirewall: true, useWatchdog: true },
    rules: { maxSingle: u(2_500), daily: u(10_000), weekly: u(40_000), perCounterpartyDaily: u(10_000), approvalAbove: u(1_000), cosignAbove: u(500), keepLiquid: u(100) },
    alerts: [{ kind: "payment_blocked", threshold: null }, { kind: "frozen", threshold: null }, { kind: "balance_under", threshold: u(200) }],
  },
  {
    id: "support",
    name: "Customer support",
    kind: "support",
    description: "Answers customers around the clock. Pays model costs, issues small refunds, never large transfers.",
    highlights: ["$50 a day", "Refunds up to $20", "Approval above $20", "Firewall on"],
    config: { maxPerMinute: 30, hoursUtc: [], weekdays: [], payeeAllowlist: false, serviceAllowlist: false, useFirewall: true, useWatchdog: true },
    rules: { maxSingle: u(20), daily: u(50), weekly: u(300), perCounterpartyDaily: u(20), approvalAbove: u(20), cosignAbove: null, keepLiquid: "0" },
    alerts: [{ kind: "payment_blocked", threshold: null }, { kind: "approval_needed", threshold: null }],
  },
  {
    id: "coding",
    name: "Coding agent",
    kind: "coding",
    description: "Writes and runs code. Heavy model use during working hours, nothing at night.",
    highlights: ["$100 a day", "08:00 to 20:00 UTC", "Model services only", "Approval above $25"],
    config: { maxPerMinute: 60, hoursUtc: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19], weekdays: [], payeeAllowlist: false, serviceAllowlist: false, useFirewall: true, useWatchdog: true },
    rules: { maxSingle: u(25), daily: u(100), weekly: u(500), perCounterpartyDaily: u(100), approvalAbove: u(25), cosignAbove: null, keepLiquid: "0" },
    alerts: [{ kind: "spend_over", threshold: u(80) }],
  },
  {
    id: "seller",
    name: "Agent that sells",
    kind: "seller",
    description: "Sells its work over x402 and keeps most of what it earns. Spending stays small.",
    highlights: ["Earns over x402", "Splits on arrival", "$20 a day spending", "Income alerts"],
    config: { maxPerMinute: 20, hoursUtc: [], weekdays: [], payeeAllowlist: false, serviceAllowlist: false, useFirewall: true, useWatchdog: true },
    rules: { maxSingle: u(10), daily: u(20), weekly: u(100), perCounterpartyDaily: u(10), approvalAbove: u(10), cosignAbove: null, keepLiquid: "0" },
    alerts: [{ kind: "income", threshold: u(1) }, { kind: "payment_blocked", threshold: null }],
  },
  {
    id: "ops",
    name: "Operations",
    kind: "ops",
    description: "Pays known suppliers on a schedule: subscriptions, streams and invoices to allowlisted payees.",
    highlights: ["Allowlisted payees only", "$500 a day", "Approval above $250", "Invoices with escrow"],
    config: { maxPerMinute: 10, hoursUtc: [], weekdays: [], payeeAllowlist: true, serviceAllowlist: false, useFirewall: true, useWatchdog: true },
    rules: { maxSingle: u(500), daily: u(500), weekly: u(2_500), perCounterpartyDaily: u(500), approvalAbove: u(250), cosignAbove: null, keepLiquid: u(50) },
    alerts: [{ kind: "approval_needed", threshold: null }, { kind: "balance_under", threshold: u(100) }],
  },
  {
    id: "custom",
    name: "Start from scratch",
    kind: "custom",
    description: "Careful defaults you can change: small budget, approval on anything over $10.",
    highlights: ["$10 a day", "Approval above $10", "Firewall and watchdog on"],
    config: { maxPerMinute: 10, hoursUtc: [], weekdays: [], payeeAllowlist: false, serviceAllowlist: false, useFirewall: true, useWatchdog: true },
    rules: { maxSingle: u(10), daily: u(10), weekly: u(50), perCounterpartyDaily: u(10), approvalAbove: u(10), cosignAbove: null, keepLiquid: "0" },
    alerts: [{ kind: "payment_blocked", threshold: null }],
  },
];

export function getTemplate(tid: string): Template {
  return TEMPLATES.find((t) => t.id === tid) ?? fail(404, "not_found", `No template "${tid}".`);
}

/** Turns a template into the factory setup for a new account. ETH gets a small fixed budget. */
export function setupFromTemplate(
  ctx: Ctx,
  tid: string,
  opts: { agent: Address; cosigner?: Address | null; agentURI?: string; allow?: Address[] },
): SetupInput {
  const dep = requireDep(ctx);
  const t = getTemplate(tid);
  const config: AccountConfig = {
    agent: opts.agent,
    cosigner: opts.cosigner ?? null,
    firewall: t.config.useFirewall ? (ctx.chain.accounts.firewall?.address ?? null) : null,
    watchdog: t.config.useWatchdog ? (ctx.chain.accounts.watchdog?.address ?? null) : null,
    maxPerMinute: t.config.maxPerMinute,
    hoursUtc: t.config.hoursUtc,
    weekdays: t.config.weekdays,
    payeeAllowlist: t.config.payeeAllowlist,
    serviceAllowlist: t.config.serviceAllowlist,
  };
  const eth = (wei: bigint) => wei.toString();
  return {
    config,
    rules: [
      { token: dep.usdg, rule: { ...t.rules, enabled: true, receivable: true } },
      {
        token: ZERO,
        rule: { enabled: true, receivable: true, maxSingle: eth(10n ** 16n), daily: eth(5n * 10n ** 16n), weekly: eth(2n * 10n ** 17n), perCounterpartyDaily: eth(5n * 10n ** 16n), approvalAbove: eth(10n ** 16n), cosignAbove: null, keepLiquid: "0" },
      },
    ],
    allow: [dep.escrow, ...(dep.swapRouter && t.kind === "trading" ? [dep.swapRouter] : []), ...(opts.allow ?? [])],
    extensions: [dep.recurring],
    agentURI: opts.agentURI,
  };
}

export const templateKinds = TEMPLATES.map((t) => t.kind) as AgentKind[];
