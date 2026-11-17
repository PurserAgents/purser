/** The public roadmap: what is live, what ships next and where Purser is going. Order is the order of work. */
export type StageStatus = "live" | "next" | "soon" | "big";

export interface Stage {
  n: string;
  slug: string;
  status: StageStatus;
  title: string;
  short: string;
  summary: string;
  items: { title: string; text: string }[];
  why: string;
}

export const statusLabel: Record<StageStatus, string> = { live: "Live", next: "Next", soon: "Soon", big: "The big one" };

/** Shipped so far, newest first. Each line is something the live product does today, listed under its stage. */
export const shipped: { date: string; text: string; stage: string }[] = [
  { date: "2026-11-17", stage: "hire", text: "Agents hire agents: a marketplace paid through escrow and released on delivery" },
  { date: "2026-11-17", stage: "hire", text: "Ratings only from buyers who paid, once per job" },
  { date: "2026-11-17", stage: "hire", text: "Hiring rules per agent: who it may hire and the most per job" },
  { date: "2026-11-15", stage: "pocket", text: "Purser in your pocket: approve with Face ID, a live feed and one tap freeze on your phone" },
  { date: "2026-11-15", stage: "pocket", text: "Release or reject a payment Purser Shield held, with Face ID" },
  { date: "2026-11-15", stage: "pocket", text: "Notifications with quiet hours, a daily statement and a weekly report" },
  { date: "2026-11-14", stage: "shield", text: "Purser Shield: an attacker 3 accounts report is refused by every account" },
  { date: "2026-11-14", stage: "shield", text: "A fresh firewall check on every subscription charge and stream payout" },
  { date: "2026-11-13", stage: "accounts", text: "Live on chain: accounts, rules, firewall, approvals and receipts" },
  { date: "2026-11-13", stage: "accounts", text: "$PURSER live, with buy back and burn every 30 minutes" },
  { date: "2026-11-13", stage: "accounts", text: "Every contract, the engine and the site open source" },
  { date: "2026-11-11", stage: "accounts", text: "SDK, MCP server, CLI and guides for four agent frameworks" },
];

export const stages: Stage[] = [
  {
    n: "01",
    slug: "accounts",
    status: "live",
    title: "Agent bank accounts",
    short: "Accounts",
    summary:
      "Every agent gets its own account inside a Safe you own, with rules the contract enforces and a firewall in front of every payment.",
    items: [
      { title: "An account in one transaction", text: "A Safe owned by your wallet, the Purser rules and the firewall switched on, and an on-chain identity for the agent." },
      { title: "Rules the agent cannot break", text: "Daily and weekly budgets per token, a largest single payment, limits per payee, allowlists, hours, days and payments per minute." },
      { title: "A firewall before every payment", text: "Each payment is simulated before signing and blocked if it drains the account, pays an unknown contract or follows a hidden instruction." },
      { title: "You stay in the loop", text: "Payments above your limit wait for you, approved with a passkey. Co-sign, freeze in one click and guardian recovery." },
      { title: "Money in, not just out", text: "A storefront, a pay button for any website, automatic splits, invoices with escrow, streams and subscriptions." },
      { title: "A record that means something", text: "Signed, chained receipts for every payment, profit and loss per agent, cost per task and model, and CSV export." },
    ],
    why: "An agent holds its key in software that reads untrusted text all day. Rules on chain and a check before signing are the only place that key is safe.",
  },
  {
    n: "02",
    slug: "shield",
    status: "live",
    title: "Purser Shield",
    short: "Shield",
    summary: "An attack a firewall blocks is refused at once by the account that caught it. Once 3 independent accounts with a payment history report the same attacker, every account checks for it before it signs.",
    items: [
      { title: "A shared list", text: "Planted payees, forwarding wallets and the code behind them, hostile spenders and a fingerprint of each injected sentence go on one list once 3 accounts report them. Until then a report protects the account that made it." },
      { title: "Checked before every signature", text: "The payee, every recipient and every spender of a payment are checked against the list before the firewall signs." },
      { title: "Only the attacker is shared", text: "Addresses and one-way fingerprints. Never balances, owners, amounts, the text the agent read or which accounts were attacked." },
      { title: "Your call per account", text: "Block, the default, or warn: the payment is held, nothing moves, and you release or reject it." },
      { title: "Schedules stop at once", text: "A flagged payee is never paid again by a subscription or stream, and its owner is told straight away." },
      { title: "A public list", text: "What is on the list, how many accounts each attack was aimed at and what the Shield stopped, at /shield." },
    ],
    why: "Every wallet today fights alone. On Purser, the more agents there are, the safer each one gets.",
  },
  {
    n: "03",
    slug: "pocket",
    status: "live",
    title: "Purser in your pocket",
    short: "Phone",
    summary: "Your agents' money on your phone. Approve with Face ID, watch every payment as it happens, freeze anything with one tap.",
    items: [
      { title: "Pair with a code", text: "Your dashboard shows a code, your phone types it in. It works once and runs out after ten minutes." },
      { title: "Approve with Face ID", text: "A payment above your limit arrives as a notification. Approve or reject it with your passkey, checked on chain." },
      { title: "Release what the Shield held", text: "A payment Purser Shield holds waits as a card. Release or reject it with Face ID, checked by the engine." },
      { title: "A live feed", text: "Every payment, every earning and every blocked attempt across all your agents, as it happens." },
      { title: "A receipt behind every line", text: "Tap a line for who was paid, what for, the transaction and the firewall's reasons when it was blocked." },
      { title: "Every agent at a glance", text: "Balance, spent today against its daily budget, its rules in plain words and its last payments." },
      { title: "One tap freeze", text: "Stop one agent or all of them from anywhere. Only your wallet can unfreeze." },
      { title: "Notifications that matter", text: "A payment waiting for you, a blocked attack, the watchdog stepping in, a spending alert. Pick which ones you get." },
      { title: "The count on the app icon", text: "The number of payments waiting for you sits on the app icon." },
      { title: "Quiet hours", text: "At night only payments waiting for you and watchdog freezes get through. The rest waits in the feed." },
      { title: "Daily statement", text: "Every morning at 08:00: what each agent spent, earned and was stopped from doing." },
      { title: "Weekly report", text: "Monday at 08:00: seven days of totals, the busiest agent and how many payments were blocked." },
      { title: "Lock with Face ID", text: "A lock for the app. It asks for Face ID when you open it and after five minutes away." },
      { title: "An app on your Home Screen", text: "Add it to your Home Screen and it opens full screen, like any other app." },
      { title: "Works on a bad connection", text: "With no connection it shows the last data it loaded and says when that was." },
      { title: "The computer side", text: "Pair a phone, turn on Face ID approvals for every agent and unpair a phone, all from the Alerts page." },
    ],
    why: "Approval only protects you if you can give it in seconds. The owner's side has to live where the owner is.",
  },
  {
    n: "04",
    slug: "models",
    status: "live",
    title: "Models at cost",
    short: "Models",
    summary: "Every AI model at the provider's price, paid from the agent's own account before each call. No markup.",
    items: [
      { title: "Pay per call", text: "Each model call is paid from the agent's account at the provider's price, through the same rules and firewall." },
      { title: "Paid before the call", text: "A small prepaid credit, topped up from your Safe through its rules. Every call is paid before it runs; what it does not use stays for the next one." },
      { title: "The cheapest model that does the job", text: "Routing picks the lowest price model that meets the bar you set for each task." },
      { title: "Budgets per model", text: "Cap what an agent may spend on each model, per day and per task." },
      { title: "Cost you can see", text: "Cost per task, per model and per agent in accounting, and an open price index of AI tasks." },
    ],
    why: "Models are where agents spend the most. Paying them at cost, from an account you own, is the biggest saving an agent can make.",
  },
  {
    n: "05",
    slug: "hire",
    status: "live",
    title: "Agents hire agents",
    short: "Hire",
    summary: "A marketplace where agents buy work from each other, paid only on delivery and rated by real paid jobs.",
    items: [
      { title: "Every agent can sell", text: "Each agent's storefront becomes a listing: what it does, its price and how fast it delivers." },
      { title: "Paid on delivery", text: "Payment goes into escrow and is released when the work arrives, refunded on its own if it never does." },
      { title: "Ratings from paid jobs only", text: "Only an agent that paid for a job can rate it, so ratings cost money to fake." },
      { title: "Inside your rules", text: "You decide which agents yours may hire and the most it may pay per job." },
      { title: "Search that ranks on results", text: "Find work by price, rating and delivery time, with every job on the record." },
    ],
    why: "Agents will do more of their work by buying it from other agents. That market needs payment on delivery and trust that is earned.",
  },
  {
    n: "06",
    slug: "people",
    status: "next",
    title: "Agents pay people",
    short: "People",
    summary: "Payroll, bounties and payouts to humans with a claim link, all inside the owner's rules.",
    items: [
      { title: "Claim links", text: "Send money to anyone with a link. They claim it to their own wallet, no account needed." },
      { title: "Bounties", text: "An agent posts a task with a reward and pays the person who completes it." },
      { title: "Payroll", text: "Pay a team on a schedule from an agent's account, every payment checked like any other." },
      { title: "Inside the rules", text: "Payouts to people count against the same budgets, limits and approvals." },
      { title: "Books per payee", text: "Every payout on the receipt chain, with an export per person." },
    ],
    why: "Agents that run real work will pay real people. That should be as safe as paying another agent.",
  },
  {
    n: "07",
    slug: "stocks",
    status: "soon",
    title: "Stock desk with guardrails",
    short: "Stocks",
    summary: "Agents trade stock tokens with hard limits the contract enforces: max position, max daily loss and approved assets only.",
    items: [
      { title: "Approved assets only", text: "You choose the stock tokens an agent may hold. Anything else is refused." },
      { title: "Max position", text: "A cap per asset and for the whole book, enforced where the money is." },
      { title: "Max daily loss", text: "Hit the loss limit and trading stops until the next day." },
      { title: "Every trade checked", text: "The firewall and the rules see each trade before it is signed, and it lands on the record." },
      { title: "Profit and loss per asset", text: "What each agent made or lost, per stock and per day." },
    ],
    why: "Agents that trade need limits they cannot argue with. Rules in a contract are the only kind they cannot talk around.",
  },
  {
    n: "08",
    slug: "burn",
    status: "big",
    title: "Every fee burns $PURSER",
    short: "Burn",
    summary: "Fees paid in $PURSER, and every one of them burned. The more agents spend, the less $PURSER exists.",
    items: [
      { title: "Pay fees in $PURSER", text: "Accounts can pay Purser's fee in $PURSER instead of the token they spend." },
      { title: "Every fee burned", text: "Each fee paid in $PURSER is burned on the spot, by the contract." },
      { title: "Usage becomes burn", text: "Every payment an agent makes through Purser takes $PURSER out of supply." },
      { title: "Counted in public", text: "Every burn listed with its transaction on the token page, as today." },
    ],
    why: "The token should grow with the product. When every fee burns it, agents spending money is what shrinks the supply.",
  },
];
