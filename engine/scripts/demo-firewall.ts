/**
 * The firewall demo as a script: an agent with a real account gets a hidden instruction to drain its wallet and
 * the firewall blocks it. Starts its own local node (or --fork), runs the scenario, prints each step, stops.
 *
 *   npm run demo:firewall
 *   npm run demo:firewall -- --fork --pace 1500 --json
 *
 * The same scenario runs inside test mode at POST /v1/demo/firewall/run, with each step on the SSE stream.
 */
import "../src/features.ts";
import { runFirewallDemo } from "../src/demo.ts";
import { startWorld } from "../src/world.ts";

const args = process.argv.slice(2);
const fork = args.includes("--fork") ? process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com" : undefined;
const pace = args.indexOf("--pace") >= 0 ? Number(args[args.indexOf("--pace") + 1]) : 0;
const asJson = args.includes("--json");
process.env.PURSER_LOG = "0";

const world = await startWorld({ fork });
try {
  if (!asJson) world.engine.ctx.bus.subscribe((e) => {
    if (e.type !== "demo") return;
    const s = e.data as { step: number; title: string; detail: string; status: string };
    console.log(`\n${s.step}. ${s.title}  [${s.status.toUpperCase()}]\n   ${s.detail}`);
  });
  const result = await runFirewallDemo(world.engine.ctx, { paceMs: pace });
  if (asJson) console.log(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  else {
    const blocked = result.steps.filter((s) => s.status === "blocked");
    for (const b of blocked) {
      console.log(`\n   Why "${b.title}" was blocked:`);
      for (const r of (b.data?.reasons as { severity: string; title: string; detail: string }[]) ?? []) if (r.severity === "block") console.log(`   - ${r.title}: ${r.detail}`);
    }
  }
  const ok = result.steps.every((s) => s.status !== "error");
  process.exitCode = ok ? 0 : 1;
} finally {
  await world.stop();
}
