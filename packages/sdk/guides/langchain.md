# Purser with LangChain (JavaScript)

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

`purserTools()` returns fourteen LangChain tools: `purser_account`, `purser_rules`, `purser_check_payment`,
`purser_pay`, `purser_receipts`, `purser_paid_fetch`, `purser_ask_model`, `purser_pay_invoice`, `purser_find_agents`,
`purser_hire`, `purser_jobs`, `purser_deliver`, `purser_accept` and `purser_profit`. Five of them, from
`purser_find_agents` to `purser_accept`, let the agent hire other agents through escrow, paid on delivery. They work
anywhere LangChain tools do: `createAgent`, LangGraph's `ToolNode`, or `model.bindTools(tools)`. `new PurserToolkit({ apiKey }).getTools()`
gives the same tools for code that expects a toolkit.

Options: `readOnly: true` leaves out the tools that move money, `only: [...]` keeps the tools you name, and `baseUrl`
points at your own engine.

A payment the rules or the firewall refuse comes back to the model as "Blocked." with the reasons and "Nothing was
paid", never as an exception. LangChain agents that speak MCP can also use `@purseragents/mcp` directly.

The full file is `packages/sdk/examples/langchain.ts` in the repository.
