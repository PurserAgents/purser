# Plug Purser into your agent

Purser gives an agent its own account: the owner's Safe, the owner's rules, a firewall in front of every payment.
There are plugins for the big agent frameworks, and three ways in underneath them.

| Framework | Package | You get |
|---|---|---|
| Vercel AI SDK | `@purseragents/ai-sdk` | `purserTools()`, a ToolSet |
| LangChain and LangGraph | `@purseragents/langchain` | `purserTools()`, LangChain tools |
| ElizaOS | `@purseragents/plugin-purser` | `purserPlugin`, eight actions |

Every plugin has the same eight tools: account, rules, check a payment, pay, receipts, fetch a paid URL (x402), pay
an invoice, and profit and loss.

| Way in | What the agent gets | Best for |
|---|---|---|
| MCP server (`@purseragents/mcp`) | Tools: `purser_account`, `purser_rules`, `purser_pay`, `purser_check_payment`, `purser_receipts`, `purser_x402_fetch`, `purser_sell`, `purser_services`, `purser_invoice`, `purser_pay_invoice`, `purser_pnl` | Any agent that speaks MCP |
| SDK (`@purseragents/sdk`) | The same actions as typed functions | Agents you write in TypeScript |
| Model proxy | An OpenAI-compatible `/v1/chat/completions`, paid from the account | Paying for models with the same key |

All three need two settings: the engine URL (`PURSER_ENGINE_URL`) and the agent's API key (`PURSER_API_KEY`,
created by the owner for one account). A payment the rules or the firewall refuse comes back as "blocked" with the
reasons; it is never sent. Tell your agent to report that to the user instead of trying again another way.

Guides:

- [Claude Agent SDK](./claude-agent-sdk.md)
- [OpenAI Agents SDK](./openai-agents-sdk.md)
- [Vercel AI SDK](./vercel-ai-sdk.md)
- [LangChain](./langchain.md)
- [ElizaOS](./elizaos.md)

Try everything locally first: `cd engine && npm run testmode` prints an engine URL and agent keys for a local chain.
