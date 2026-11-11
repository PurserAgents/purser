#!/usr/bin/env node
/**
 * purser: the command line for Purser.
 *
 *   purser health
 *   purser me                                  (needs PURSER_API_KEY)
 *   purser account [safe]                      balances, today's spending, rules
 *   purser accounts [--owner 0x...]
 *   purser pay <to> <amount> [--token ETH] [--memo text] [--service id] [--context text]
 *   purser check <to> <amount> [--context text]
 *   purser receipts [safe] [--limit 20] [--direction in|out]
 *   purser verdicts [safe] [--blocked]
 *   purser approvals [safe]
 *   purser pnl [safe]
 *   purser export [safe] > receipts.csv
 *   purser templates
 *   purser audit export > audit.jsonl
 *   purser audit verify <file> [--signer 0x...]
 *   purser demo firewall [--pace 1500]         (engine in test mode)
 *   purser testmode [--fork] [--port 8787]     (from a Purser checkout: starts a local node, Purser and the engine)
 *
 * Settings: --engine <url> or PURSER_ENGINE_URL (default http://localhost:8787), --key or PURSER_API_KEY,
 * --owner-token or PURSER_OWNER_TOKEN. Amounts are whole units ("2.50"), not base units.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Purser, PurserError, type PayResult, type Verdict } from "@purser/sdk";
import { formatUnits, parseUnits } from "viem";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    engine: { type: "string" },
    key: { type: "string" },
    "owner-token": { type: "string" },
    token: { type: "string", default: "USDG" },
    memo: { type: "string" },
    service: { type: "string" },
    context: { type: "string" },
    limit: { type: "string" },
    direction: { type: "string" },
    owner: { type: "string" },
    signer: { type: "string" },
    pace: { type: "string" },
    port: { type: "string" },
    fork: { type: "boolean" },
    blocked: { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const purser = new Purser({
  baseUrl: flags.engine ?? process.env.PURSER_ENGINE_URL ?? "http://localhost:8787",
  apiKey: flags.key ?? process.env.PURSER_API_KEY,
  ownerToken: flags["owner-token"] ?? process.env.PURSER_OWNER_TOKEN,
});

const out = (s: string): void => {
  process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
};
const asJson = (v: unknown): void => out(JSON.stringify(v, null, 2));
const date = (t: number) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16);

async function safeArg(i: number): Promise<string> {
  return positionals[i] ?? (await purser.me()).safe;
}

async function tokenOf(symbol: string) {
  const cfg = await purser.config();
  const t = (cfg.tokens as { address: string; symbol: string; decimals: number }[]).find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
  if (!t) throw new Error(`unknown token ${symbol}`);
  return t;
}

function showVerdict(v: Verdict) {
  out(v.summary);
  for (const r of v.reasons) if (r.severity !== "info") out(`  ${r.severity === "block" ? "x" : "!"} ${r.title}: ${r.detail}`);
}

function showPay(r: PayResult) {
  out(`${r.intent.status.toUpperCase()}  ${r.intent.summary}`);
  if (r.intent.txHash) out(`  transaction ${r.intent.txHash}`);
  if (r.receipt) out(`  receipt ${r.receipt.id}${r.receipt.fee ? `, fee ${r.receipt.fee.display}` : ""}`);
  if (r.intent.status !== "executed") showVerdict(r.verdict);
}

const commands: Record<string, () => Promise<void>> = {
  async health() {
    const h = await purser.health();
    flags.json ? asJson(h) : out(`${h.ok ? "OK" : "DOWN"}  chain ${h.chainId}, block ${h.block}, mode ${h.mode}, broadcast ${h.broadcast ? "local node only" : "off"}`);
  },
  async me() {
    const m = await purser.me();
    flags.json ? asJson(m) : out(`account ${m.safe}\nkey ${m.key.prefix}... scopes ${m.key.scopes.join(", ")}\nsession key ${m.sessionAddress ?? "kept by the agent"}`);
  },
  async account() {
    const a = await purser.accounts.get(await safeArg(1));
    if (flags.json) return asJson(a);
    out(`${a.name}  ${a.safe}${a.frozen ? "  FROZEN" : ""}`);
    out(`owners ${a.owners.join(", ")} (threshold ${a.threshold}), agent key ${a.config.agent}`);
    for (const b of a.balances) out(`balance ${b.display}`);
    for (const s of a.spentToday) out(`spent today ${s.display}${s.remaining !== null ? `, left ${formatUnits(BigInt(s.remaining), s.token.decimals)} ${s.token.symbol}` : ""}`);
    out(`firewall ${a.config.firewall ? "on" : "off"}, watchdog ${a.config.watchdog ? "on" : "off"}, pending approvals ${a.pendingApprovals}`);
  },
  async accounts() {
    const r = await purser.accounts.list(flags.owner);
    if (flags.json) return asJson(r);
    for (const a of r.items) out(`${a.safe}  ${a.name.padEnd(28)} spent today $${a.spentTodayUsd.padStart(8)}  earned $${a.earnedTodayUsd.padStart(8)}${a.frozen ? "  FROZEN" : ""}`);
  },
  async pay() {
    const [, to, amount] = positionals;
    if (!to || !amount) throw new Error("usage: purser pay <to> <amount>");
    const t = await tokenOf(flags.token!);
    const r = await purser.pay({ to, amount: parseUnits(amount, t.decimals), token: t.address, memo: flags.memo, service: flags.service, trigger: flags.context });
    flags.json ? asJson(r) : showPay(r);
    if (r.intent.status === "blocked") process.exitCode = 3;
  },
  async check() {
    const [, to, amount] = positionals;
    if (!to || !amount) throw new Error("usage: purser check <to> <amount>");
    const t = await tokenOf(flags.token!);
    const v = await purser.checkPayment({ to, amount: parseUnits(amount, t.decimals), token: t.address, service: flags.service, trigger: flags.context });
    flags.json ? asJson(v) : showVerdict(v);
    if (v.decision === "block") process.exitCode = 3;
  },
  async receipts() {
    const r = await purser.accounts.receipts(await safeArg(1), { limit: flags.limit ? Number(flags.limit) : 20, direction: flags.direction as "in" | "out" | undefined });
    if (flags.json) return asJson(r);
    for (const x of r.items) out(`${date(x.createdAt)}  ${x.direction === "in" ? "+" : "-"}${x.money.display.padEnd(16)} ${x.category.padEnd(12)} ${(x.counterpartyName ?? x.counterparty).slice(0, 42).padEnd(42)} ${x.memo ?? ""}`);
  },
  async verdicts() {
    const r = await purser.accounts.verdicts(await safeArg(1), { decision: flags.blocked ? "block" : undefined, limit: flags.limit ? Number(flags.limit) : 20 });
    if (flags.json) return asJson(r);
    for (const v of r.items) out(`${date(v.createdAt)}  ${v.decision.toUpperCase().padEnd(5)}  ${v.summary}`);
  },
  async approvals() {
    const r = await purser.accounts.approvals(await safeArg(1));
    if (flags.json) return asJson(r);
    if (!r.items.length) out("Nothing waits for approval.");
    for (const a of r.items) out(`${a.id}  ${a.summary}  digest ${a.digest}`);
  },
  async pnl() {
    const p = await purser.accounts.pnl(await safeArg(1));
    if (flags.json) return asJson(p);
    out(`income $${p.incomeUsd}  spend $${p.spendUsd}  fees $${p.feesUsd}  profit $${p.profitUsd}  (last 30 days)`);
    for (const l of p.byModel.slice(0, 5)) out(`  model ${l.label}: $${l.spend}`);
    for (const l of p.byCustomer.slice(0, 5)) out(`  customer ${l.label}: $${l.income}`);
  },
  async export() {
    out(await purser.accounts.exportCsv(await safeArg(1)));
  },
  async templates() {
    const t = await purser.templates();
    if (flags.json) return asJson(t);
    for (const x of t.items) out(`${x.id.padEnd(10)} ${x.name.padEnd(22)} ${x.highlights.join(", ")}`);
  },
  async audit() {
    const sub = positionals[1];
    if (sub === "export") return out(await purser.audit.export());
    if (sub === "verify") {
      const file = positionals[2];
      if (!file) throw new Error("usage: purser audit verify <file> [--signer 0x...]");
      const r = await purser.audit.verify(readFileSync(file, "utf8"), flags.signer);
      out(r.ok ? `OK: ${r.entries} entries, hash chain intact, all signed by ${r.signer}.` : `FAILED at entry ${r.brokenAt}: ${r.problem}.`);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    const r = await purser.audit.list({ limit: flags.limit ? Number(flags.limit) : 20 });
    for (const e of r.items) out(`${e.seq}  ${date(e.ts)}  ${e.actor.padEnd(28)} ${e.action}`);
  },
  async demo() {
    if (positionals[1] !== "firewall") throw new Error("usage: purser demo firewall [--pace ms]");
    const r = await purser.demo.runFirewall(flags.pace ? Number(flags.pace) : 0);
    if (flags.json) return asJson(r);
    for (const s of r.steps) out(`${s.step}. ${s.title}  [${s.status.toUpperCase()}]\n   ${s.detail}`);
  },
  async testmode() {
    const here = dirname(fileURLToPath(import.meta.url));
    const engine = [resolve(here, "../../../engine"), resolve(process.cwd(), "engine")].find((p) => existsSync(resolve(p, "scripts/testmode.ts")));
    if (!engine) throw new Error("Run this from a Purser checkout (it starts engine/scripts/testmode.ts).");
    const args = ["tsx", "scripts/testmode.ts", ...(flags.fork ? ["--fork"] : []), ...(flags.port ? ["--port", flags.port] : [])];
    const child = spawn("npx", args, { cwd: engine, stdio: "inherit" });
    await new Promise((r) => child.on("exit", r));
  },
};

async function main() {
  const cmd = positionals[0];
  if (!cmd || flags.help || !commands[cmd]) {
    out(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*\n/, "").replace(/^ \* ?/gm, ""));
    if (cmd && !commands[cmd]) process.exitCode = 2;
    return;
  }
  await commands[cmd]();
}

main().catch((e) => {
  if (e instanceof PurserError) process.stderr.write(`error ${e.status} ${e.code}: ${e.message}\n`);
  else process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
