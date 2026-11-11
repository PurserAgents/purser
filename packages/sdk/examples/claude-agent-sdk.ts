// Example: Purser with claude-agent-sdk. Install the packages named in guides/claude-agent-sdk.md first.
// Not part of the SDK build.

import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Buy the latest market report from https://reports.example/x402/today if it costs under 1 USDG, then summarise it.",
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
