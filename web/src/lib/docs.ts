/**
 * Docs content. One entry per feature. To document a new feature, add a section
 * here: the page, the table of contents and the smoke test pick it up.
 * Inline code is written between backticks.
 */
import type { CodeSample } from "@/components/CodeTabs";
import {
  apiSample,
  cliSample,
  embedSample,
  mcpSample,
  merchantSample,
  modelsSample,
  ownerSample,
  sdkSample,
  sellSample,
  testModeSample,
  webhookSample,
} from "./snippets";

export interface DocSection {
  id: string;
  title: string;
  body: string[];
  bullets?: string[];
  code?: CodeSample[];
}

export interface DocGroup {
  id: string;
  title: string;
  intro: string;
  sections: DocSection[];
}

export const docs: DocGroup[] = [
  {
    id: "start",
    title: "Start here",
    intro: "What Purser is and how the pieces fit.",
    sections: [
      {
        id: "overview",
        title: "Overview",
        body: [
          "Purser is the bank account and expense system for AI agents on Robinhood Chain. The owner gives an agent money and rules. The agent pays for what it uses and earns from its own work. Every dollar has a receipt.",
          "Purser is software. Funds always sit in the owner's own Safe. Purser contracts enforce the rules and take a fee per payment. They never hold a balance for anyone.",
        ],
      },
      {
        id: "quickstart",
        title: "Quickstart",
        body: ["Opening an account takes one transaction from MetaMask."],
        bullets: [
          "Connect MetaMask on Robinhood Chain (chain id 4663).",
          "Create the agent account. This deploys a Safe you own and enables the Purser policy module.",
          "Set the first rules: a daily budget, a largest single payment and who the agent may pay.",
          "Create an agent key and give it to your agent through the SDK, the MCP server or the CLI.",
          "Fund the Safe. The agent can now pay and get paid inside the rules.",
        ],
      },
    ],
  },
  {
    id: "accounts",
    title: "Accounts and rules",
    intro: "The account an agent uses, and the limits it cannot break.",
    sections: [
      {
        id: "agent-accounts",
        title: "Agent accounts",
        body: [
          "Each agent account is a Safe owned by the human owner, with the Purser policy module enabled. The agent holds a session key. That key is never a Safe owner: it signs payment intents, and the module checks the signature and every rule before any funds move.",
          "The factory creates the Safe, enables the module and writes the first rules in one transaction. An existing Safe can be attached the same way. The module can be switched off again in one Safe transaction.",
          "The module takes a fee per payment, sent to a fixed recipient and paid in the same token. The payee always gets the full amount. The fee is fixed at deployment and capped at 1% by a constant in the contract.",
          "Owner changes never go through Purser's keys: the engine prepares a transaction or a Safe transaction, and the owner's wallet signs and sends it.",
        ],
        code: [{ label: "owner.ts", code: ownerSample }],
      },
      {
        id: "identity",
        title: "Agent identity",
        body: [
          "When an account is opened, the agent is registered in the ERC-8004 identity registry and the agent id is stored with the account. Other agents and services can look up who they are dealing with.",
        ],
      },
      {
        id: "rules",
        title: "Rules",
        body: ["Rules are stored per account in the module and enforced on every payment. Only the owner can change them."],
        bullets: [
          "Daily and weekly budget per token. The fee counts toward the budget.",
          "Largest single payment.",
          "Limit per counterparty per day.",
          "Time windows: allowed hours and weekdays, in UTC.",
          "Rate limit: the most payments per minute.",
          "Allowlists for payees, contracts the agent may call, services and models by id, and treasury vaults.",
          "One-click templates per kind of agent set all of these at once.",
        ],
      },
      {
        id: "approvals",
        title: "Approval above an amount",
        body: [
          "Set an amount above which a payment needs you. Such a payment is queued on chain and no money moves. You approve or reject it with your wallet, or with a passkey on your phone or laptop: the passkey signature is checked on chain with Robinhood Chain's P-256 precompile. Only then does the payment run, through the firewall again.",
        ],
      },
      {
        id: "co-sign",
        title: "Co-sign",
        body: [
          "Above a second threshold, a second key (another agent, or a device of yours) has to co-sign the same intent. One agent alone cannot make a large payment, even inside the budget.",
        ],
      },
      {
        id: "freeze",
        title: "Freeze",
        body: [
          "Any owner can freeze an account at once, in one transaction, and unfreeze it again. A frozen account makes no payments. If you allow it, the watchdog key can freeze the account too. It can never unfreeze it or move funds.",
        ],
      },
      {
        id: "recovery",
        title: "Recovery",
        body: [
          "Name a guardian and a waiting period of at least one day. If you lose your wallet, the guardian proposes a new set of owners. It takes effect only after the waiting period, and any owner can cancel it until then.",
        ],
      },
    ],
  },
  {
    id: "money-out",
    title: "Money out",
    intro: "Everything an agent pays for, through one key.",
    sections: [
      {
        id: "agent-key",
        title: "One key for everything",
        body: [
          "An agent key (`prs_...`) belongs to one account, has scopes (pay, models, x402, call, sell, read, treasury, recurring, invoices) and can be revoked at once. Every call made with it is checked against the account's rules and the firewall.",
          "Purser can hold the agent's session key for it, sealed under the API key itself, so the database alone can never sign. An agent can also keep its own key and send signed intents.",
        ],
      },
      {
        id: "x402",
        title: "x402 payments",
        body: [
          "Purser runs an x402 v2 facilitator for Robinhood Chain (`/x402/verify`, `/x402/settle`). Payments to a Purser account settle through the module, so the owner's splits apply; payments from a Purser account go through its rules and the firewall first.",
          "The agent calls any x402 URL through Purser (`purser.x402Fetch`). When the service answers 402 with a price, Purser pays it inside the rules, up to the maximum the agent set, and returns the result with a receipt.",
        ],
      },
      {
        id: "models",
        title: "AI models",
        body: [
          "Purser exposes an OpenAI-compatible endpoint (`/v1/chat/completions`). Point your agent's model client at it and use the agent key. The owner adds providers: an own API key (the cost is recorded), an x402 provider or one paid per request in USDG (paid from the Safe). Tag a cost to a task with the `X-Purser-Task` header.",
        ],
        code: [{ label: "models.ts", code: modelsSample }],
      },
      {
        id: "apps",
        title: "On-chain apps",
        body: [
          "The agent can call contracts through the module, only on targets the owner allowed. A token allowance is granted for exactly one call and set back to zero, and every amount that leaves the Safe is measured and counted against the budgets. Swaps through the chain's Uniswap V3 router are the first app.",
        ],
      },
      {
        id: "streams",
        title: "Streams",
        body: [
          "A stream pays a payee per second from the agent's Safe, settled by the engine on a schedule and checked by the rules each time. The payee sends signed heartbeats while it delivers; nothing accrues after the last heartbeat plus a grace period. The payee, the owner or the agent can stop it.",
        ],
      },
      {
        id: "subscriptions",
        title: "Subscriptions",
        body: ["A fixed amount every period (an hour or longer) for a set number of periods, between agents and services. The first period is charged at once; every charge goes through the rules. The payee, the owner or the agent can cancel."],
      },
    ],
  },
  {
    id: "money-in",
    title: "Money in",
    intro: "Ways for an agent to earn, share and get paid for jobs.",
    sections: [
      {
        id: "storefront",
        title: "Agent storefront",
        body: [
          "An agent can sell its own services over x402: per call, per minute or per period. The engine runs the paywall, settles only after the agent's work succeeded, meters every use and pays the agent's own Safe. A merchant can also run the paywall itself with the SDK.",
        ],
        code: [
          { label: "Sell", code: sellSample },
          { label: "Own server", code: merchantSample },
        ],
      },
      {
        id: "pay-button",
        title: "Pay an agent button",
        body: ["One script tag adds a button to any page. The customer pays into the agent's own Safe through MetaMask: USDG as a signed EIP-3009 authorization, or ETH. On a phone without MetaMask it opens the page in the MetaMask app."],
        code: [{ label: "index.html", code: embedSample }],
      },
      {
        id: "splits",
        title: "Revenue splits",
        body: [
          "Set up to eight recipients per agent, such as the owner, the developer, a model provider and co-worker agents. The module pays each share the moment money arrives through Purser; the rest stays in the Safe.",
        ],
      },
      {
        id: "invoices",
        title: "Invoices and escrow",
        body: [
          "One agent invoices another. The payer funds an escrow from its Safe, inside its rules. The payee delivers, the payer releases or disputes within a review window; after the window anyone can pay the payee out, and after the deadline without delivery anyone can refund the payer. An optional arbiter settles disputes.",
          "The escrow holds only the amount of an open job between two named parties. It is never a Purser balance.",
        ],
      },
    ],
  },
  {
    id: "safety",
    title: "Safety",
    intro: "What stands between a bad instruction and the balance.",
    sections: [
      {
        id: "firewall",
        title: "Transaction firewall",
        body: [
          "Every payment and call is simulated before it is signed. The firewall checks the result and the request that triggered it.",
          "The verdict comes with plain reasons, is stored and is shown to the owner. A blocked payment never reaches the chain.",
        ],
        bullets: [
          "The owner's rules, explained in words: budgets, limits, hours, allowlists, frozen.",
          "A simulation of the exact transaction, with the revert decoded when it fails.",
          "Balance drain: half or more of a balance in one step, unless the same worth comes back.",
          "Unknown contracts, payees with delegated code, burn addresses and token contracts.",
          "Approvals left to a spender other than the target, and takeover calls.",
          "Planted instructions or hidden text in what the agent read before it paid.",
        ],
      },
      {
        id: "watchdog",
        title: "Spending watchdog",
        body: [
          "The watchdog keeps a spending baseline per agent: hourly spend over seven days, the usual payment and known payees. On a spike, a burst, a loop, a drain or several large first payments to new payees it freezes the account, if the owner left auto-freeze on, and sends the owner the reason.",
        ],
      },
      {
        id: "audit-trail",
        title: "Signed audit trail",
        body: [
          "Every engine action (payments, verdicts, approvals, freezes, keys, rule changes) is hashed, linked to the one before it and signed by the audit key. Export it as JSON Lines and check it on the site, with `purser audit verify` or with the engine's offline tool.",
        ],
      },
    ],
  },
  {
    id: "treasury-teams",
    title: "Treasury and teams",
    intro: "Idle balance, shared budgets and the books.",
    sections: [
      {
        id: "treasury",
        title: "Agent treasury",
        body: [
          "Idle USDG can move into an ERC-4626 vault the owner allowed, straight from the agent's own Safe, and back. The shares stay in the Safe, an amount the owner sets always stays liquid, and vault moves are not counted as spending.",
        ],
      },
      {
        id: "teams",
        title: "Agent organisations",
        body: [
          "A team is a treasury (one of the owner's agent accounts) plus members. A member's daily budget is enforced on chain as a limit on the treasury; a department's daily budget is checked by the engine before each top-up. Agents pay each other inside the team, and the org chart shows who sits where.",
        ],
      },
      {
        id: "accounting",
        title: "Accounting",
        body: [
          "Profit and loss per agent and per team (payments inside a team cancel out), cost per task, cost per model and revenue per customer, by day. Every receipt exports to CSV.",
        ],
      },
    ],
  },
  {
    id: "developers",
    title: "Developers",
    intro: "The SDK, the MCP server, the CLI and the API.",
    sections: [
      {
        id: "sdk",
        title: "SDK",
        body: ["`@purser/sdk` is a typed client for every engine area: paying, x402, models, streams, the storefront, invoices, the treasury, receipts, owner transactions, live events and webhook checks."],
        code: [{ label: "agent.ts", code: sdkSample }],
      },
      {
        id: "mcp",
        title: "MCP server",
        body: [
          "`@purser/mcp` gives an agent eleven tools over stdio: account, rules, pay, check a payment, receipts, x402 fetch, sell, services, invoice, pay an invoice, and profit and loss.",
        ],
        code: [{ label: "mcp.json", code: mcpSample }],
      },
      {
        id: "cli",
        title: "CLI",
        body: ["The `purser` command reads accounts, receipts, verdicts, approvals and the books, pays and checks payments, exports and verifies the audit trail, and starts test mode."],
        code: [{ label: "Terminal", code: cliSample }],
      },
      {
        id: "webhooks",
        title: "Webhooks and alerts",
        body: [
          "Subscribe a URL to events: receipts, blocked, queued and sent payments, approvals, watchdog events, freezes, invoices, streams and alerts. Each delivery carries `Purser-Signature` (HMAC-SHA256) and is retried after 5 seconds, 30 seconds and 2 minutes.",
        ],
        code: [{ label: "webhook.ts", code: webhookSample }],
      },
      {
        id: "api",
        title: "API",
        body: ["The engine serves JSON and Server-Sent Events. Amounts are integers in the token's base units, as strings; addresses are lowercase; times are unix seconds. Agents use an agent key, owners an owner session from a wallet sign-in; reads need none."],
        code: [{ label: "Routes", code: apiSample }],
      },
      {
        id: "guides",
        title: "Framework guides",
        body: [
          "Guides for the Claude Agent SDK, the OpenAI Agents SDK, LangChain and ElizaOS show how to hand the agent its key and tools. They are on the developer pages."
        ],
      },
      {
        id: "test-mode",
        title: "Test mode",
        body: ["One command starts a local copy of the chain (plain, or a fork of the live chain), deploys Purser on it, serves the engine and opens three agents with real on-chain activity. Nothing is ever sent to the live chain."],
        code: [{ label: "Terminal", code: testModeSample }],
      },
    ],
  },
  {
    id: "network",
    title: "The network",
    intro: "What every agent's payments add up to.",
    sections: [
      {
        id: "directory",
        title: "Service directory",
        body: [
          "Every x402 service paid through Purser and every agent storefront is listed with its price, uses, payers, delivery rate (a failed, uncharged call lowers it) and refunds. On the directory page and at `GET /v1/directory`."
        ],
      },
      {
        id: "economy",
        title: "Agent economy dashboard",
        body: [
          "A public view of total agent spend and earnings, the last 24 hours, the top services and an AI task price index built from real receipts. On the economy page and at `GET /v1/economy`."
        ],
      },
      {
        id: "templates",
        title: "Rule templates",
        body: ["Rule sets for research, trading, support, coding, seller, operations and custom agents, with alerts. Apply one when you open an account, or later in one Safe transaction."],
      },
      {
        id: "leaderboard",
        title: "Leaderboard and public pages",
        body: [
          "An agent's page and its place on the leaderboard are public only when the owner opts in. Everything else stays in the owner's dashboard.",
        ],
      },
    ],
  },
];

export const docSectionIds: string[] = docs.flatMap((group) => group.sections.map((section) => section.id));
