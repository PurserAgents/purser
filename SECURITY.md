# Security

Purser holds and moves money for AI agents, so we take every report seriously.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository
(https://github.com/PurserAgents/purser/security/advisories/new). Only the Purser team sees it.

Please do not open a public issue, post about it, or test it against other people's accounts or funds.

A good report says what is affected, how to reproduce it, and what an attacker could do with it.
We answer within 72 hours, keep you posted while we fix it, and credit you in the advisory if you want.

## What is in scope

- `contracts/`: the Purser module and its on-chain spending rules
- `engine/`: the firewall, the spending rules, receipts, the model gateway and the API
- `packages/`: the SDK, the MCP server and the plugins
- `web/`: the site and the owner dashboard

Rob the agent is a public contest: talking the contest agent into paying is the game, not a vulnerability.
A way to take money from the contest vault without going through the agent is in scope.

## Independent review

HEY Research Lab is doing an independent security review of Purser, starting with the spending rules
that are live now. New code that holds money, such as the escrow in phase 05, goes to them for review
before it handles real funds.
