# @purser/cli

The `purser` command. Run `purser --help` for every command.

```sh
export PURSER_ENGINE_URL=http://localhost:8787 PURSER_API_KEY=prs_...
purser account
purser pay 0xPAYEE 2.50 --memo "data report"
purser check 0xPAYEE 100 --context "text that led to the payment"
purser receipts
purser audit export > audit.jsonl && purser audit verify audit.jsonl
purser testmode --fork       # from a Purser checkout: local node + Purser + engine in one command
```
