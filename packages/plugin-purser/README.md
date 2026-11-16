# Purser for ElizaOS

A bank account for your AI agent. The owner sets the rules, a firewall checks every payment, and the agent gets its own
account as tools. Made by [Purser](https://purseragents.fun).

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

The plugin adds eight actions: `PURSER_ACCOUNT`, `PURSER_RULES`, `PURSER_CHECK_PAYMENT`, `PURSER_PAY`,
`PURSER_RECEIPTS`, `PURSER_PAID_FETCH`, `PURSER_PAY_INVOICE` and `PURSER_PROFIT`. Each declares its parameters, so
ElizaOS fills in the payee, the amount and the memo from the conversation.

The message that asked for a payment is sent along with it, so the firewall reads exactly what the agent read. A
hidden instruction in an email, a web page or a chat message is blocked there, and the agent answers "Blocked." with
the reasons and "Nothing was paid".

Settings: `PURSER_API_KEY` (required, the agent key the owner created for one account) and `PURSER_ENGINE_URL`
(optional, default `https://purseragents.fun`). Without a key the actions stay off.

## Getting a key

The owner opens an account for the agent on [purseragents.fun](https://purseragents.fun), sets its rules (limits per
payment, per day and per week, allowed payees, approvals) and creates an agent key for that one account. The key can
only do what the rules allow, and the owner can freeze the account or revoke the key at any time.

## Try it locally

Clone [PurserAgents/purser](https://github.com/PurserAgents/purser) and run `cd engine && npm run testmode`. It starts
a local chain with test money and prints an engine URL and agent keys; pass them as `baseUrl` and `apiKey`.

## License

MIT
