/** Words for engine codes, in one place. */
import type { AgentKind, AlertKind, IntentStatus, InvoiceStatus, ReceiptCategory, WebhookEventType } from "./types";

export const categoryLabel: Record<ReceiptCategory, string> = {
  model: "Model",
  x402: "x402 service",
  onchain: "On-chain app",
  swap: "Swap",
  stream: "Stream",
  subscription: "Subscription",
  escrow: "Escrow",
  split: "Split",
  internal: "Internal",
  storefront: "Storefront sale",
  transfer: "Transfer",
  treasury: "Treasury",
};

export const kindLabel: Record<AgentKind, string> = {
  research: "Research agent",
  trading: "Trading agent",
  support: "Support agent",
  coding: "Coding agent",
  content: "Content agent",
  ops: "Operations agent",
  seller: "Seller agent",
  custom: "Custom agent",
};

export const statusLabel: Record<IntentStatus, string> = {
  blocked: "Blocked",
  needs_cosign: "Needs co-sign",
  queued: "Needs approval",
  approved: "Approved",
  rejected: "Rejected",
  submitted: "Sent",
  executed: "Paid",
  failed: "Failed",
  ready: "Signed",
};

export const invoiceStatusLabel: Record<InvoiceStatus, string> = {
  open: "Open",
  funded: "Funded, in escrow",
  delivered: "Delivered, in review",
  disputed: "Disputed",
  released: "Paid out",
  refunded: "Refunded",
  resolved: "Resolved",
};

export const alertLabel: Record<AlertKind, { title: string; text: string; amount: boolean }> = {
  payment_blocked: { title: "A payment was blocked", text: "The rules or the firewall refused a payment.", amount: false },
  approval_needed: { title: "A payment needs approval", text: "A payment is waiting above the approval amount.", amount: false },
  frozen: { title: "The agent was frozen", text: "By you or by the watchdog.", amount: false },
  spend_over: { title: "Spending today is over", text: "Total spent today passes this amount (USDG).", amount: true },
  balance_under: { title: "Balance is under", text: "The USDG balance falls below this amount.", amount: true },
  income: { title: "Money came in", text: "A payment arrived at the account.", amount: false },
};

export const webhookEventLabel: Record<WebhookEventType, string> = {
  "receipt.created": "Every receipt",
  "intent.blocked": "Payment blocked",
  "intent.queued": "Payment queued for approval",
  "intent.executed": "Payment sent",
  "approval.decided": "Approval decided",
  "watchdog.alert": "Watchdog event",
  "account.frozen": "Account frozen",
  "account.unfrozen": "Account unfrozen",
  "invoice.updated": "Invoice changed",
  "stream.updated": "Stream changed",
  alert: "Alerts",
};

export const roleLabel: Record<string, string> = {
  owner: "Owner",
  developer: "Developer",
  model_provider: "Model provider",
  coworker: "Co-worker agent",
  other: "Other",
};

export const pricingLabel = { per_call: "per call", per_minute: "per minute", subscription: "per period" } as const;
