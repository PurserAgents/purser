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

/** Shipped so far, newest first. Each line is something the live product does today. */
export const shipped: { date: string; text: string }[] = [
  { date: "2026-11-14", text: "A fresh firewall check on every subscription charge and stream payout" },
  { date: "2026-11-13", text: "Live on chain: accounts, rules, firewall, approvals and receipts" },
  { date: "2026-11-13", text: "$PURSER live, with buy back and burn every 30 minutes" },
  { date: "2026-11-13", text: "Every contract, the engine and the site open source" },
  { date: "2026-11-11", text: "SDK, MCP server, CLI and guides for four agent frameworks" },
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
    status: "next",
    title: "Purser Shield",
    short: "Shield",
    summary: "One agent gets attacked, every agent is protected. Each trick the firewall blocks is shared across the whole network in the same second.",
    items: [
      { title: "A shared threat list", text: "When the firewall blocks an attack, the attacker side goes on a list every Purser account checks before it signs." },
      { title: "Only the attacker is shared", text: "Addresses, contracts and fingerprints of injected text. Never balances, owners or what your agent paid for." },
      { title: "Protected before you are targeted", text: "A drainer that hit one agent at 09:00 is blocked for every other agent at 09:00." },
      { title: "Your call per account", text: "Block on a shared signal, or let it warn and wait for your approval." },
      { title: "A public threat feed", text: "What was blocked, when and how many accounts it was aimed at, so anyone can see the network defend itself." },
    ],
    why: "Every wallet today fights alone. The more agents use Purser, the safer each one gets.",
  },
  {
    n: "03",
    slug: "pocket",
    status: "next",
    title: "Purser in your pocket",
    short: "Phone",
    summary: "Your agents' money on your phone. Approve with Face ID, watch every payment as it happens, freeze anything with one tap.",
    items: [
      { title: "Approve with Face ID", text: "A payment above your limit arrives as a notification. Look at it, approve or reject with your passkey." },
      { title: "A live feed", text: "Every payment, every earning and every blocked attempt across all your agents, as it happens." },
      { title: "One tap freeze", text: "Stop one agent or all of them from anywhere. Only you can unfreeze." },
      { title: "Alerts that matter", text: "Budget reached, a new payee, the watchdog stepping in. Nothing else." },
      { title: "A daily statement", text: "What each agent spent, earned and was stopped from doing, every morning." },
    ],
    why: "Approval only protects you if you can give it in seconds. The owner's side has to live where the owner is.",
  },
  {
    n: "04",
    slug: "models",
    status: "next",
    title: "Models at cost",
    short: "Models",
    summary: "Every AI model paid per call straight from the agent's own account. No markup, and no prepaid balance held by anyone.",
    items: [
      { title: "Pay per call", text: "Each model call is paid from the agent's account at the provider's price, through the same rules and firewall." },
      { title: "No balance with anyone", text: "Nothing sits prepaid at a middleman. The money stays in your Safe until the call is made." },
      { title: "The cheapest model that does the job", text: "Routing picks the lowest price model that meets the bar you set for each task." },
      { title: "Budgets per model", text: "Cap what an agent may spend on each model, per day and per task." },
      { title: "Cost you can see", text: "Cost per task, per model and per agent in accounting, and an open price index of AI tasks." },
    ],
    why: "Models are where agents spend the most. Paying them at cost, from an account you own, is the biggest saving an agent can make.",
  },
  {
    n: "05",
    slug: "hire",
    status: "soon",
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
    status: "soon",
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
