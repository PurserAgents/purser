import { encodeFunctionData, encodePacked, hashTypedData, size, type Address, type Hex } from "viem";
import { erc20Abi, purserFactoryAbi, purserModuleAbi, safeAbi } from "../../packages/sdk/src/abi.ts";
import { chainAddresses } from "../../packages/sdk/src/chain.ts";
import type {
  Account,
  AccountConfig,
  AccountSummary,
  AgentKind,
  PreparedSafeTx,
  PreparedTx,
  TokenRule,
} from "../../packages/sdk/src/schema.ts";
import { requireDep, type Ctx } from "./ctx.ts";
import { ETH_INFO } from "./tokens.ts";
import { fail, fmt, lower, MAX_U128, now, parseJson, sameAddress, usd, ZERO } from "./util.ts";

// ---------------------------------------------------------------------------------------------------- encoding

export interface ChainConfig {
  agent: Address;
  cosigner: Address;
  firewall: Address;
  watchdog: Address;
  maxPerMinute: number;
  hoursMask: number;
  daysMask: number;
  payeeAllowlist: boolean;
  serviceAllowlist: boolean;
}

export interface ChainRule {
  enabled: boolean;
  receivable: boolean;
  maxSingle: bigint;
  daily: bigint;
  weekly: bigint;
  perCounterpartyDaily: bigint;
  approvalAbove: bigint;
  cosignAbove: bigint;
  keepLiquid: bigint;
}

const cap = (v: string | null | undefined) => (v === null || v === undefined ? MAX_U128 : BigInt(v));
const uncap = (v: bigint) => (v >= MAX_U128 ? null : v.toString());

export function maskFrom(list: number[]): number {
  return list.reduce((m, i) => m | (1 << i), 0);
}
export function listFrom(mask: number, bits: number): number[] {
  if (!mask) return [];
  return Array.from({ length: bits }, (_, i) => i).filter((i) => (mask >> i) & 1);
}

export function configToChain(c: AccountConfig): ChainConfig {
  return {
    agent: c.agent,
    cosigner: c.cosigner ?? ZERO,
    firewall: c.firewall ?? ZERO,
    watchdog: c.watchdog ?? ZERO,
    maxPerMinute: c.maxPerMinute ?? 0,
    hoursMask: maskFrom(c.hoursUtc),
    daysMask: maskFrom(c.weekdays),
    payeeAllowlist: c.payeeAllowlist,
    serviceAllowlist: c.serviceAllowlist,
  };
}

export function configFromChain(c: ChainConfig): AccountConfig {
  const z = (a: Address) => (sameAddress(a, ZERO) ? null : lower(a));
  return {
    agent: lower(c.agent),
    cosigner: z(c.cosigner),
    firewall: z(c.firewall),
    watchdog: z(c.watchdog),
    maxPerMinute: c.maxPerMinute || null,
    hoursUtc: listFrom(c.hoursMask, 24),
    weekdays: listFrom(c.daysMask, 7),
    payeeAllowlist: c.payeeAllowlist,
    serviceAllowlist: c.serviceAllowlist,
  };
}

export type RuleInput = Partial<Omit<TokenRule, "token">>;

export function ruleToChain(r: RuleInput): ChainRule {
  return {
    enabled: r.enabled ?? true,
    receivable: r.receivable ?? true,
    maxSingle: cap(r.maxSingle),
    daily: cap(r.daily),
    weekly: cap(r.weekly),
    perCounterpartyDaily: cap(r.perCounterpartyDaily),
    approvalAbove: cap(r.approvalAbove),
    cosignAbove: cap(r.cosignAbove),
    keepLiquid: BigInt(r.keepLiquid ?? "0"),
  };
}

export function ruleFromChain(ctx: Ctx, token: string, r: ChainRule): TokenRule {
  return {
    token: ctx.tokens.infoSync(token),
    enabled: r.enabled,
    receivable: r.receivable,
    maxSingle: uncap(r.maxSingle),
    daily: uncap(r.daily),
    weekly: uncap(r.weekly),
    perCounterpartyDaily: uncap(r.perCounterpartyDaily),
    approvalAbove: uncap(r.approvalAbove),
    cosignAbove: uncap(r.cosignAbove),
    keepLiquid: r.keepLiquid.toString(),
  };
}

// ---------------------------------------------------------------------------------------------------- reads

interface AccountRow {
  safe: string;
  name: string;
  kind: AgentKind;
  owners: string;
  agent: string | null;
  agent_id: string | null;
  public: number;
  template: string | null;
  team_id: string | null;
  department_id: string | null;
  role: string | null;
  auto_freeze: number;
  created_at: number;
}

export function accountRow(ctx: Ctx, safe: string): AccountRow | undefined {
  return ctx.db.prepare("SELECT * FROM accounts WHERE safe = ?").get(lower(safe)) as AccountRow | undefined;
}

export async function readChainAccount(ctx: Ctx, safe: Address) {
  const dep = requireDep(ctx);
  const acct = await ctx.chain.pub.readContract({
    address: dep.module,
    abi: purserModuleAbi,
    functionName: "getAccount",
    args: [safe],
  });
  return acct;
}

export async function readRule(ctx: Ctx, safe: Address, token: Address): Promise<ChainRule> {
  const dep = requireDep(ctx);
  return (await ctx.chain.pub.readContract({
    address: dep.module,
    abi: purserModuleAbi,
    functionName: "getTokenRule",
    args: [safe, token],
  })) as ChainRule;
}

export async function balanceOf(ctx: Ctx, token: Address, who: Address): Promise<bigint> {
  if (sameAddress(token, ZERO)) return ctx.chain.pub.getBalance({ address: who });
  return ctx.chain.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
}

export function setsOf(ctx: Ctx, safe: string, kind: string): string[] {
  return (
    ctx.db.prepare("SELECT value FROM account_sets WHERE safe = ? AND kind = ? AND on_flag = 1").all(lower(safe), kind) as {
      value: string;
    }[]
  ).map((r) => r.value);
}

export async function readAccount(ctx: Ctx, safeIn: string): Promise<Account> {
  const dep = requireDep(ctx);
  const safe = lower(safeIn);
  const a = await readChainAccount(ctx, safe);
  if (!a.initialized) fail(404, "not_found", "No Purser account at this address.");
  const [owners, threshold, tokens, splits, recovery] = await Promise.all([
    ctx.chain.pub.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
    ctx.chain.pub.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
    ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "getTokens", args: [safe] }),
    ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "getSplits", args: [safe] }),
    ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "recovery", args: [safe] }),
  ]);
  const tokenList = [ZERO as Address, ...tokens.map(lower)];
  for (const t of tokenList) await ctx.tokens.info(t);
  const day = BigInt(Math.floor(now() / 86400));
  const rules = await Promise.all(tokenList.map((t) => readRule(ctx, safe, t)));
  const balances = await Promise.all(tokenList.map((t) => balanceOf(ctx, t, safe)));
  const spent = await Promise.all(
    tokenList.map((t) =>
      ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "spentOnDay", args: [safe, t, day] }),
    ),
  );
  const remaining = await Promise.all(
    tokenList.map((t) =>
      ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "remainingToday", args: [safe, t] }),
    ),
  );
  const row = accountRow(ctx, safe);
  const summary = summarize(ctx, safe, row, owners.map(lower), a.frozen, a.agentId);
  const balanceMoney = tokenList.map((t, i) => ctx.tokens.money(t, balances[i]));
  const usdTotal = balanceMoney.reduce((s, m) => (m.usd === null ? s : s + Number(m.usd)), 0);
  return {
    ...summary,
    balanceUsd: usdTotal.toFixed(2),
    threshold: Number(threshold),
    config: configFromChain(a.config as ChainConfig),
    rules: tokenList.map((t, i) => ruleFromChain(ctx, t, rules[i])),
    balances: balanceMoney,
    spentToday: tokenList.map((t, i) => {
      const info = ctx.tokens.infoSync(t);
      const enabled = rules[i].enabled;
      return {
        token: info,
        spent: spent[i].toString(),
        remaining: enabled ? remaining[i].toString() : "0",
        display: `${fmt(spent[i], info.decimals)} ${info.symbol}`,
      };
    }),
    allowlist: setsOf(ctx, safe, "allow") as Address[],
    services: setsOf(ctx, safe, "service") as Hex[],
    treasuryVaults: setsOf(ctx, safe, "vault") as Address[],
    extensions: setsOf(ctx, safe, "extension") as Address[],
    splits: splits.map((s) => ({ to: lower(s.to), bps: s.bps, label: splitLabel(ctx, safe, s.to) })),
    approver: sameAddress(a.approver, ZERO) ? null : lower(a.approver),
    guardian: sameAddress(a.guardian, ZERO) ? null : { address: lower(a.guardian), delaySeconds: Number(a.recoveryDelay) },
    recovery: recovery[1] > 0n ? { executeAfter: Number(recovery[1]) } : null,
  };
}

function splitLabel(ctx: Ctx, safe: string, to: string): string | null {
  const r = ctx.db.prepare("SELECT label FROM split_labels WHERE safe = ? AND address = ?").get(lower(safe), lower(to)) as
    | { label: string }
    | undefined;
  return r?.label ? r.label.split("|")[0] || null : null;
}

function summarize(
  ctx: Ctx,
  safe: Address,
  row: AccountRow | undefined,
  owners: Address[],
  frozen: boolean,
  agentId: bigint,
): AccountSummary {
  const dayStart = now() - (now() % 86400);
  const agg = ctx.db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN direction='out' AND status='executed' THEN CAST(usd_micro AS INTEGER) ELSE 0 END),0) AS spent,
        COALESCE(SUM(CASE WHEN direction='in' AND status='executed' THEN CAST(usd_micro AS INTEGER) ELSE 0 END),0) AS earned,
        COUNT(*) AS n
       FROM receipts WHERE safe = ? AND created_at >= ?`,
    )
    .get(safe, dayStart) as { spent: number; earned: number; n: number };
  const pending = ctx.db.prepare("SELECT COUNT(*) AS n FROM intents WHERE safe = ? AND status = 'queued'").get(safe) as {
    n: number;
  };
  return {
    safe,
    name: row?.name ?? `Agent ${safe.slice(2, 6)}`,
    kind: (row?.kind ?? "custom") as AgentKind,
    owners: owners.length ? owners : (parseJson<Address[]>(row?.owners, [])),
    frozen,
    public: !!row?.public,
    agentId: agentId > 0n ? agentId.toString() : (row?.agent_id ?? null),
    balanceUsd: null,
    spentTodayUsd: usd(BigInt(agg.spent)),
    earnedTodayUsd: usd(BigInt(agg.earned)),
    receiptsToday: agg.n,
    pendingApprovals: pending.n,
    teamId: row?.team_id ?? null,
    createdAt: row?.created_at ?? 0,
  };
}

export async function listAccounts(ctx: Ctx, opts: { owner?: string } = {}): Promise<AccountSummary[]> {
  const rows = ctx.db.prepare("SELECT * FROM accounts ORDER BY created_at DESC").all() as AccountRow[];
  const filtered = opts.owner
    ? rows.filter((r) => parseJson<string[]>(r.owners, []).some((o) => sameAddress(o, opts.owner)))
    : rows;
  const out: AccountSummary[] = [];
  for (const r of filtered) {
    let frozen = false;
    let agentId = 0n;
    try {
      const a = await readChainAccount(ctx, r.safe as Address);
      frozen = a.frozen;
      agentId = a.agentId;
    } catch {
      /* chain not reachable: show the stored row */
    }
    out.push(summarize(ctx, r.safe as Address, r, parseJson<Address[]>(r.owners, []), frozen, agentId));
  }
  return out;
}

export function upsertAccount(
  ctx: Ctx,
  a: { safe: string; name?: string; kind?: string; owners?: string[]; agent?: string; agentId?: string | null; public?: boolean; template?: string | null },
) {
  const safe = lower(a.safe);
  const existing = accountRow(ctx, safe);
  if (!existing) {
    ctx.db
      .prepare(
        "INSERT INTO accounts (safe, name, kind, owners, agent, agent_id, public, template, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        safe,
        a.name ?? `Agent ${safe.slice(2, 6)}`,
        a.kind ?? "custom",
        JSON.stringify((a.owners ?? []).map(lower)),
        a.agent ? lower(a.agent) : null,
        a.agentId ?? null,
        a.public ? 1 : 0,
        a.template ?? null,
        now(),
      );
  } else {
    ctx.db
      .prepare(
        `UPDATE accounts SET name = COALESCE(?, name), kind = COALESCE(?, kind), owners = COALESCE(?, owners),
         agent = COALESCE(?, agent), agent_id = COALESCE(?, agent_id), public = COALESCE(?, public), template = COALESCE(?, template)
         WHERE safe = ?`,
      )
      .run(
        a.name ?? null,
        a.kind ?? null,
        a.owners ? JSON.stringify(a.owners.map(lower)) : null,
        a.agent ? lower(a.agent) : null,
        a.agentId ?? null,
        a.public === undefined ? null : a.public ? 1 : 0,
        a.template ?? null,
        safe,
      );
  }
  return accountRow(ctx, safe)!;
}

// ---------------------------------------------------------------------------------------------------- prepare transactions

export interface SetupInput {
  config: AccountConfig;
  rules: { token: Address; rule: RuleInput }[];
  allow?: Address[];
  extensions?: Address[];
  agentURI?: string;
}

export function setupArg(ctx: Ctx, s: SetupInput) {
  const dep = requireDep(ctx);
  return {
    config: configToChain(s.config),
    rules: s.rules.map((r) => ({ token: r.token, rule: ruleToChain(r.rule) })),
    allow: s.allow ?? [],
    extensions: s.extensions ?? [dep.recurring],
    agentURI: s.agentURI ?? "",
  };
}

export async function prepareCreate(
  ctx: Ctx,
  input: { owners: Address[]; threshold?: number; setup: SetupInput; salt?: bigint; creator: Address },
): Promise<{ predictedSafe: Address; tx: PreparedTx }> {
  const dep = requireDep(ctx);
  const threshold = BigInt(input.threshold ?? 1);
  const salt = input.salt ?? BigInt(now());
  const setup = setupArg(ctx, input.setup);
  const predicted = await ctx.chain.pub.readContract({
    address: dep.factory,
    abi: purserFactoryAbi,
    functionName: "predictAddress",
    args: [input.owners, threshold, setup, input.creator, salt],
  });
  return {
    predictedSafe: lower(predicted),
    tx: {
      chainId: ctx.cfg.chainId,
      to: dep.factory,
      data: encodeFunctionData({ abi: purserFactoryAbi, functionName: "createAccount", args: [input.owners, threshold, setup, salt] }),
      value: "0",
      description: "Create the agent's Safe, enable the Purser module and write the first rules.",
    },
  };
}

/** Owner calls that a Safe owner wallet sends directly (no Safe transaction): freeze, approvals, recovery cancel. */
export function prepareModuleCall(
  ctx: Ctx,
  fn: "freeze" | "unfreeze" | "approveIntent" | "rejectIntent" | "cancelRecovery",
  args: readonly unknown[],
  description: string,
): PreparedTx {
  const dep = requireDep(ctx);
  return {
    chainId: ctx.cfg.chainId,
    to: dep.module,
    data: encodeFunctionData({ abi: purserModuleAbi, functionName: fn, args: args as never }),
    value: "0",
    description,
  };
}

export interface SafeCall {
  to: Address;
  value?: bigint;
  data: Hex;
}

/** Encodes one or more calls as a Safe transaction (several calls go through MultiSendCallOnly). */
export async function prepareSafeTx(
  ctx: Ctx,
  safeIn: string,
  calls: SafeCall[],
  description: string,
  opts: { operation?: 0 | 1 } = {},
): Promise<PreparedSafeTx> {
  const safe = lower(safeIn);
  let to: Address;
  let value = 0n;
  let data: Hex;
  let operation: 0 | 1 = opts.operation ?? 0;
  if (calls.length === 1) {
    ({ to, data } = calls[0]);
    value = calls[0].value ?? 0n;
  } else {
    const packed = calls.map((c) =>
      encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, c.value ?? 0n, BigInt(size(c.data)), c.data]),
    );
    to = chainAddresses.multiSendCallOnly;
    data = encodeFunctionData({
      abi: [{ type: "function", name: "multiSend", inputs: [{ name: "transactions", type: "bytes" }], outputs: [], stateMutability: "payable" }],
      functionName: "multiSend",
      args: [("0x" + packed.map((p) => p.slice(2)).join("")) as Hex],
    });
    operation = 1;
  }
  const nonce = await ctx.chain.pub.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  const typedData = {
    domain: { chainId: ctx.cfg.chainId, verifyingContract: safe },
    types: {
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx" as const,
    message: { to, value, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce },
  };
  return {
    chainId: ctx.cfg.chainId,
    safe,
    to: lower(to),
    value: value.toString(),
    data,
    operation,
    nonce: nonce.toString(),
    safeTxHash: hashTypedData(typedData),
    typedData: JSON.parse(JSON.stringify(typedData, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
    description,
  };
}

export function prepareAttach(ctx: Ctx, safe: string, setup: SetupInput) {
  const dep = requireDep(ctx);
  return prepareSafeTx(
    ctx,
    safe,
    [{ to: dep.factory, data: encodeFunctionData({ abi: purserFactoryAbi, functionName: "setupAccount", args: [setupArg(ctx, setup)] }) }],
    "Attach this Safe to Purser: enable the module, write the rules, register the agent identity.",
    { operation: 1 },
  );
}

/** Builds the module calls (as Safe calls) for a rule change. */
export function ruleChangeCalls(
  ctx: Ctx,
  change: {
    config?: AccountConfig;
    rules?: { token: Address; rule: RuleInput }[];
    allow?: Address[];
    disallow?: Address[];
    services?: Hex[];
    removeServices?: Hex[];
    vaults?: Address[];
    removeVaults?: Address[];
    splits?: { to: Address; bps: number }[];
    counterpartyLimits?: { token: Address; counterparty: Address; limit: string }[];
    approver?: Address | null;
    guardian?: { address: Address; delaySeconds: number } | null;
  },
): SafeCall[] {
  const dep = requireDep(ctx);
  const m = (fn: string, args: readonly unknown[]): SafeCall => ({
    to: dep.module,
    data: encodeFunctionData({ abi: purserModuleAbi, functionName: fn as never, args: args as never }),
  });
  const calls: SafeCall[] = [];
  if (change.config) calls.push(m("setConfig", [configToChain(change.config)]));
  for (const r of change.rules ?? []) calls.push(m("setTokenRule", [r.token, ruleToChain(r.rule)]));
  if (change.allow?.length) calls.push(m("setAllowed", [change.allow, true]));
  if (change.disallow?.length) calls.push(m("setAllowed", [change.disallow, false]));
  if (change.services?.length) calls.push(m("setServices", [change.services, true]));
  if (change.removeServices?.length) calls.push(m("setServices", [change.removeServices, false]));
  for (const v of change.vaults ?? []) calls.push(m("setTreasuryVault", [v, true]));
  for (const v of change.removeVaults ?? []) calls.push(m("setTreasuryVault", [v, false]));
  if (change.splits) calls.push(m("setSplits", [change.splits]));
  for (const c of change.counterpartyLimits ?? []) calls.push(m("setCounterpartyLimit", [c.token, c.counterparty, BigInt(c.limit)]));
  if (change.approver !== undefined) calls.push(m("setApprover", [change.approver ?? ZERO]));
  if (change.guardian !== undefined)
    calls.push(m("setGuardian", [change.guardian?.address ?? ZERO, BigInt(change.guardian?.delaySeconds ?? 0)]));
  if (!calls.length) fail(400, "empty_change", "Nothing to change.");
  return calls;
}

// ---------------------------------------------------------------------------------------------------- test mode: the engine plays the owner

/** Test mode only: signs a prepared Safe transaction with the test owner key and executes it on the local node. */
export async function execAsTestOwner(ctx: Ctx, p: PreparedSafeTx) {
  const owner = ctx.chain.accounts.owner ?? fail(403, "not_test_mode", "Owner actions by the engine exist only in test mode.");
  const relayer = ctx.chain.accounts.relayer!;
  const sig = await owner.sign({ hash: p.safeTxHash });
  const data = encodeFunctionData({
    abi: safeAbi,
    functionName: "execTransaction",
    args: [p.to, BigInt(p.value), p.data, p.operation, 0n, 0n, 0n, ZERO, ZERO, sig],
  });
  const receipt = await ctx.chain.send(relayer, { to: p.safe, data });
  if (receipt.status !== "success") fail(500, "safe_tx_failed", "The Safe transaction failed.");
  return receipt;
}

/** Test mode only: sends a direct owner call (freeze, approve) from the test owner wallet. */
export async function sendAsTestOwner(ctx: Ctx, tx: PreparedTx) {
  const owner = ctx.chain.accounts.owner ?? fail(403, "not_test_mode", "Owner actions by the engine exist only in test mode.");
  const receipt = await ctx.chain.send(owner, { to: tx.to, data: tx.data, value: BigInt(tx.value) });
  if (receipt.status !== "success") fail(500, "owner_tx_failed", "The owner transaction failed.");
  return receipt;
}

export const ethInfo = ETH_INFO;
