/**
 * Code shown on the landing page, the developer page and the docs. Written against the real packages:
 * @purser/sdk (packages/sdk/src/client.ts), @purser/mcp (packages/mcp, eleven tools) and the purser CLI
 * (packages/cli/src/index.ts). Keep them in step when those change.
 */
import type { CodeSample } from "@/components/CodeTabs";

export const sdkSample = `import { Purser, usdg } from "@purser/sdk";

const purser = new Purser({
  baseUrl: process.env.PURSER_ENGINE_URL,
  apiKey: process.env.PURSER_API_KEY,
});

// Pay inside the owner's rules. A refused payment comes back "blocked", with reasons.
const paid = await purser.pay({ to: supplier, amount: usdg("2.50"), memo: "data report" });
if (paid.intent.status === "blocked") console.log(paid.verdict.summary);

// Call an x402 service. Purser pays the 402 from the agent's Safe, up to a maximum.
const res = await purser.x402Fetch(serviceUrl, { maxAmount: usdg("1") });

// Every dollar has a receipt.
const { items } = await purser.accounts.receipts(paid.intent.safe, { limit: 10 });`;

export const mcpSample = `{
  "mcpServers": {
    "purser": {
      "command": "npx",
      "args": ["-y", "@purser/mcp"],
      "env": {
        "PURSER_ENGINE_URL": "https://your-engine",
        "PURSER_API_KEY": "prs_..."
      }
    }
  }
}

// Tools: purser_account, purser_rules, purser_pay, purser_check_payment,
// purser_receipts, purser_x402_fetch, purser_sell, purser_services,
// purser_invoice, purser_pay_invoice, purser_pnl`;

export const cliSample = `export PURSER_ENGINE_URL=https://your-engine PURSER_API_KEY=prs_...

purser account                      # balances, today's spending, rules
purser pay 0xPAYEE 2.50 --memo "data report"
purser check 0xPAYEE 100 --context "text that led to the payment"
purser receipts --limit 20
purser verdicts --blocked
purser audit export > audit.jsonl && purser audit verify audit.jsonl`;

export const developerSamples: CodeSample[] = [
  { label: "SDK", code: sdkSample },
  { label: "MCP", code: mcpSample },
  { label: "CLI", code: cliSample },
];

export const modelsSample = `import OpenAI from "openai";

// Any OpenAI-compatible client, paid from the agent's account.
const models = new OpenAI({
  baseURL: \`\${process.env.PURSER_ENGINE_URL}/v1\`,
  apiKey: process.env.PURSER_API_KEY,
});

const reply = await models.chat.completions.create({
  model: "the-model-id-your-owner-set-up",
  messages: [{ role: "user", content: "Summarise these filings" }],
}, { headers: { "X-Purser-Task": "weekly-brief" } });`;

export const merchantSample = `import { Hono } from "hono";
import { purserPaywall } from "@purser/sdk/merchant";

const app = new Hono();

// Price an endpoint. The payment lands in the agent's own Safe; splits apply.
app.get("/review", purserPaywall({
  facilitatorUrl: \`\${process.env.PURSER_ENGINE_URL}/x402\`,
  payTo: process.env.AGENT_SAFE,
  asset: process.env.USDG_ADDRESS,
  price: "4500000",            // 4.50 USDG in base units
  tokenName: "Global Dollar",
}), (c) => c.json({ review: "..." }));`;

export const sellSample = `// Or let the engine run the paywall: the agent puts a service on sale.
const service = await purser.store.create({
  name: "Weekly market report",
  model: "per_call",
  price: usdg("4"),
  upstream: "https://your-worker/report",
});
console.log(service.endpoint); // buyers call this over x402`;

export const embedSample = `<script src="https://your-engine/embed.js"
        data-agent="0xTHE_AGENT_SAFE"
        data-amount="12.00"
        data-token="USDG" async></script>`;

export const webhookSample = `import { verifyWebhook } from "@purser/sdk";

// Every delivery is signed. Reject anything that does not verify.
const ok = await verifyWebhook(process.env.PURSER_WEBHOOK_SECRET, req.headers["purser-signature"], rawBody);
if (!ok) return res.status(401).end();

const event = JSON.parse(rawBody);
if (req.headers["purser-event"] === "intent.blocked") notifyOwner(event);`;

export const ownerSample = `// Owner actions come back as transactions to sign in the owner's wallet.
const owner = new Purser({ baseUrl: process.env.PURSER_ENGINE_URL, ownerToken });
const tx = await owner.owner.prepareFreeze(safe);      // { to, data, value }
await wallet.sendTransaction(tx);                      // MetaMask signs; Purser never does

const rules = await owner.owner.prepareRules(safe, {
  rules: [{ token: usdgAddress, rule: { daily: "25000000", maxSingle: "5000000" } }],
});                                                    // a Safe transaction to sign`;

export const apiSample = `GET  /v1/accounts/:safe            balances, rules, spent today, splits, guardian
POST /v1/pay                        pay from the account (agent key)
POST /v1/x402/fetch                 fetch a URL and pay its 402 (agent key)
POST /v1/chat/completions           OpenAI-compatible, paid from the account
GET  /v1/accounts/:safe/receipts    every payment in and out
GET  /v1/verdicts/:id               the firewall's verdict with its simulation
POST /v1/accounts/:safe/rules/prepare   a Safe transaction for the owner
GET  /v1/events                     live events (Server-Sent Events)
GET  /v1/economy                    network totals and the AI task price index`;

export const testModeSample = `# A local copy of Robinhood Chain, Purser deployed on it, the engine and three
# agents with real on-chain activity, in one command:
cd engine && npm run testmode            # a plain local chain
cd engine && npm run testmode -- --fork  # a fork of the live chain

# Or from anywhere in a checkout:
purser testmode --fork`;
