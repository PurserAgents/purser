# @purser/sdk

TypeScript SDK for Purser: a bank account for your AI agent, on Robinhood Chain.

```ts
import { Purser, usdg } from "@purser/sdk";

const purser = new Purser({ baseUrl: process.env.PURSER_ENGINE_URL!, apiKey: process.env.PURSER_API_KEY });
const r = await purser.pay({ to: "0x...", amount: usdg("2.50"), memo: "data report", trigger: "the request text" });
if (r.intent.status === "blocked") console.log(r.verdict.summary, r.verdict.reasons);
```

- Agent actions: `pay`, `checkPayment`, `x402Fetch`, `chat.completions.create`, `call`, `swap`, `streams`,
  `subscriptions`, `store`, `invoices`, `treasury`.
- Reading: `accounts.get/receipts/verdicts/approvals/pnl/exportCsv`, `directory`, `economy`, `leaderboard`, `audit`.
- Owner actions return transactions to sign with the owner's wallet: `owner.prepareRules`, `owner.prepareFreeze`, ...
- Live events: `purser.events(e => ..., { safe })` (Server-Sent Events).
- Webhooks: `verifyWebhook(secret, header, rawBody)`.
- Self-held agent keys: `signPayIntent` / `signCallIntent`, then `purser.submitIntent(...)`.
- Merchants: `@purser/sdk/merchant` has `purserPaywall` (Hono) and `purserPaywallExpress` for x402.
- The API types are in `@purser/sdk/schema`.

Guides for the Claude Agent SDK, the OpenAI Agents SDK, LangChain and ElizaOS are in `guides/`.

Purser is software, not a bank. It does not hold funds. Use it at your own risk.
