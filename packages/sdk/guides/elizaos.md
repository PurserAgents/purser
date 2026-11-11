# Purser with ElizaOS

Add a plugin with a pay action. The action reads the payee and amount from the message and lets Purser check it.

```ts
import type { Action, Plugin } from "@elizaos/core";
import { Purser, usdg } from "@purser/sdk";

const purser = new Purser({ baseUrl: process.env.PURSER_ENGINE_URL!, apiKey: process.env.PURSER_API_KEY });

const payAction: Action = {
  name: "PURSER_PAY",
  similes: ["PAY", "SEND_USDG"],
  description: "Pay an address in USDG from the agent's Purser account.",
  validate: async (_runtime, message) => /0x[0-9a-fA-F]{40}/.test(message.content.text ?? ""),
  handler: async (_runtime, message, _state, _options, callback) => {
    const text = message.content.text ?? "";
    const to = text.match(/0x[0-9a-fA-F]{40}/)![0];
    const amount = text.match(/(\d+(?:\.\d+)?)\s*USDG/i)?.[1] ?? "0";
    const r = await purser.pay({ to, amount: usdg(amount), trigger: text });
    await callback?.({ text: r.intent.status === "executed" ? `Paid ${r.intent.money?.display}.` : `Not paid: ${r.verdict.summary}` });
    return { success: r.intent.status === "executed" };
  },
};

export const purserPlugin: Plugin = { name: "purser", description: "A bank account for the agent", actions: [payAction] };
```

The whole message goes to Purser as the trigger, so a payment asked for by text the agent read (a page, an email)
is checked for hidden instructions. Check the `Action` signature against your ElizaOS version.

The full file is `packages/sdk/examples/elizaos.ts` in the repository.
