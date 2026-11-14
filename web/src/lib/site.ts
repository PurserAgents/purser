/**
 * One place for everything that identifies the site.
 * GitHub and X are placeholders until the accounts exist: change them here only.
 */
export const site = {
  name: "Purser",
  tagline: "A bank account for your AI agent.",
  description:
    "Give your AI agent money and rules. It pays for the models, services and apps it uses, earns from its own work, and every dollar has a receipt. Funds stay in your own Safe.",
  domain: "purseragents.fun",
  url: "https://purseragents.fun",
  github: "https://github.com/PurserAgents",
  x: "https://x.com/PurserAgents",
  contact: null,
  chain: {
    id: 4663,
    hexId: "0x1237",
    name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
} as const;

export interface NavItem {
  href: string;
  label: string;
  /** One line under the label in the header menus */
  text?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** The owner's pages, in the order of the tabs on every dashboard page. */
export const ownerNav: NavItem[] = [
  { href: "/app", label: "Overview", text: "Agents, balances and today's spending" },
  { href: "/app/approvals", label: "Approvals", text: "Payments waiting for you" },
  { href: "/app/safety", label: "Safety", text: "Firewall verdicts and watchdog events" },
  { href: "/app/money-out", label: "Money out", text: "Streams and subscriptions" },
  { href: "/app/money-in", label: "Money in", text: "Storefront, splits, invoices and escrow" },
  { href: "/app/treasury", label: "Treasury", text: "Idle money in on-chain vaults" },
  { href: "/app/teams", label: "Teams", text: "Org chart, departments and budgets" },
  { href: "/app/accounting", label: "Accounting", text: "Profit and loss, cost per task and model" },
  { href: "/app/audit", label: "Audit trail", text: "Every action, signed and verifiable" },
  { href: "/app/alerts", label: "Alerts", text: "Alerts and signed webhooks" },
];

/** Header menus. Every page of the site is reachable from here or from the footer. */
export const navGroups: NavGroup[] = [
  {
    label: "Product",
    items: [
      { href: "/how", label: "How it works", text: "Accounts, rules and the path of a payment" },
      { href: "/firewall", label: "Watch an attack get blocked", text: "A hidden instruction meets the firewall" },
      { href: "/shield", label: "Purser Shield", text: "One agent attacked, every agent protected" },
      { href: "/templates", label: "Rule templates", text: "Ready rules for each kind of agent" },
      { href: "/pay", label: "Pay button", text: "One script tag to get paid" },
      { href: "/token", label: "Token", text: "$PURSER is live" },
      { href: "/roadmap", label: "Roadmap", text: "What is live, what ships next" },
    ],
  },
  { label: "Dashboard", items: ownerNav },
  {
    label: "Network",
    items: [
      { href: "/economy", label: "Agent economy", text: "Spend, earnings and the AI task price index" },
      { href: "/directory", label: "Service directory", text: "Every x402 service paid through Purser" },
      { href: "/leaderboard", label: "Leaderboard", text: "Agents that earn the most" },
    ],
  },
  {
    label: "Developers",
    items: [
      { href: "/docs", label: "Docs", text: "One section per feature" },
      { href: "/developers", label: "SDK, MCP and CLI", text: "Give an agent its account in code" },
      { href: "/developers/guides", label: "Framework guides", text: "Claude Agent SDK, OpenAI Agents, LangChain, ElizaOS" },
      { href: "/changelog", label: "Changelog", text: "What changed and when" },
    ],
  },
];

/** Footer columns. */
export const footerNav: { title: string; items: NavItem[] }[] = [
  {
    title: "Product",
    items: [
      { href: "/how", label: "How it works" },
      { href: "/firewall", label: "Watch an attack get blocked" },
      { href: "/shield", label: "Purser Shield" },
      { href: "/templates", label: "Rule templates" },
      { href: "/pay", label: "Pay button" },
      { href: "/token", label: "Token" },
      { href: "/roadmap", label: "Roadmap" },
    ],
  },
  {
    title: "Dashboard",
    items: [
      { href: "/app", label: "Overview" },
      { href: "/app/open", label: "Open an account" },
      { href: "/app/approvals", label: "Approvals" },
      { href: "/app/safety", label: "Safety" },
      { href: "/app/accounting", label: "Accounting" },
    ],
  },
  {
    title: "Network",
    items: [
      { href: "/economy", label: "Agent economy" },
      { href: "/directory", label: "Service directory" },
      { href: "/leaderboard", label: "Leaderboard" },
    ],
  },
  {
    title: "Developers",
    items: [
      { href: "/docs", label: "Docs" },
      { href: "/developers", label: "SDK, MCP and CLI" },
      { href: "/developers/guides", label: "Framework guides" },
      { href: "/docs#api", label: "API" },
      { href: "/changelog", label: "Changelog" },
      { href: "/own-risk", label: "Own risk" },
    ],
  },
];
