# Purser architecture

This file records the design decisions for the contracts, the engine and the packages. It is the reference for
anyone reading or auditing the code. The web app is described in `docs/DESIGN.md`.

## 1. The decision (step 3.1)

**Each agent account is a Safe 1.4.1 owned by the human owner, with the Purser module enabled. The agent holds a
session key that can only act through the module.**

- The money sits in the owner's own Safe. Purser never holds a balance for anyone. There is no deposit into a
  Purser contract and no pooled account. The only Purser contract that ever holds tokens is `PurserEscrow`, and
  only for one job between two named parties, paid out by rule.
- The owner (one or more MetaMask wallets, the Safe owners) keeps full control: the Safe works as a normal Safe,
  the module can be disabled in one Safe transaction, and every rule change is a Safe transaction.
- The agent never becomes a Safe owner. Its session key signs EIP-712 intents (pay, call, treasury, stream,
  subscription). Anyone may submit a signed intent (the engine relays it, or the agent sends it itself); the module
  checks the signature and every rule before it moves a single unit out of the Safe.
- The module is a singleton: one deployment serves every account, with all state keyed by the Safe address. This
  keeps the contract set small and the audit surface in one place.

### Why not ERC-4337 session keys (Safe4337Module)?

The Safe4337Module on chain 4663 (0.3, `0x75cf…c226`) validates owner signatures; it has no notion of a budget or
an allowlist. Rules would still need a module or guard. A plain module with signed intents is smaller, needs no
bundler (no paymaster, no EntryPoint dependency) and can be relayed by any account. EntryPoint 0.7/0.8 stay
available if a later version wants gas sponsorship through a bundler.

### Verified on chain 4663 (2026-11-11, by `cast` and fork tests)

| Contract | Address | Check |
|---|---|---|
| Safe 1.4.1 singleton | `0x41675C099F32341bf84BFc5382aF534df5C7461a` | `VERSION()` = "1.4.1" |
| SafeProxyFactory 1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | code present, fork test deploys a proxy |
| CompatibilityFallbackHandler 1.4.1 | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | code present |
| MultiSendCallOnly 1.4.1 | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | code present |
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | UUPS proxy, `name()` = "AgentIdentity", `getVersion()` = "2.0.0", has `register(string)` |
| USDG (Global Dollar) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | symbol USDG, 6 decimals, EIP-712 domain name "Global Dollar" version "1", EIP-3009 `transferWithAuthorization` + `receiveWithAuthorization` in both (v,r,s) and (bytes) forms |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | symbol WETH |
| Uniswap V3 SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` | `exactInputSingle`, factory `0x1f7d7550…2EfA` |
| USDG/WETH V3 pool, fee 100 | `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` | most liquid USDG/WETH pool |
| Uniswap Universal Router (V4) | `0x8876789976decbfcbbbe364623c63652db8c0904` | `poolManager()` = V4 PoolManager `0x8366…0951` |
| Steakhouse USDG vault (Morpho Vault V2) | `0xbeeff033f34c046626b8d0a041844c5d1a5409dd` | ERC-4626, asset USDG, about 535M USDG |
| Spark Savings USDG | `0xde770c84fe66e063336b31737cfe9790f18c4087` | ERC-4626, asset USDG |
| P-256 verify precompile | `0x0000000000000000000000000000000000000100` | returns 1 for a valid signature (RIP-7212 input layout) |

Node capabilities: `eth_simulateV1` (with `traceTransfers`) is available, `debug_traceCall` is not. The firewall
uses `eth_simulateV1` on the node, and `debug_traceCall` with the call tracer on a local anvil fork.

The chain is an Arbitrum Orbit chain (ArbOS precompile at `0x64` answers). `block.number` there is not a reliable
clock, so every contract uses `block.timestamp` only.

## 2. Contracts (`contracts/src`)

Four contracts and one library. Solidity 0.8.28, via-IR, no external dependencies.

| Contract | What it does | Holds funds? |
|---|---|---|
| `PurserModule` | The Safe module. Account config, rules, agent intents (pay, call, treasury), approval queue, co-sign, firewall co-sign, freeze, recovery, fee, incoming payments with splits. | Never. ETH sent to `receiveETH` is forwarded to the Safe in the same call. |
| `PurserFactory` | Creates a Safe, enables the module, writes the first rules and registers the ERC-8004 identity in one transaction. The same setup function attaches an existing Safe through one Safe transaction (delegatecall). | Never |
| `PurserRecurring` | Streams (pay per second with payee heartbeats) and subscriptions. Every settlement goes through the module and its rules. Version 2: with a firewall key on the account, every charge and stream payout also needs the firewall's signature for that one payout (`chargeWithFirewall`, `settleWithFirewall`), so each recurring payment is checked fresh. | Never |
| `PurserEscrow` | Invoices between two agents: one job, one payer, one payee, optional arbiter, release on delivery, refund after the deadline. | Only the amount of an open job, until release or refund |
| `PurserPasskey` | Holds each account's passkey public key and approves or rejects queued intents after checking a WebAuthn assertion. The owner makes it the account's approver. | Never |
| `WebAuthn` (library) | Verifies a passkey assertion (WebAuthn, P-256) through the chain's precompile at `0x100`. | n/a |

Runtime sizes (via-IR, optimizer runs 1): PurserModule about 23.2 KB (under the 24 KB limit with 1.4 KB to spare),
PurserRecurring 7.5 KB, PurserFactory 4.5 KB, PurserEscrow 4.2 KB, PurserPasskey 2.7 KB. Passkey verification was
moved out of the module to stay under the limit. solc 0.8.28 emits prague bytecode; MCOPY, PUSH0 and TSTORE were
checked on chain 4663. Tests execute with Osaka rules so the P-256 precompile exists in forge as it does on chain.

### 2.1 Rules (per Safe)

- Per token (`address(0)` is ETH): enabled, max single payment, daily budget, weekly budget, per-counterparty
  daily limit, approval threshold, co-sign threshold, receivable. A limit or threshold set to `type(uint128).max`
  means "no cap" / "never". A threshold of 0 means "always".
- Per counterparty overrides of the daily limit (used by team treasuries for per-agent budgets).
- Rate limit: max payments per minute (fixed one-minute windows).
- Time windows: allowed UTC hours (24-bit mask) and weekdays (7-bit mask, bit 0 = Monday).
- Allowlists: addresses (payees and call targets), service ids (bytes32, e.g. `keccak256("model:gpt-x")`), treasury
  vaults. Payee and service allowlists can be switched on per account; generic calls always require an allowlisted
  target.
- Budgets count the payment plus the Purser fee. Days are UTC days; weeks start Monday 00:00 UTC.

### 2.2 Agent intents (EIP-712, domain "Purser" / "1")

```
Pay(address safe,address token,address to,uint256 amount,bytes32 service,uint256 nonce,uint256 deadline)
Call(address safe,address target,uint256 value,bytes32 dataHash,address spendToken,uint256 spendLimit,uint256 nonce,uint256 deadline)
Treasury(address safe,address vault,bool deposit,uint256 assets,uint256 limit,uint256 nonce,uint256 deadline)
AgentOp(address safe,bytes32 opHash,uint256 amount,uint256 nonce,uint256 deadline)   (used by PurserRecurring)
```

Signatures are passed as one `bytes` blob: the agent's 65-byte signature, then the co-signer's (when the amount is
above the co-sign threshold), then the firewall's (when the owner switched the firewall on). Nonces are unordered
(a used-nonce map per Safe), so parallel payments never block each other and no intent can be replayed.

### 2.3 What the agent path can never do

- Delegatecall: the module only uses `CALL` (operation 0).
- Call the Safe itself or the module (no owner, module, guard or fallback changes).
- Call `approve`, `increaseAllowance`, `setApprovalForAll`, `permit`, `transfer`, `transferFrom`,
  `safeTransferFrom`, `safeBatchTransferFrom` or Permit2 `approve`/`permit` directly. Token spending goes through
  `pay`, or through `call` with a spend token, where the module grants an exact allowance to the target, runs the
  call and sets the allowance back to zero in the same transaction.
- Call an enabled token contract directly.
- Move more than the rules allow: for every `call` the module measures the Safe's balance of ETH and of every
  enabled token before and after, and counts each outflow against the budgets of that token.
- Act while the account is frozen.

### 2.4 Fee

`FEE_BPS` and `FEE_RECIPIENT` are immutable. `FEE_BPS <= MAX_FEE_BPS` (100 = 1%) is checked in the constructor.
The fee is `amount * FEE_BPS / 10_000`, rounded down, paid from the Safe in the same token, on agent payments and
measured call outflows. The payee always receives the full amount. Incoming payments, splits and treasury moves
pay no fee.

### 2.5 Approvals, co-sign, freeze, recovery

- **Approval queue:** a pay or call above the approval threshold is stored as pending (no revert, no funds move).
  The owner approves with a Safe owner wallet (direct call), a Safe transaction, or a registered passkey (WebAuthn
  assertion over the intent hash, verified on chain by the P-256 precompile). The same signed intent can then be
  submitted again and runs.
- **Co-sign:** above the co-sign threshold a second key (another agent, or a human device) must sign the same
  intent.
- **Firewall co-sign:** when the owner sets a firewall key, every intent needs the firewall's signature too. The
  engine's firewall only signs after simulation and checks pass, so a blocked payment cannot reach the chain even
  if the agent key leaks.
- **Freeze:** any Safe owner (direct call) or the Safe itself, instantly. The watchdog key, if the owner set one,
  can freeze but never unfreeze.
- **Recovery:** the owner names a guardian and a delay (at least one day). The guardian proposes a new owner set;
  after the delay anyone can execute it; until then any Safe owner can cancel.

### 2.6 Money in

- `receiveWithAuthorization`: the module makes the Safe call USDG `transferWithAuthorization` (what standard x402
  clients sign) or `receiveWithAuthorization` (EIP-3009, bytes signature form) with the payer's signature, checks
  the balance change, then pays the owner's split rules from the Safe.
- `receiveETH`: forwards the ETH to the Safe and applies the splits in the same call.
- Splits: up to 8 recipients with basis points summing to at most 10,000; the rest stays in the Safe.

### 2.7 Treasury

The agent (signed `Treasury` intent) or a Safe owner moves idle balance into an allowlisted ERC-4626 vault and
back. Shares always go to the Safe, the vault gets an exact allowance that is reset to zero, and the share or asset
change is checked against a limit. An owner-set "keep liquid" amount per token cannot be deposited.

## 3. Engine (`engine/`)

Node + TypeScript (tsx), better-sqlite3, viem, Hono. One process with these parts:

- `chain`: viem clients with RPC failover, a log reader that uses 100,000-block spans and halves on error, and a
  broadcast guard: the engine only sends transactions to a local node (a fork) in this build.
- `indexer`: reads module, recurring and escrow events into SQLite.
- `api`: JSON API and an SSE stream (`docs/API.md`).
- `firewall`: simulates every intent before the firewall key signs, and explains the verdict.
- `watchdog`: per-agent baseline; freezes through the watchdog key on spikes, strange new counterparties and loops.
- `audit`: every engine action signed and hash-chained; export and verify.
- `x402`: facilitator (`/x402/verify`, `/x402/settle`, `/x402/supported`) for `eip155:4663`.
- `connector`: agent API keys, OpenAI-compatible model proxy, x402 fetch-and-pay, on-chain calls and swaps.
- `recurring`, `storefront`, `splits`, `invoices`, `treasury`, `teams`, `accounting`, `directory`, `economy`,
  `templates`, `webhooks`.

Detailed engine design is in section 5.

## 4. Session keys held by the engine

An agent can keep its session key itself (the SDK signs locally and the engine only relays), or let the engine
hold it so one API key is enough. In the second mode the session key is stored encrypted with a key derived from
the agent's API key secret (HKDF-SHA256 + AES-256-GCM). The engine's database alone cannot sign: the key is only
decrypted while a request carrying that API key is served. The rules and the firewall still apply to every intent,
and the owner can freeze or rotate the key at any time.

## 5. Engine design

### 5.1 The payment pipeline

```
agent request (API key, or an intent the agent signed itself)
  -> build the EIP-712 intent (unordered nonce, deadline 15 minutes on the chain's clock)
  -> agent signature (engine-held session key, decrypted for this request only) or check the given one
  -> policy mirror: the module's rules re-read from chain and explained in plain words
  -> co-signature when above the co-sign threshold (status needs_cosign until it arrives)
  -> firewall: simulate the exact transaction, run the checks, store the verdict
       block -> stored, audited, sent on SSE and webhooks; never relayed
  -> firewall co-signature (only after an allow)
  -> relay to the local node (this build) and read the receipt
       IntentQueued -> status queued; the owner approves on chain; the engine resumes it (firewall again)
  -> indexer turns the logs into receipts (both sides when one Purser account pays another)
  -> watchdog, alerts, webhooks, audit trail
```

Intent kinds: pay, call (allowlisted contract, exact allowance), treasury (vault), and through PurserRecurring
stream and subscription (AgentOp signatures). Escrow actions are calls to PurserEscrow.

### 5.2 Firewall checks

Simulation backend: `eth_simulateV1` with transfer traces (the Robinhood node has it), else `debug_traceCall` with
the call tracer (a local fork has both). Verdict reasons carry a code, a severity (block, warn, info), a one-line
title and a plain detail:

| Code | Severity | What it means |
|---|---|---|
| frozen, time_window, rate_limit, token_not_enabled, max_single, daily_budget, weekly_budget, counterparty_limit, payee_not_allowed, service_not_allowed | block | The owner's rules (the module would refuse too) |
| simulation_failed | block | The exact transaction reverts; the revert is decoded into words |
| drain / large_share | block / warn | One step moves 50% / 25% or more of a token balance, unless value of about the same worth comes back (a swap) or it goes into an allowed vault |
| delegated_eoa | block | The payee runs EIP-7702 delegated code (common drainer setup on this chain; seen on well-known test keys) |
| unknown_contract | warn for pay, block for call | A contract never paid before and not allowlisted |
| new_counterparty | info | First payment to an address |
| burn_address, token_contract | block | Money that can never come back |
| approval_unknown_spender | block | The simulation leaves an allowance to someone other than the target |
| dangerous_call | block | transferOwnership, upgradeTo(AndCall), setOwner, renounceOwnership, enableModule, setGuard, setFallbackHandler |
| injection | block | The text that led to the payment contains planted instructions (ignore previous instructions, new or secret instructions, move or drain everything, hide it from the owner, fake role tags), or the payee address comes from hidden text |
| injection_in_prompt | warn | Instruction-like text in a model prompt when the payment only goes to the model provider |
| hidden_text | warn | Zero-width characters, HTML comments, invisible styling or direction controls in the request |
| needs_approval, needs_cosign | info | Not a block; the payment waits |

### 5.3 Watchdog

Baseline per agent: hourly spending over seven days (mean and spread), median payment, known payees. After every
executed payment and every minute it checks: spike (hour above mean + 4 spreads, at least $5 and three times the mean,
with 12 hours of history), burst (10 payments in a minute), loop (5 identical payments in 10 minutes), drain (50% of
a balance gone within the hour), strange new payees (three or more large first payments in an hour). Critical findings
freeze through the watchdog key when the owner set it and left auto-freeze on; otherwise the owner gets the alert.

### 5.4 Indexer and time

Logs are read from the node only (Blockscout is closed), from the deployment block, in 100,000-block spans that halve
when the node refuses. Each log is handled once, whether it comes with the engine's own transaction or from the
poller. Deadlines, time windows, streams and subscriptions use the chain's clock, so test mode can move time forward.

### 5.5 Data

SQLite (better-sqlite3, WAL): accounts, api_keys, intents, receipts, verdicts, watch_events, audit, streams,
subscriptions, services, service_usage, invoices, teams, departments, team_members, webhooks, webhook_deliveries,
alerts, x402_settlements, x402_services, model_calls, account_sets (allowlists seen on chain), seen_logs, kv. Every
receipt comes from a chain event, except model costs billed to the owner's own provider key, which are marked so.

### 5.6 Money in and the network

- x402 facilitator: EIP-3009 payloads from any wallet; Purser intent payloads from Purser accounts. A Safe cannot sign
  EIP-3009 itself, so Purser accounts pay x402 merchants whose facilitator accepts Purser intents (any Purser engine,
  because the payload carries the firewall's signature). Merchants on other facilitators would need an EIP-3009 payer.
- Storefront: settles only after the agent's work succeeded; a failed call is not charged and lowers the service's
  delivery rate in the directory.
- Splits apply to money that arrives through Purser (x402 settlement, storefront, pay button, receiveETH). Tokens sent
  straight to the Safe are not split.

### 5.7 Teams

A team is a treasury Safe (a Purser account) plus members. A member's daily budget is enforced on chain as a per-payee
limit on the treasury; a department's daily budget is enforced by the engine before each top-up.

### 5.8 Known limits in this build

- Broadcasting is limited to a local node (anvil). Nothing is sent to chain 4663.
- Model providers are tested against stubs only. The per-request USDG ("transfer") adapter follows the shape described
  for Raeto; its exact headers need checking against the real service in stage 7.
- Rate limits use fixed one-minute windows; weeks start Monday 00:00 UTC.
- When an allowlisted contract (for example a multicall) moves tokens it was allowed for one call, the counterparty
  recorded and limited is that contract.
- A split recipient that rejects payments makes incoming payments through Purser fail until the owner changes splits.
- The engine is one process with one SQLite file.

### 5.9 For the website

- Types: `packages/sdk/src/schema.ts` (no dependencies; copy or import).
- Every endpoint, with a real example response: `docs/API.md` (regenerate with `npx tsx engine/scripts/api-doc.ts`).
- Live updates: `GET /v1/events` (SSE), filter with `safe` and `types`.
- Owner actions: `.../prepare` endpoints return the transaction for MetaMask; the engine never signs for the owner.
- Test mode (`npm run testmode` in `engine/`) seeds three agents with real on-chain activity and enables
  `/v1/testmode/*` and `POST /v1/demo/firewall/run` (with `paceMs` for filming; steps arrive as `demo` events).
