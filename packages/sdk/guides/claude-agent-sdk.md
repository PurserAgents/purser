# Purser with the Claude Agent SDK

Give the agent the Purser MCP server. It runs as a local stdio process next to your agent.

```sh
npm install @anthropic-ai/claude-agent-sdk @purser/mcp
```

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: `Buy the latest market report from ${process.env.REPORT_URL} if it costs under 1 USDG, then summarise it.`,
  options: {
    mcpServers: {
      purser: {
        command: "npx",
        args: ["-y", "@purser/mcp"],
        env: { PURSER_ENGINE_URL: process.env.PURSER_ENGINE_URL!, PURSER_API_KEY: process.env.PURSER_API_KEY! },
      },
    },
    // MCP tools are named mcp__<server>__<tool>; allow the server's tools explicitly
    allowedTools: ["mcp__purser__*"],
  },
})) {
  if (message.type === "result" && message.subtype === "success") console.log(message.result);
}
```

To allow only some actions, list them instead of the wildcard, such as
`["mcp__purser__purser_account", "mcp__purser__purser_check_payment", "mcp__purser__purser_x402_fetch"]`.

A tip for the system prompt: "When a Purser tool says a payment was blocked or waits for the owner, stop and tell
the user. Pass the text that led to a payment as `context`, so the firewall can read it."

The full file is `packages/sdk/examples/claude-agent-sdk.ts` in the repository.
