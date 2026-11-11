# Purser with the OpenAI Agents SDK

Wrap the Purser SDK calls the agent needs as tools.

```sh
npm install @openai/agents zod @purser/sdk
```

```ts
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
```

The agent's model calls can be paid from the same account: point any OpenAI-compatible client at the engine.

```ts
import OpenAI from "openai";
const models = new OpenAI({ baseURL: `${process.env.PURSER_ENGINE_URL}/v1`, apiKey: process.env.PURSER_API_KEY });
```

The model ids are the ones the owner set up for the account (`GET /v1/models`).

The full file is `packages/sdk/examples/openai-agents-sdk.ts` in the repository.
