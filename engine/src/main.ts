import { serve } from "@hono/node-server";
import { buildApp } from "./api/app.ts";
import { loadConfig } from "./config.ts";
import { createEngine } from "./engine.ts";
import "./features.ts";

const cfg = loadConfig();
const engine = createEngine(cfg);
const app = buildApp(engine.ctx);
engine.start();
const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`Purser engine on http://localhost:${info.port} (chain ${cfg.chainId}, ${cfg.deployment ? cfg.deployment.mode : "no deployment"}, broadcast ${engine.ctx.chain.broadcast ? "local only" : "off"})`);
});
const shutdown = () => {
  engine.stop();
  server.close();
  engine.ctx.db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
