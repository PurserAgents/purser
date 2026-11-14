/**
 * Purser engine API schema. These types describe every JSON body the engine returns (docs/API.md).
 * The website mirrors this file; keep it free of runtime dependencies.
 *
 * Conventions:
 * - Amounts are strings in base units (wei / token units). `display` fields are human-readable strings.
 * - Addresses are lowercase 0x strings. Compare them case-insensitively.
 * - Times are unix seconds (numbers) unless the field name ends with `Iso`.
 * - A limit of `null` means "no cap"; a threshold of `null` means "never".
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type Amount = string;

export interface TokenInfo {
  address: Address; // 0x000...0 for ETH
  symbol: string;
  decimals: number;
}

export interface Money {
  token: TokenInfo;
  amount: Amount;
  display: string; // e.g. "12.50 USDG"
  usd: string | null; // e.g. "12.50" when a price is known
}

// ---------------------------------------------------------------------------------------------------- accounts

export interface TokenRule {
  token: TokenInfo;
  enabled: boolean;
  receivable: boolean;
  maxSingle: Amount | null;
  daily: Amount | null;
  weekly: Amount | null;
  perCounterpartyDaily: Amount | null;
  approvalAbove: Amount | null;
  cosignAbove: Amount | null;
  keepLiquid: Amount;
}

export interface AccountConfig {
  agent: Address;
  cosigner: Address | null;
  firewall: Address | null;
  watchdog: Address | null;
  maxPerMinute: number | null;
  hoursUtc: number[]; // allowed UTC hours, [] = any time
  weekdays: number[]; // 0 = Monday ... 6 = Sunday, [] = any day
  payeeAllowlist: boolean;
  serviceAllowlist: boolean;
}

export type AgentKind =
  | "research"
  | "trading"
  | "support"
  | "coding"
  | "content"
  | "ops"
  | "seller"
  | "custom";

export interface SpendToday {
  token: TokenInfo;
  spent: Amount;
  remaining: Amount | null;
  display: string;
}

export interface AccountSummary {
  safe: Address;
  name: string;
  kind: AgentKind;
  owners: Address[];
  frozen: boolean;
  public: boolean;
  agentId: string | null;
  balanceUsd: string | null;
  spentTodayUsd: string;
  earnedTodayUsd: string;
  receiptsToday: number;
  pendingApprovals: number;
  teamId: string | null;
  createdAt: number;
}

export interface Account extends AccountSummary {
  threshold: number;
  config: AccountConfig;
  rules: TokenRule[];
  balances: Money[];
  spentToday: SpendToday[];
  allowlist: Address[];
  services: Hex[];
  treasuryVaults: Address[];
  splits: Split[];
  extensions: Address[];
  approver: Address | null;
  guardian: { address: Address; delaySeconds: number } | null;
  recovery: { executeAfter: number } | null;
}

// ---------------------------------------------------------------------------------------------------- payments

export type ReceiptCategory =
  | "model"
  | "x402"
  | "onchain"
  | "swap"
  | "stream"
  | "subscription"
  | "escrow"
  | "split"
  | "internal"
  | "storefront"
  | "transfer"
  | "treasury";

export type IntentStatus =
  | "blocked" // the firewall or the rules refused; never sent
  | "needs_cosign"
  | "queued" // waiting for the owner's approval
  | "held" // Purser Shield matched and the account is set to warn: waits for the owner to release or reject
  | "approved"
  | "rejected"
  | "submitted"
  | "executed"
  | "failed"
  | "ready"; // signed, but this engine does not broadcast (no local node)

export interface Receipt {
  id: string;
  safe: Address;
  direction: "out" | "in";
  category: ReceiptCategory;
  money: Money;
  fee: Money | null;
  counterparty: Address;
  counterpartyName: string | null;
  service: string | null;
  memo: string | null;
  status: IntentStatus;
  txHash: Hex | null;
  intentId: string | null;
  verdictId: string | null;
  taskId: string | null;
  customer: string | null;
  model: ModelUsage | null;
  createdAt: number;
}

export interface ModelUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface Intent {
  id: string;
  safe: Address;
  kind: "pay" | "call" | "treasury" | "stream" | "subscription" | "escrow";
  digest: Hex;
  status: IntentStatus;
  summary: string;
  money: Money | null;
  to: Address | null;
  verdictId: string | null;
  txHash: Hex | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PayResult {
  intent: Intent;
  verdict: Verdict;
  receipt: Receipt | null;
}

// ---------------------------------------------------------------------------------------------------- approvals

export interface PendingApproval {
  id: string; // intent id
  safe: Address;
  digest: Hex; // what the owner approves; the passkey challenge
  rejectChallenge: Hex; // what a passkey signs to reject
  summary: string;
  money: Money | null;
  to: Address | null;
  status: "queued" | "approved" | "rejected";
  createdAt: number;
}

// ---------------------------------------------------------------------------------------------------- firewall

export type VerdictDecision = "allow" | "block";

export interface VerdictReason {
  code: string; // machine code, e.g. "drain", "injection", "unknown_contract"
  severity: "info" | "warn" | "block";
  title: string; // one line in plain words
  detail: string; // a sentence or two in plain words
}

export interface AssetChange {
  token: TokenInfo;
  from: Address;
  to: Address;
  amount: Amount;
  display: string;
}

export interface SimulationSummary {
  backend: "eth_simulateV1" | "debug_traceCall" | "none";
  success: boolean;
  revertReason: string | null;
  gasUsed: string;
  assetChanges: AssetChange[];
  approvals: { token: Address; owner: Address; spender: Address; amount: Amount }[];
  calls: { from: Address; to: Address; selector: Hex | null; value: Amount }[];
  balanceBefore: Money[];
  balanceAfter: Money[];
}

export interface Verdict {
  id: string;
  safe: Address;
  intentId: string | null;
  decision: VerdictDecision;
  summary: string; // one sentence for the owner
  reasons: VerdictReason[];
  simulation: SimulationSummary | null;
  trigger: string | null; // the request text that led to the payment, when the agent sent it
  createdAt: number;
}

// ---------------------------------------------------------------------------------------------------- watchdog

export interface WatchdogBaseline {
  safe: Address;
  samples: number;
  hourlyMeanUsd: string;
  hourlyStdUsd: string;
  knownCounterparties: number;
  autoFreeze: boolean;
  updatedAt: number;
}

export interface WatchdogEvent {
  id: string;
  safe: Address;
  kind: "spike" | "new_counterparty" | "loop" | "burst" | "drain" | "shield";
  severity: "warn" | "critical";
  title: string;
  detail: string;
  action: "alert" | "freeze";
  txHash: Hex | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------------------------------- audit

export interface AuditEntry {
  seq: number;
  ts: number;
  actor: string; // "engine", "agent:<safe>", "owner:<address>", "watchdog", "firewall"
  action: string;
  safe: Address | null;
  data: Record<string, unknown>;
  prevHash: Hex;
  hash: Hex;
  signature: Hex;
}

export interface AuditVerifyResult {
  ok: boolean;
  entries: number;
  signer: Address;
  brokenAt: number | null;
  problem: string | null;
}

// ---------------------------------------------------------------------------------------------------- streams and subscriptions

export interface Stream {
  id: string;
  safe: Address;
  payee: Address;
  token: TokenInfo;
  ratePerSecond: Amount;
  start: number;
  end: number;
  settledUntil: number;
  lastBeat: number;
  grace: number;
  status: "active" | "stalled" | "stopped" | "ended";
  accrued: Money;
  paid: Money;
}

export interface Subscription {
  id: string;
  safe: Address;
  payee: Address;
  token: TokenInfo;
  amount: Money;
  periodSeconds: number;
  nextDue: number;
  chargesLeft: number;
  active: boolean;
  charged: number;
}

// ---------------------------------------------------------------------------------------------------- money in

export interface StoreService {
  id: string;
  safe: Address;
  name: string;
  description: string;
  pricing: {
    model: "per_call" | "per_minute" | "subscription";
    price: Money;
    periodSeconds: number | null;
  };
  endpoint: string; // the paywalled URL buyers call
  uses: number;
  revenue: Money;
  active: boolean;
  createdAt: number;
}

export interface Split {
  to: Address;
  bps: number;
  label: string | null;
}

export type InvoiceStatus =
  | "open"
  | "funded"
  | "delivered"
  | "disputed"
  | "released"
  | "refunded"
  | "resolved";

export interface Invoice {
  id: string;
  payee: Address;
  payer: Address;
  arbiter: Address | null;
  money: Money;
  description: string;
  deadline: number;
  reviewPeriodSeconds: number;
  reviewUntil: number | null;
  status: InvoiceStatus;
  jobId: string | null;
  deliveryHash: Hex | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------------------------------- treasury and teams

export interface TreasuryVault {
  address: Address;
  name: string;
  asset: TokenInfo;
  totalAssets: Money;
  kind: "erc4626";
}

export interface TreasuryPosition {
  vault: TreasuryVault;
  shares: Amount;
  assets: Money;
}

export interface Treasury {
  safe: Address;
  liquid: Money[];
  positions: TreasuryPosition[];
  allowedVaults: Address[];
  keepLiquid: { token: TokenInfo; amount: Amount }[];
}

export interface Department {
  id: string;
  name: string;
  dailyBudget: Money | null;
  spentToday: Money;
}

export interface TeamMember {
  safe: Address;
  name: string;
  departmentId: string | null;
  role: string;
  dailyBudget: Money | null;
  spentToday: Money;
}

export interface Team {
  id: string;
  name: string;
  treasury: Address;
  owner: Address;
  departments: Department[];
  members: TeamMember[];
  createdAt: number;
}

export interface OrgChartNode {
  id: string;
  label: string;
  kind: "team" | "department" | "agent";
  safe: Address | null;
  children: OrgChartNode[];
}

// ---------------------------------------------------------------------------------------------------- accounting

export interface PnlLine {
  key: string;
  label: string;
  income: string; // USD
  spend: string; // USD
  count: number;
}

export interface Pnl {
  scope: { safe: Address | null; teamId: string | null };
  from: number;
  to: number;
  incomeUsd: string;
  spendUsd: string;
  feesUsd: string;
  profitUsd: string;
  byCategory: PnlLine[];
  byModel: PnlLine[];
  byTask: PnlLine[];
  byCustomer: PnlLine[];
  byDay: { day: string; incomeUsd: string; spendUsd: string }[];
}

// ---------------------------------------------------------------------------------------------------- network

export interface DirectoryEntry {
  id: string;
  name: string;
  url: string;
  payTo: Address;
  source: "storefront" | "x402";
  price: Money | null;
  uses: number;
  payers: number;
  deliveryRate: number | null; // 0..1
  refunds: number;
  lastUsed: number | null;
}

export interface PriceIndexPoint {
  category: string; // e.g. "chat-1k-tokens"
  unit: string;
  priceUsd: string;
  samples: number;
  change24h: number | null; // fraction, e.g. -0.04
}

export interface Economy {
  totals: {
    spendUsd: string;
    earnUsd: string;
    payments: number;
    agents: number;
    services: number;
    blocked: number;
  };
  last24h: { spendUsd: string; earnUsd: string; payments: number };
  topServices: DirectoryEntry[];
  priceIndex: PriceIndexPoint[];
  series: { t: number; spendUsd: string; earnUsd: string }[];
}

export interface LeaderboardEntry {
  rank: number;
  safe: Address;
  name: string;
  kind: AgentKind;
  earnedUsd: string;
  spentUsd: string;
  profitUsd: string;
  payments: number;
}

export interface PublicAgent {
  safe: Address;
  name: string;
  kind: AgentKind;
  agentId: string | null;
  earnedUsd: string;
  spentUsd: string;
  profitUsd: string;
  receipts: Receipt[];
  rules: TokenRule[];
  services: StoreService[];
  createdAt: number;
}

// ---------------------------------------------------------------------------------------------------- templates, webhooks, keys

export interface Template {
  id: string;
  name: string;
  kind: AgentKind;
  description: string;
  highlights: string[];
  config: Omit<AccountConfig, "agent" | "cosigner" | "firewall" | "watchdog"> & {
    useFirewall: boolean;
    useWatchdog: boolean;
  };
  rules: Omit<TokenRule, "token" | "enabled" | "receivable">;
  alerts: { kind: AlertKind; threshold: string | null }[];
}

export type AlertKind =
  | "payment_blocked"
  | "approval_needed"
  | "frozen"
  | "spend_over"
  | "balance_under"
  | "income";

export type WebhookEventType =
  | "receipt.created"
  | "intent.blocked"
  | "intent.queued"
  | "intent.executed"
  | "approval.decided"
  | "watchdog.alert"
  | "account.frozen"
  | "account.unfrozen"
  | "invoice.updated"
  | "stream.updated"
  | "alert";

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEventType[];
  safe: Address | null;
  active: boolean;
  createdAt: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: WebhookEventType;
  status: "delivered" | "failed" | "pending";
  attempts: number;
  responseCode: number | null;
  createdAt: number;
}

export interface Alert {
  id: string;
  safe: Address;
  kind: AlertKind;
  threshold: string | null;
  createdAt: number;
}

export interface ApiKey {
  id: string;
  safe: Address;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  sessionAddress: Address | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export type ApiScope = "pay" | "models" | "x402" | "call" | "sell" | "read" | "treasury" | "recurring" | "invoices";

// ---------------------------------------------------------------------------------------------------- transactions to sign

export interface PreparedTx {
  chainId: number;
  to: Address;
  data: Hex;
  value: Amount;
  description: string;
}

export interface PreparedSafeTx {
  chainId: number;
  safe: Address;
  to: Address;
  value: Amount;
  data: Hex;
  operation: 0 | 1;
  nonce: string;
  safeTxHash: Hex;
  typedData: unknown; // EIP-712 SafeTx, for eth_signTypedData_v4
  description: string;
}

// ---------------------------------------------------------------------------------------------------- envelope

export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface Health {
  ok: boolean;
  mode: "local" | "fork" | "readonly" | "live";
  chainId: number;
  block: string | null;
  broadcast: boolean;
  contracts: Record<string, Address | null>;
  version: string;
}

export type EngineEventType =
  | "receipt"
  | "intent"
  | "verdict"
  | "approval"
  | "watchdog"
  | "account"
  | "stream"
  | "subscription"
  | "invoice"
  | "audit"
  | "alert"
  | "demo";

export interface EngineEvent<T = unknown> {
  id: number;
  type: EngineEventType;
  safe: Address | null;
  ts: number;
  data: T;
}

export interface DemoStep {
  step: number;
  title: string;
  detail: string;
  status: "running" | "ok" | "blocked" | "error";
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------------- Purser Shield

/** What a Shield match does on an account: refuse the payment, or hold it for the owner. */
export type ShieldMode = "block" | "warn";

/** An attacker address on the shared list. Only the attacker's side: never who was attacked or what they hold. */
export interface ShieldThreat {
  address: Address;
  kind: "planted_payee" | "forwarding_wallet" | "forwarding_code" | "spender";
  what: string;
  attacks: number;
  /** how many accounts it was aimed at, never which */
  accounts: number;
  /** payments to it the Shield stopped on other accounts */
  stoppedElsewhere: number;
  firstSeen: number;
  lastSeen: number;
}

/** A one-way fingerprint of a sentence of injected instructions. The sentence itself is not shared. */
export interface ShieldPrint {
  print: string;
  why: string;
  attacks: number;
  accounts: number;
  stoppedElsewhere: number;
  firstSeen: number;
  lastSeen: number;
}

export interface ShieldStats {
  addresses: number;
  prints: number;
  attacksCaught: number;
  stoppedByShield: number;
  accountsProtected: number;
  lastFlaggedAt: number | null;
}
