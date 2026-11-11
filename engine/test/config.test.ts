import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ENGINE_ROOT, liveReadOnly, loadConfig, REPO_ROOT, VERSION } from "../src/config.ts";

describe("config (pure)", () => {
  const dir = mkdtempSync(join(tmpdir(), "purser-config-"));
  const missing = join(dir, "missing.json");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults: local node, chain 4663, port 8787, no test mode", () => {
    const c = loadConfig({ PURSER_DEPLOYMENT: missing, PURSER_KEYS: missing });
    assert.deepEqual(c.rpcUrls, ["http://127.0.0.1:8545"]);
    assert.equal(c.chainId, 4663);
    assert.equal(c.port, 8787);
    assert.equal(c.publicUrl, "http://localhost:8787");
    assert.equal(c.testMode, false);
    assert.equal(c.deployment, null);
    assert.equal(c.keys, null);
    assert.equal(c.indexIntervalMs, 2000);
    assert.equal(c.schedulerIntervalMs, 15000);
    assert.equal(c.defaultTokenName, "USDG");
    assert.ok(c.dbPath.startsWith(ENGINE_ROOT));
    assert.ok(ENGINE_ROOT.startsWith(REPO_ROOT));
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  });

  it("reads the environment: RPC with fallbacks, port, test mode, intervals", () => {
    const c = loadConfig({
      PURSER_RPC_URL: "http://127.0.0.1:9545",
      PURSER_RPC_FALLBACK_URLS: " http://127.0.0.1:9546 , ,http://127.0.0.1:9547",
      PURSER_PORT: "9000",
      PURSER_TEST_MODE: "1",
      PURSER_CHAIN_ID: "31337",
      PURSER_DB: join(dir, "x.sqlite"),
      PURSER_INDEX_INTERVAL_MS: "500",
      PURSER_SCHEDULER_INTERVAL_MS: "700",
      PURSER_DEPLOYMENT: missing,
      PURSER_KEYS: missing,
    });
    assert.deepEqual(c.rpcUrls, ["http://127.0.0.1:9545", "http://127.0.0.1:9546", "http://127.0.0.1:9547"]);
    assert.equal(c.port, 9000);
    assert.equal(c.publicUrl, "http://localhost:9000");
    assert.equal(c.testMode, true);
    assert.equal(c.chainId, 31337);
    assert.equal(c.dbPath, join(dir, "x.sqlite"));
    assert.equal(c.indexIntervalMs, 500);
    assert.equal(c.schedulerIntervalMs, 700);
    assert.equal(loadConfig({ PURSER_TEST_MODE: "true", PURSER_DEPLOYMENT: missing, PURSER_KEYS: missing }).testMode, false, "only 1 turns test mode on");
  });

  it("loads the deployment and keys files named in the environment; overrides win", () => {
    const depPath = join(dir, "deployment.json");
    const keysPath = join(dir, "keys.json");
    writeFileSync(depPath, JSON.stringify({ chainId: 4663, mode: "local", module: "0x0000000000000000000000000000000000000001" }));
    writeFileSync(keysPath, JSON.stringify({ relayer: "0x01" }));
    const c = loadConfig({ PURSER_DEPLOYMENT: depPath, PURSER_KEYS: keysPath, PURSER_PUBLIC_URL: "https://engine.example" }, { port: 1234, testMode: true });
    assert.equal(c.deployment?.module, "0x0000000000000000000000000000000000000001");
    assert.equal(c.keys?.relayer, "0x01");
    assert.equal(c.publicUrl, "https://engine.example");
    assert.equal(c.port, 1234);
    assert.equal(c.testMode, true);
  });

  it("a broken deployment file is an error, not a silent default", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    assert.throws(() => loadConfig({ PURSER_DEPLOYMENT: bad, PURSER_KEYS: missing }), SyntaxError);
  });

  it("read-only live defaults point at chain 4663's public RPC", () => {
    assert.match(liveReadOnly.rpc, /^https:\/\/rpc\.mainnet\.chain\.robinhood\.com/);
    assert.match(liveReadOnly.addresses.safeSingleton, /^0x[0-9a-fA-F]{40}$/);
  });
});
