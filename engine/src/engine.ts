import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { makeAudit } from "./audit.ts";
import { makeBus } from "./bus.ts";
import { makeChain } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Ctx } from "./ctx.ts";
import { kvGet, kvSet, openDb } from "./db.ts";
import { indexOnce } from "./indexer.ts";
import { makeTokens } from "./tokens.ts";

export interface Engine {
  ctx: Ctx;
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

type Task = { name: string; every: number; run: (ctx: Ctx) => Promise<unknown> };
const tasks: Task[] = [];

/** Features register periodic work here (indexer, stream settlement, subscriptions, webhooks, watchdog). */
export function registerTask(t: Task) {
  if (!tasks.some((x) => x.name === t.name)) tasks.push(t);
}

export function createEngine(cfg: Config): Engine {
  const db = openDb(cfg.dbPath);
  const chain = makeChain(cfg);
  let auditKey = cfg.keys?.audit;
  if (!auditKey) {
    auditKey = (kvGet(db, "audit_key") as Hex | null) ?? generatePrivateKey();
    kvSet(db, "audit_key", auditKey);
  }
  const ctx: Ctx = {
    cfg,
    db,
    chain,
    dep: cfg.deployment,
    tokens: makeTokens(chain.pub, cfg.deployment),
    audit: makeAudit(db, privateKeyToAccount(auditKey)),
    bus: makeBus(),
    hooks: { afterExecuted: [] },
  };
  registerTask({ name: "indexer", every: cfg.indexIntervalMs, run: (c) => (c.dep ? indexOnce(c) : Promise.resolve(0)) });

  const timers: NodeJS.Timeout[] = [];
  const running = new Set<string>();
  async function runTask(t: Task) {
    if (running.has(t.name)) return;
    running.add(t.name);
    try {
      await t.run(ctx);
    } catch (e) {
      if (process.env.PURSER_LOG !== "0") console.error(`[${t.name}]`, (e as Error).message?.split("\n")[0]);
    } finally {
      running.delete(t.name);
    }
  }
  return {
    ctx,
    start() {
      for (const t of tasks) timers.push(setInterval(() => void runTask(t), t.name === "indexer" ? cfg.indexIntervalMs : t.every));
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
    async tick() {
      for (const t of tasks) await runTask(t);
    },
  };
}
