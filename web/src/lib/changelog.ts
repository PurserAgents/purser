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
    date: "2026-11-14",
    version: "0.6.0",
    title: "Purser Shield",
    summary: "One agent attacked, every agent protected. What one account's firewall catches, every account's firewall refuses.",
    items: [
      "When the firewall blocks an attack, the attacker's side goes on one shared list: planted payees, forwarding wallets and the code behind them, hostile spenders, and a one-way fingerprint of each injected sentence with addresses and amounts masked.",
      "Before it signs, every account's firewall checks the payee, every recipient and every spender of a payment against the list.",
      "Only the attacker is shared. Never balances, owners, amounts, the text the agent read or which accounts were attacked.",
      "Per account: block, the default, or warn, where the payment is held until the owner releases or rejects it in the dashboard.",
      "A flagged payee is never paid again by a subscription or stream, and the owner gets a watchdog alert at once.",
      "Purser accounts, addresses on an owner's list and payees several accounts already paid are never flagged, so a planted page cannot poison the list.",
      "The public list at /shield, with a lookup for any address.",
    ],
  },
  {
    date: "2026-11-14",
    version: "0.5.0",
    title: "A fresh firewall check on every recurring payment",
    summary: "Subscriptions and streams no longer rely on the check made when they were set up.",
    items: [
      "Every subscription charge and stream payout goes through the rules and a full firewall check before it is paid.",
      "With the firewall on, the contract refuses any recurring payout the firewall did not sign, each signature good for that one payout only.",
      "A payee that turns bad halfway through a subscription is not paid again.",
    ],
  },
  {
    date: "2026-11-13",
    version: "0.4.0",
    title: "Live on Robinhood Chain",
    summary: "The contracts are deployed, the engine runs live and anyone can open an agent account.",
    items: [
      "PurserModule, PurserFactory, PurserRecurring, PurserEscrow and PurserPasskey deployed and read back from the chain.",
      "The engine live, with a daily gas cap per engine key.",
      "$PURSER live, with a contract that buys it back and burns it every 30 minutes, and every burn listed on the token page.",
      "Every contract, the engine and the site open source.",
    ],
  },
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
  "Purser in your pocket: Face ID approvals and a live feed",
  "Models at cost, paid per call from the agent's account",
  "Agents hire agents: paid on delivery, rated by paid jobs",
];
