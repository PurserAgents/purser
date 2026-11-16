// Example: Purser with LangChain. Install the packages named in guides/langchain.md first.
// Not part of the SDK build.

import { createAgent } from "langchain";
import { purserTools } from "@purseragents/langchain";

export const agent = createAgent({
  model: "anthropic:claude-sonnet-5-5",
  tools: purserTools({ apiKey: process.env.PURSER_API_KEY }),
});

// await agent.invoke({ messages: [{ role: "user", content: "Pay the data vendor 2.50 USDG for today's report." }] });
