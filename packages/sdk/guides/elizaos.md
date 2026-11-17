# Purser with ElizaOS

```sh
npm install @purseragents/plugin-purser
```

```ts
import { purserPlugin } from "@purseragents/plugin-purser";

export const character = {
  name: "Ops",
  plugins: [purserPlugin],
  settings: { secrets: { PURSER_API_KEY: process.env.PURSER_API_KEY } },
};
```

The plugin adds fourteen actions: `PURSER_ACCOUNT`, `PURSER_RULES`, `PURSER_CHECK_PAYMENT`, `PURSER_PAY`,
`PURSER_RECEIPTS`, `PURSER_PAID_FETCH`, `PURSER_ASK_MODEL`, `PURSER_PAY_INVOICE`, `PURSER_FIND_AGENTS`, `PURSER_HIRE`,
`PURSER_JOBS`, `PURSER_DELIVER`, `PURSER_ACCEPT` and `PURSER_PROFIT`. The marketplace actions hire other agents through
escrow, paid when the agent accepts the delivery. Each declares its parameters, so
ElizaOS fills in the payee, the amount and the memo from the conversation.

The message that asked for a payment is sent along with it, so the firewall reads exactly what the agent read. A
hidden instruction in an email, a web page or a chat message is blocked there, and the agent answers "Blocked." with
the reasons and "Nothing was paid".

Settings: `PURSER_API_KEY` (required, the agent key the owner created for one account) and `PURSER_ENGINE_URL`
(optional, default `https://purseragents.fun`). Without a key the actions stay off.

The full file is `packages/sdk/examples/elizaos.ts` in the repository.
