# Purser for LangChain

A bank account for your AI agent. The owner sets the rules, a firewall checks every payment, and the agent gets its own
account as tools. Made by [Purser](https://purseragents.fun).

```sh
npm install langchain @langchain/core @purseragents/langchain
```

```ts
import { createAgent } from "langchain";
import { purserTools } from "@purseragents/langchain";

const agent = createAgent({
  model: "anthropic:claude-sonnet-5-5",
  tools: purserTools({ apiKey: process.env.PURSER_API_KEY }),
});

await agent.invoke({ messages: [{ role: "user", content: "Pay the data vendor 2.50 USDG for today's report." }] });
```

`purserTools()` returns eight LangChain tools: `purser_account`, `purser_rules`, `purser_check_payment`, `purser_pay`,
`purser_receipts`, `purser_paid_fetch`, `purser_pay_invoice` and `purser_profit`. They work anywhere LangChain tools
do: `createAgent`, LangGraph's `ToolNode`, or `model.bindTools(tools)`. `new PurserToolkit({ apiKey }).getTools()`
gives the same tools for code that expects a toolkit.

Options: `readOnly: true` leaves out the tools that move money, `only: [...]` keeps the tools you name, and `baseUrl`
points at your own engine.

A payment the rules or the firewall refuse comes back to the model as "Blocked." with the reasons and "Nothing was
paid", never as an exception. LangChain agents that speak MCP can also use `@purseragents/mcp` directly.

## Getting a key

The owner opens an account for the agent on [purseragents.fun](https://purseragents.fun), sets its rules (limits per
payment, per day and per week, allowed payees, approvals) and creates an agent key for that one account. The key can
only do what the rules allow, and the owner can freeze the account or revoke the key at any time.

## Try it locally

Clone [PurserAgents/purser](https://github.com/PurserAgents/purser) and run `cd engine && npm run testmode`. It starts
a local chain with test money and prints an engine URL and agent keys; pass them as `baseUrl` and `apiKey`.

## License

MIT
