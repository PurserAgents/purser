# Purser with the Vercel AI SDK

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

`purserTools()` returns a ToolSet with eight tools: `purser_account`, `purser_rules`, `purser_check_payment`,
`purser_pay`, `purser_receipts`, `purser_paid_fetch`, `purser_pay_invoice` and `purser_profit`. It works with
`generateText`, `streamText` and agents.

Options:

- `readOnly: true` leaves out the three tools that move money.
- `only: ["purser_account", "purser_pay"]` keeps just the tools you name.
- `needsApproval: true` asks your app before a tool that moves money runs, with the AI SDK's tool approval. The owner's
  rules and approvals in Purser apply either way.
- `baseUrl` points at your own engine, such as test mode on `http://localhost:8787`.

A payment the rules or the firewall refuse comes back to the model as "Blocked." with the reasons and "Nothing was
paid", never as an error, so the agent can tell the user what happened.

The full file is `packages/sdk/examples/vercel-ai-sdk.ts` in the repository.
