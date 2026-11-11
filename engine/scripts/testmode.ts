/**
 * Test mode in one command: a local node (plain chain 4663, or a fork of Robinhood Chain with --fork), Purser
 * deployed on it, the engine serving the API, and a few seeded agents with real on-chain activity.
 *
 *   npm run testmode                 # local chain, port 8787
 *   npm run testmode -- --fork       # fork of the live chain (public node, or RPC_URL)
 *   npm run testmode -- --port 9000 --no-seed
 *   npm run testmode -- --light       # only the first three agents, no storefront, team, treasury or invoices
 *
 * Nothing is sent to the live chain: the engine only broadcasts to the local node it started.
 */
import { serve } from "@hono/node-server";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp } from "../src/api/app.ts";
import { ENGINE_ROOT } from "../src/config.ts";
import "../src/features.ts";
import { issueOwnerSession } from "../src/keys.ts";
import { seedNetworkActivity, seedTestActivity } from "../src/seed.ts";
import { startWorld } from "../src/world.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const value = (n: string) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const port = Number(value("--port") ?? process.env.PURSER_PORT ?? 8787);
const fork = flag("--fork") ? process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com" : undefined;
const dbPath = resolve(ENGINE_ROOT, "data", "testmode.sqlite");
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });

console.log(`Starting ${fork ? "a fork of Robinhood Chain" : "a local chain (id 4663)"}...`);
const world = await startWorld({ fork, dbPath, publicUrl: `http://localhost:${port}`, persist: true, nodePort: value("--node-port") ? Number(value("--node-port")) : undefined });
const app = buildApp(world.engine.ctx);
const server = serve({ fetch: app.fetch, port });
let seeded: Awaited<ReturnType<typeof seedTestActivity>> | null = null;
if (!flag("--no-seed")) {
  console.log("Seeding agents and activity...");
  seeded = await seedTestActivity(world.engine.ctx);
  if (!flag("--light")) {
    const call = async (method: string, path: string, body?: unknown, token?: string) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    await seedNetworkActivity(world.engine.ctx, call, seeded);
  }
}
world.engine.start();
const session = issueOwnerSession(world.engine.ctx, world.engine.ctx.chain.accounts.owner!.address);

console.log(`
Purser test mode is running.
  Engine API      http://localhost:${port}/v1/health
  Events (SSE)    http://localhost:${port}/v1/events
  Local node      ${world.node.url} (chain id 4663${fork ? ", forked" : ""})
  Module          ${world.dep.module}
  Factory         ${world.dep.factory}
  USDG            ${world.dep.usdg}${world.dep.mode === "local" ? " (test token)" : ""}
  Owner session   ${session.token}
${seeded ? `  Agents          ${seeded.research.name}  ${seeded.research.safe}  key ${seeded.research.apiKey}
                  ${seeded.seller.name}  ${seeded.seller.safe}  key ${seeded.seller.apiKey}
                  ${seeded.ops.name}  ${seeded.ops.safe}  key ${seeded.ops.apiKey}` : ""}
  Firewall demo   curl -X POST http://localhost:${port}/v1/demo/firewall/run -H 'content-type: application/json' -d '{"paceMs":1500}'

Press Ctrl-C to stop (the node and the engine stop together).`);

const stop = async () => {
  server.close();
  await world.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
