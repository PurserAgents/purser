# Plug Purser into your agent

Purser gives an agent its own account: the owner's Safe, the owner's rules, a firewall in front of every payment.
There are three ways in, and every framework below uses one of them.

| Way in | What the agent gets | Best for |
|---|---|---|
| MCP server (`@purser/mcp`) | Tools: `purser_account`, `purser_rules`, `purser_pay`, `purser_check_payment`, `purser_receipts`, `purser_x402_fetch`, `purser_sell`, `purser_services`, `purser_invoice`, `purser_pay_invoice`, `purser_pnl` | Any agent that speaks MCP |
| SDK (`@purser/sdk`) | The same actions as typed functions | Agents you write in TypeScript |
| Model proxy | An OpenAI-compatible `/v1/chat/completions`, paid from the account | Paying for models with the same key |

All three need two settings: the engine URL (`PURSER_ENGINE_URL`) and the agent's API key (`PURSER_API_KEY`,
created by the owner for one account). A payment the rules or the firewall refuse comes back as "blocked" with the
reasons; it is never sent. Tell your agent to report that to the user instead of trying again another way.

Guides:

- [Claude Agent SDK](./claude-agent-sdk.md)
- [OpenAI Agents SDK](./openai-agents-sdk.md)
- [LangChain](./langchain.md)
- [ElizaOS](./elizaos.md)

Try everything locally first: `cd engine && npm run testmode` prints an engine URL and agent keys for a local chain.
