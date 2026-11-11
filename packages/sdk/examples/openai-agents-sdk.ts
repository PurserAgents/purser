// Example: Purser with openai-agents-sdk. Install the packages named in guides/openai-agents-sdk.md first.
// Not part of the SDK build.

import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { Purser, usdg } from "@purser/sdk";

const purser = new Purser({ baseUrl: process.env.PURSER_ENGINE_URL!, apiKey: process.env.PURSER_API_KEY });

const pay = tool({
  name: "pay",
  description: "Pay from the agent's Purser account. Rules and the firewall check it first.",
  parameters: z.object({ to: z.string(), amountUsdg: z.string(), memo: z.string(), context: z.string() }),
  execute: async ({ to, amountUsdg, memo, context }) => {
    const r = await purser.pay({ to, amount: usdg(amountUsdg), memo, trigger: context });
    return r.intent.status === "executed" ? `Paid. Receipt ${r.receipt?.id}.` : `${r.intent.status}: ${r.verdict.summary}`;
  },
});

const agent = new Agent({ name: "Researcher", instructions: "If a payment is blocked, tell the user why and stop.", tools: [pay] });
const result = await run(agent, "Pay 0.40 USDG to 0x... for yesterday's data feed.");
console.log(result.finalOutput);

import OpenAI from "openai";
const models = new OpenAI({ baseURL: `${process.env.PURSER_ENGINE_URL}/v1`, apiKey: process.env.PURSER_API_KEY });
