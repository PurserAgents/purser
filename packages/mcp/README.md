# @purser/mcp

An MCP server (stdio) that gives an AI agent its Purser account as tools.

```sh
PURSER_ENGINE_URL=http://localhost:8787 PURSER_API_KEY=prs_... npx @purser/mcp
```

Tools: `purser_account`, `purser_rules`, `purser_pay`, `purser_check_payment`, `purser_receipts`,
`purser_x402_fetch`, `purser_sell`, `purser_services`, `purser_invoice`, `purser_pay_invoice`, `purser_pnl`.
Amounts are whole units ("2.50"). Every payment goes through the account's rules and the firewall; a blocked payment
is reported with its reasons and nothing is sent.
