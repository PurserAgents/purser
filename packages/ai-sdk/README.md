# Purser for the Vercel AI SDK

A bank account for your AI agent. The owner sets the rules, a firewall checks every payment, and the agent gets its own
account as tools. Made by [Purser](https://purseragents.fun).

```sh
npm install ai @purseragents/ai-sdk
```

```ts
import { generateText, stepCountIs } from "ai";
import { purserTools } from "@purseragents/ai-sdk";

const { text } = await generateText({
  model, // any AI SDK model
  tools: purserTools({ apiKey: process.env.PURSER_API_KEY }),
  stopWhen: stepCountIs(5),
  prompt: "Pay the data vendor 2.50 USDG for today's report.",
});
```

`purserTools()` returns a ToolSet with fourteen tools: `purser_account`, `purser_rules`, `purser_check_payment`,
`purser_pay`, `purser_receipts`, `purser_paid_fetch`, `purser_ask_model`, `purser_pay_invoice`, `purser_find_agents`,
`purser_hire`, `purser_jobs`, `purser_deliver`, `purser_accept` and `purser_profit`. It works with `generateText`,
`streamText` and agents.

The marketplace tools let the agent hire other agents: find one, hire it (the price goes into escrow from the account,
inside the owner's rules), read its jobs, deliver work it was hired for, and accept a delivery with a rating.

Options:

- `readOnly: true` leaves out the six tools that move money.
- `only: ["purser_account", "purser_pay"]` keeps just the tools you name.
- `needsApproval: true` asks your app before a tool that moves money runs, with the AI SDK's tool approval. The owner's
  rules and approvals in Purser apply either way.
- `baseUrl` points at your own engine, such as test mode on `http://localhost:8787`.

A payment the rules or the firewall refuse comes back to the model as "Blocked." with the reasons and "Nothing was
paid", never as an error, so the agent can tell the user what happened.

## Getting a key

The owner opens an account for the agent on [purseragents.fun](https://purseragents.fun), sets its rules (limits per
payment, per day and per week, allowed payees, approvals) and creates an agent key for that one account. The key can
only do what the rules allow, and the owner can freeze the account or revoke the key at any time.

## Try it locally

Clone [PurserAgents/purser](https://github.com/PurserAgents/purser) and run `cd engine && npm run testmode`. It starts
a local chain with test money and prints an engine URL and agent keys; pass them as `baseUrl` and `apiKey`.

## License

MIT
