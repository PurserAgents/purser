/** Newest first. Every release adds one entry here. */
export interface ChangelogEntry {
  date: string;
  version: string;
  title: string;
  summary: string;
  items: string[];
}

export const changelog: ChangelogEntry[] = [
  {
    date: "2026-11-11",
    version: "0.3.0",
    title: "The site, wired to the engine",
    summary: "Every page now shows live data from the engine, or says what will appear there and how to get it.",
    items: [
      "Owner dashboard: open an account from MetaMask, pick a rule template, change rules, top up, freeze, approve payments with your wallet or a passkey, recovery, agent keys.",
      "New dashboard pages: approvals, safety (firewall verdicts and the watchdog), money out, money in, treasury, teams with an org chart, accounting with CSV, the audit trail with verify, alerts and webhooks.",
      "Watch an attack get blocked: the firewall scenario runs live on a local chain, step by step.",
      "Public pages: the agent economy with the AI task price index, the service directory, rule templates, the pay button, agent storefronts.",
      "Developer pages with the SDK, the MCP server, the CLI and guides for four agent frameworks.",
    ],
  },
  {
    date: "2026-11-11",
    version: "0.2.0",
    title: "Contracts, engine and packages",
    summary: "Agent accounts on Robinhood Chain and the engine behind them, tested on a local chain and on a fork of the live chain.",
    items: [
      "PurserModule, PurserFactory, PurserRecurring, PurserEscrow and PurserPasskey: accounts, rules, approvals, co-sign, freeze, recovery, fees, splits, streams, subscriptions, escrow and passkeys.",
      "The engine: payments with a firewall in front, the x402 facilitator, one key for models, x402 services and apps, the watchdog, the signed audit trail, treasury, teams and accounting.",
      "@purser/sdk, @purser/mcp and the purser CLI, signed webhooks, and test mode in one command.",
    ],
  },
  {
    date: "2026-11-11",
    version: "0.1.0",
    title: "The website",
    summary: "The first pages: the landing page, how it works, docs and the leaderboard.",
    items: [
      "Landing page with the payment flow and a walk through accounts, safety, money out and money in.",
      "How it works: the account model, the rules, the path of one payment.",
      "Light and dark themes, and wallet connection through MetaMask.",
    ],
  },
];

export const upcoming: string[] = [
  "A live test on Robinhood Chain",
  "The token",
  "Public source code and hosting",
];
