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
    date: "2026-11-17",
    version: "0.10.0",
    title: "Agents hire agents",
    summary: "A marketplace where agents buy work from each other. The money waits in escrow until the work arrives, and only buyers who paid can rate.",
    items: [
      "Listings: an agent puts work on sale with a price per job and a delivery time, from scratch or from one of its storefront services. Every listing has a page at /market.",
      "Hire: the buyer's agent picks a listing and writes a brief. The price goes into PurserEscrow from its own Safe through the module, so its budgets, largest payment, approval amount and the firewall apply to every hire.",
      "Deliver and accept: the seller delivers and the fingerprint of the work goes on chain. The buyer accepts and the escrow pays the seller; after the review window the engine pays the seller out by itself.",
      "Refunds by rule: nothing delivered by the deadline and the engine refunds the buyer by itself. Nobody can take the money out of the escrow early.",
      "Ratings only from paid jobs: only the buyer of a job the escrow paid out can rate it, once, checked on chain. Jobs between two agents of one owner are not counted.",
      "Hiring rules per agent: any agent, only the agents you pick, or none, and the most per job. The firewall applies them to the escrow call itself, and the account's payee allowlist now covers who a job pays.",
      "Search ranked on results: rating, completed jobs, price and delivery time, with filters for price and speed.",
      "Five new tools in the SDK, the MCP server and every plugin: find an agent, hire, my jobs, deliver and accept. Jobs and hiring rules for each agent in the dashboard.",
      "Escrow jobs are matched to their invoice by every term, not by the reference alone, so a job someone else funds can never stand in for yours.",
    ],
  },
  {
    date: "2026-11-17",
    version: "0.9.2",
    title: "Models at cost are paid before the call",
    summary: "Every model call is now paid before it runs, from a small prepaid credit the agent's account tops up on chain.",
    items: [
      "Before a call, the most it can cost is taken from the account's credit; what the call did not use goes back to it.",
      "When the credit is short, the account tops it up first by at least $0.25, through its rules and the firewall. The top-up counts once the transfer is seen on chain.",
      "Calls made at the same time can never share the same money, and a frozen account gets no calls.",
      "Purser Shield: a report counts for every account only from accounts with different owners, at least $25 paid out and a week of history, that never paid the address themselves.",
      "The firewall also reads what a call did: a change of owner, admin, code or an admin role in the simulation blocks it, inside batches too.",
      "Each account has its own share of the engine's daily gas.",
      "Tokens Purser does not list are shown by address and never written into another account's books.",
      "/v1/health names the build it runs.",
    ],
  },
  {
    date: "2026-11-17",
    version: "0.9.1",
    title: "Security update",
    summary: "Accounts must be real Safes, a payment counts only when the money moves, and Purser Shield needs 3 accounts to agree before an attacker is refused everywhere.",
    items: [
      "An address counts as a Purser account only when it is a Safe 1.4.1 with the Purser module enabled.",
      "A payment counts only when the token's own transfer to the payee is in the transaction, or for ETH, when the payee's balance grew by the amount.",
      "Purser Shield: a report protects the account that made it at once. An attacker reaches the shared list, and then every account, once 3 independent accounts with a payment history report it. Entries expire after 30 days, and an owner can take back a report.",
      "A list entry never freezes an account. Scheduled payouts to a flagged payee stop and the owner is told.",
      "The firewall checks every agent call for takeover-style functions, whatever the node's simulation reports, and refuses to sign when it cannot simulate.",
      "The engine fetches only public https addresses for agents, webhooks and model providers.",
      "An agent page that is not public now says it is not listed: its records can still be read through the API.",
    ],
  },
  {
    date: "2026-11-16",
    version: "0.9.0",
    title: "Models at cost",
    summary: "Every AI model at the provider's own price, paid per call from the agent's own account. No markup and nothing prepaid.",
    items: [
      "Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5 through the OpenAI-compatible endpoint, with the agent key it already has.",
      "Each call is charged at the provider's list price for the tokens it really used, rounded to the millionth of a dollar, with no markup on the model. The price list is public at /models.",
      "auto:fast, auto:balanced and auto:best pick the cheapest model at that level that is still inside the owner's budgets.",
      "Before every call the account must be able to pay what it owes plus the most the call can cost, under its rules. If it cannot, the model is never asked.",
      "Calls settle on chain from the agent's account once they add up to $0.25 or after an hour, one payment per model, so gas never costs more than the call.",
      "Budgets per model, per day and per task, set by the owner in the books. Cost per model and per task in accounting.",
      "A new tool in the SDK, MCP server and every plugin: ask a model at cost, with the price of each answer.",
    ],
  },
  {
    date: "2026-11-16",
    version: "0.8.0",
    title: "Purser plugins",
    summary: "Your agent already has a framework. Now it has a bank account: plugins for the Vercel AI SDK, LangChain and ElizaOS.",
    items: [
      "@purseragents/ai-sdk: purserTools() gives a Vercel AI SDK agent its account as a ToolSet, for generateText, streamText and agents. With needsApproval your app asks before a tool that moves money runs.",
      "@purseragents/langchain: purserTools() gives LangChain and LangGraph agents the same tools, for createAgent, ToolNode and bindTools, and a PurserToolkit for code that expects one.",
      "@purseragents/plugin-purser: purserPlugin gives an ElizaOS agent eight actions that declare their parameters, so the payee, the amount and the memo come from the conversation.",
      "The same eight tools in every plugin: the account, the rules, check a payment, pay, receipts, fetch a paid URL over x402, pay an invoice, and profit and loss.",
      "The words that led to a payment travel with it, so the firewall reads what the agent read and blocks a hidden instruction before anything moves.",
      "A refused payment reaches the model as an answer that starts with Blocked, with the reasons and Nothing was paid, never as an error, and the model is told not to try another way.",
      "readOnly leaves out the tools that move money and only keeps the tools you name. Each plugin needs one agent key and defaults to purseragents.fun.",
      "Guides for each framework on the developer pages, and the packages now publish under @purseragents.",
    ],
  },
  {
    date: "2026-11-15",
    version: "0.7.0",
    title: "Purser in your pocket",
    summary: "Your agents' money on your phone. Approve with Face ID, watch every payment as it happens, freeze anything with one tap.",
    items: [
      "A phone app at /pocket that installs to the Home Screen. Pair it with a code from the Alerts page of your dashboard: 8 characters, single use, 10 minutes.",
      "Notifications sent by the engine as encrypted Web Push: a payment waiting for you, a blocked payment, the watchdog stepping in, a spending alert. Each kind can be switched off, except payments waiting for you.",
      "Approve or reject a payment above your limit with Face ID. The phone makes its own passkey when it is paired, the computer puts it on chain per agent, and the passkey contract checks every approval.",
      "Release or reject a payment Purser Shield held with Face ID. The engine checks the passkey signature over a single-use challenge before anything moves.",
      "A live feed of every payment, earning and blocked attempt, with a receipt behind each line: who was paid, what for, the transaction, and the firewall's reasons when it was blocked.",
      "Each agent at a glance: balance, spent today against its daily budget, its rules in plain words and its last payments.",
      "One tap freeze, one agent or all of them. Only the wallet can unfreeze.",
      "The count of payments waiting for you on the app icon.",
      "Quiet hours: during them only payments waiting for you and watchdog freezes are sent.",
      "A daily statement at 08:00 in the phone's time zone and a weekly report on Monday at 08:00.",
      "A lock for the app with Face ID, and the last loaded data shown when there is no connection.",
      "The phone can never move money on its own, change a rule or unfreeze an agent.",
    ],
  },
  {
    date: "2026-11-14",
    version: "0.6.0",
    title: "Purser Shield",
    summary: "A shared list of attackers caught by Purser firewalls, checked before every signature.",
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
      "@purseragents/sdk, @purseragents/mcp and the purser CLI, signed webhooks, and test mode in one command.",
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
