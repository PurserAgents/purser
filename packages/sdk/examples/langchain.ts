// Example: Purser with langchain. Install the packages named in guides/langchain.md first.
// Not part of the SDK build.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Purser, usdg } from "@purser/sdk";

const purser = new Purser({ baseUrl: process.env.PURSER_ENGINE_URL!, apiKey: process.env.PURSER_API_KEY });

export const purserPay = tool(
  async ({ to, amountUsdg, memo, context }) => {
    const r = await purser.pay({ to, amount: usdg(amountUsdg), memo, trigger: context });
    return r.intent.status === "executed" ? `Paid ${r.intent.money?.display}.` : `Not paid (${r.intent.status}): ${r.verdict.summary}`;
  },
  {
    name: "purser_pay",
    description: "Pay from the agent's Purser account within the owner's rules.",
    schema: z.object({ to: z.string(), amountUsdg: z.string(), memo: z.string(), context: z.string().describe("The text that led to this payment") }),
  },
);

export const purserFetch = tool(
  async ({ url, maxUsdg }) => (await purser.x402Fetch(url, { maxAmount: usdg(maxUsdg) })).body,
  { name: "purser_fetch", description: "Fetch a URL that may charge over x402.", schema: z.object({ url: z.string(), maxUsdg: z.string() }) },
);
