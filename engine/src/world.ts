import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { ENGINE_ROOT, loadConfig, type Config, type Deployment, type EngineKeys } from "./config.ts";
import { deployLocal, newKeys } from "./deploy.ts";
import { createEngine, type Engine } from "./engine.ts";

/** A local node (anvil) for test mode: a plain chain with id 4663, or a fork of Robinhood Chain. */
export interface LocalNode {
  url: string;
  proc: ChildProcess;
  stop(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

export async function startNode(opts: { fork?: string; port?: number } = {}): Promise<LocalNode> {
  const port = opts.port ?? (await freePort());
  const args = ["--port", String(port), "--chain-id", "4663", "--silent", "--hardfork", "osaka"];
  if (opts.fork) args.push("--fork-url", opts.fork, "--no-storage-caching");
  const bin = resolve(process.env.HOME ?? "", ".foundry/bin/anvil");
  const proc = spawn("nice", [bin, ...args], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) break;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    proc,
    stop: () =>
      new Promise<void>((res) => {
        if (proc.exitCode !== null) return res();
        proc.once("exit", () => res());
        proc.kill("SIGTERM");
      }),
  };
}

export interface World {
  node: LocalNode;
  dep: Deployment;
  keys: EngineKeys;
  cfg: Config;
  engine: Engine;
  stop(): Promise<void>;
}

/** Starts a node, deploys Purser, and creates an engine in test mode. Writes data/deployment.json + keys.json when `persist`. */
export async function startWorld(opts: { fork?: string; dbPath?: string; publicUrl?: string; persist?: boolean; nodePort?: number } = {}): Promise<World> {
  const node = await startNode({ fork: opts.fork, port: opts.nodePort });
  const keys = newKeys(true);
  const dep = await deployLocal({ rpcUrl: node.url, mode: opts.fork ? "fork" : "local", keys });
  if (opts.persist) {
    const dir = resolve(ENGINE_ROOT, "data");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "deployment.json"), JSON.stringify(dep, null, 2));
    writeFileSync(resolve(dir, "keys.json"), JSON.stringify(keys, null, 2), { mode: 0o600 });
  }
  const cfg = loadConfig(process.env, { rpcUrls: [node.url], dbPath: opts.dbPath ?? ":memory:", deployment: dep, keys, testMode: true, ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}) });
  const engine = createEngine(cfg);
  return {
    node,
    dep,
    keys,
    cfg,
    engine,
    async stop() {
      engine.stop();
      engine.ctx.db.close();
      await node.stop();
    },
  };
}
