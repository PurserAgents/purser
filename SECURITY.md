# Security policy

Purser gives AI agents bank accounts with rules: a Safe the owner controls, a module that enforces budgets and
allowlists on chain, and an engine that simulates every payment before it is signed. Because Purser sits in front
of real money, we treat every security report as urgent.

## Report a vulnerability

Report privately through GitHub:
**[Security → Report a vulnerability](https://github.com/PurserAgents/purser/security/advisories/new)**.
Only the Purser team sees the report, and we can work on the fix with you in a private fork.

Please include:

- the component and file (for example `contracts/src/PurserModule.sol` or `engine/src/firewall.ts`)
- the steps to reproduce, ideally a Foundry test or a script against a local chain
- what an attacker gains, and what they need first (an agent key, an API key, an owner wallet, nothing)
- the commit or package version you tested

Please do not open a public issue, post about it, or share it with anyone until it is fixed and disclosed.

## What happens next

| Step | When |
|---|---|
| We confirm we received it | within 72 hours |
| We confirm the issue and agree a severity with you | within 7 days |
| Fix for a critical or high issue | as fast as possible; the owner's freeze and the engine's switches are used meanwhile when they help |
| Fix for a medium or low issue | in a following release |
| Public advisory | once the fix is live, or 90 days after the report, whichever comes first, unless we agree otherwise |

We keep you posted at each step and credit you in the advisory, by name or handle, if you want. There is no paid
bounty program at the moment.

## Severity

| Severity | Examples |
|---|---|
| **Critical** | Moving money out of an owner's Safe beyond its rules; an intent that runs without a valid agent signature; replaying a used nonce; an agent call that changes the Safe's owners, modules, guard or fallback; draining `PurserEscrow` beyond one job's amount |
| **High** | A payment that skips a required owner approval, co-signature or firewall signature; acting while an account is frozen; the watchdog key unfreezing; recovery executing before its delay or after a cancel; the engine exposing a stored session key or API key secret |
| **Medium** | The firewall allowing a payment its own checks should block; one account changing another account's settings, keys or webhooks through the API; a watchdog that can be kept from freezing; wrong amounts in receipts or the books |
| **Low** | Information that helps an attack without enabling one; problems on the site with a limited effect |

## In scope

**Contracts** (`contracts/src`), on Robinhood Chain (chain id 4663):

| Contract | What it does |
|---|---|
| `PurserModule` | The Safe module: rules, signed agent intents, approvals, co-sign, firewall co-sign, freeze, recovery, fee, incoming payments and splits |
| `PurserFactory` | Creates a Safe with the module enabled and the first rules, or attaches an existing Safe |
| `PurserRecurring` | Streams and subscriptions; every settlement goes through the module's rules |
| `PurserEscrow` | One job between a payer and a payee, released on delivery or refunded after the deadline |
| `PurserPasskey` and `WebAuthn` | Owner approvals with a passkey, verified on chain |

**Engine** (`engine/`): the firewall and simulation, the policy mirror, the watchdog, the audit trail, the x402
facilitator, agent API keys and engine-held session keys, the model gateway (models at cost), Purser Shield, the
API and its live stream.

**Packages** (`packages/`): the SDK, the MCP server, the CLI and the plugins for the Vercel AI SDK, LangChain and
ElizaOS.

**Site** (`web/`) and the live service at purseragents.fun.

## Out of scope

- **Rob the agent.** Talking the contest agent into paying is the game, not a vulnerability. Taking money from
  the contest vault without going through the agent is in scope.
- Contracts and services Purser uses but does not run: the Safe contracts, USDG, ERC-8004, Robinhood Chain
  itself, model providers. Please report those to their teams; tell us too if Purser makes the impact worse.
- Attacks that need the owner's own wallet or device already compromised.
- Reading an account's records through the API (receipts, verdicts with the text the agent read, intents and the
  rest). Reads need no auth by design; an agent whose page is not public is not listed, not private.
- Volume-based denial of service, spam, and rate limits without a security impact.
- Missing headers or best practices with no working attack.
- Social engineering or phishing of the team or of users.

## Testing rules

- Test on your own accounts, or on a local chain: `./preview.sh` runs a local copy of Robinhood Chain with Purser
  deployed and nothing sent to the live chain, and `./preview.sh --fork` forks the live chain read only.
- Never touch other people's accounts, funds or data. If you reach any by accident, stop and tell us.
- Do not run tests that could hurt the live service for others.

Research done in good faith and within these rules is welcome, and we will not take action against it.

## How Purser is built to stay safe

- **Non-custodial.** Money stays in the owner's own Safe. The only Purser contract that ever holds tokens is
  `PurserEscrow`, and only for one open job. The only money Purser itself holds is prepaid credit for models at
  cost, at its models address and kept per account; the owner can withdraw what is unused back to the Safe at any
  time (`POST /v1/accounts/:safe/model-credit/withdraw`).
- **The contract is the authority.** Budgets, allowlists, approvals, co-sign and freeze are enforced on chain, so
  the engine can be replaced or bypassed without weakening them.
- **The agent path is narrow.** No delegatecall, no calls to the Safe or the module, no direct `approve`,
  `permit` or `transfer` calls; token spending gets an exact allowance that is reset to zero in the same
  transaction, and every call's outflows are measured against the budgets.
- **A leaked agent key is not enough.** With the firewall on, every payment also needs the firewall's signature,
  given only after the exact transaction was simulated and passed.
- **Keys the engine holds** are encrypted with a key derived from the agent's API key secret (HKDF-SHA256,
  AES-256-GCM), so the database alone cannot sign.
- **The owner can always stop it.** Freeze is instant, the module can be disabled in one Safe transaction, and
  recovery runs through a guardian with a waiting period the owner can cancel.
- **Tested against attacks.** Delegatecall bypasses, approve-then-transferFrom, multicall, re-entrancy, nonce
  replay, malleable signatures and fee rounding (fuzzed) have dedicated tests. The full design is in
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Independent review

HEY Research Lab is doing an independent security review of Purser, starting with the spending rules. New code
that holds money, such as the escrow work in phase 05, goes to them for review before it handles real funds.
Findings from the review are handled the same way as any report here.

## Supported versions

Security fixes go to the `main` branch, the live service at purseragents.fun, and the latest version of each
package on npm.
