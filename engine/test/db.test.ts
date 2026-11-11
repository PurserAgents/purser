import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { kvGet, kvSet, openDb } from "../src/db.ts";

const TABLES = [
  "kv", "accounts", "api_keys", "intents", "receipts", "verdicts", "watch_events", "audit", "streams", "subscriptions", "services",
  "service_usage", "split_labels", "invoices", "teams", "departments", "team_members", "webhooks", "webhook_deliveries", "alerts",
  "x402_settlements", "x402_services", "model_calls", "account_sets", "seen_logs", "owner_sessions", "auth_nonces",
];

describe("database (SQLite)", () => {
  const dir = mkdtempSync(join(tmpdir(), "purser-db-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("creates every table in memory", () => {
    const db = openDb(":memory:");
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of TABLES) assert.ok(names.includes(t), `table ${t}`);
    db.close();
  });

  it("kv: missing key is null, set inserts and then replaces", () => {
    const db = openDb(":memory:");
    assert.equal(kvGet(db, "index_cursor"), null);
    kvSet(db, "index_cursor", "10");
    assert.equal(kvGet(db, "index_cursor"), "10");
    kvSet(db, "index_cursor", "11");
    assert.equal(kvGet(db, "index_cursor"), "11");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM kv").get() as { n: number }).n, 1);
    db.close();
  });

  it("a file database creates its folder, uses WAL, and reopens with its data", () => {
    const path = join(dir, "nested", "deeper", "purser.sqlite");
    const db = openDb(path);
    assert.ok(existsSync(path));
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    kvSet(db, "audit_key", "0xabc");
    db.close();
    const again = openDb(path); // the schema is applied again without harm
    assert.equal(kvGet(again, "audit_key"), "0xabc");
    again.close();
  });

  it("constraints hold: unique receipt keys, unique API key hashes, one x402 nonce per payer, seen logs once", () => {
    const db = openDb(":memory:");
    const rc = db.prepare("INSERT OR IGNORE INTO receipts (id, uniq, safe, direction, category, token, amount, counterparty, status, created_at) VALUES (?, ?, 's', 'out', 'transfer', 't', '1', 'c', 'executed', 0)");
    assert.equal(rc.run("r1", "tx:0").changes, 1);
    assert.equal(rc.run("r2", "tx:0").changes, 0, "same log, no second receipt");
    const key = db.prepare("INSERT INTO api_keys (id, safe, name, prefix, hash, scopes, created_at) VALUES (?, 's', 'n', 'p', 'h', '[]', 0)");
    key.run("k1");
    assert.throws(() => key.run("k2"), /UNIQUE/);
    const x = db.prepare("INSERT INTO x402_settlements (id, payer, pay_to, asset, amount, nonce, kind, status, created_at) VALUES (?, 'p', 'q', 'a', '1', 'n1', 'exact', 'settled', 0)");
    x.run("x1");
    assert.throws(() => x.run("x2"), /UNIQUE/);
    const seen = db.prepare("INSERT OR IGNORE INTO seen_logs (uniq) VALUES (?)");
    assert.equal(seen.run("a:1").changes, 1);
    assert.equal(seen.run("a:1").changes, 0);
    db.close();
  });
});
