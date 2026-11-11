import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS accounts (
  safe TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom',
  owners TEXT NOT NULL DEFAULT '[]',
  agent TEXT,
  agent_id TEXT,
  public INTEGER NOT NULL DEFAULT 0,
  template TEXT,
  team_id TEXT,
  department_id TEXT,
  role TEXT,
  auto_freeze INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  safe TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  session_address TEXT,
  session_enc TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  safe TEXT NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  sigs TEXT,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  token TEXT,
  amount TEXT,
  to_addr TEXT,
  category TEXT NOT NULL,
  verdict_id TEXT,
  tx_hash TEXT,
  error TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS intents_safe ON intents(safe, created_at);
CREATE INDEX IF NOT EXISTS intents_digest ON intents(digest);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  uniq TEXT UNIQUE,
  safe TEXT NOT NULL,
  direction TEXT NOT NULL,
  category TEXT NOT NULL,
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  fee TEXT,
  usd_micro TEXT NOT NULL DEFAULT '0',
  counterparty TEXT NOT NULL,
  service TEXT,
  memo TEXT,
  status TEXT NOT NULL,
  tx_hash TEXT,
  intent_id TEXT,
  verdict_id TEXT,
  task_id TEXT,
  customer TEXT,
  model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_safe ON receipts(safe, created_at);
CREATE INDEX IF NOT EXISTS receipts_cp ON receipts(counterparty);

CREATE TABLE IF NOT EXISTS verdicts (
  id TEXT PRIMARY KEY,
  safe TEXT NOT NULL,
  intent_id TEXT,
  decision TEXT NOT NULL,
  summary TEXT NOT NULL,
  reasons TEXT NOT NULL,
  simulation TEXT,
  trigger_text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verdicts_safe ON verdicts(safe, created_at);

CREATE TABLE IF NOT EXISTS watch_events (
  id TEXT PRIMARY KEY,
  safe TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  action TEXT NOT NULL,
  tx_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  safe TEXT,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  signature TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY,
  safe TEXT NOT NULL,
  payee TEXT NOT NULL,
  token TEXT NOT NULL,
  rate TEXT NOT NULL,
  start INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  settled_until INTEGER NOT NULL,
  last_beat INTEGER NOT NULL,
  grace INTEGER NOT NULL,
  paid TEXT NOT NULL DEFAULT '0',
  stopped INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  safe TEXT NOT NULL,
  payee TEXT NOT NULL,
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  period INTEGER NOT NULL,
  next_due INTEGER NOT NULL,
  charges_left INTEGER NOT NULL,
  charged INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  safe TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  model TEXT NOT NULL,
  token TEXT NOT NULL,
  price TEXT NOT NULL,
  period INTEGER,
  upstream TEXT,
  response TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_usage (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  payer TEXT NOT NULL,
  amount TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 1,
  delivered INTEGER NOT NULL DEFAULT 1,
  refunded INTEGER NOT NULL DEFAULT 0,
  tx_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS split_labels (safe TEXT NOT NULL, address TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (safe, address));

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  payee TEXT NOT NULL,
  payer TEXT NOT NULL,
  arbiter TEXT,
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  description TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  review_period INTEGER NOT NULL,
  review_until INTEGER,
  status TEXT NOT NULL,
  job_id TEXT,
  delivery_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, treasury TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, daily_budget TEXT, token TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL, safe TEXT NOT NULL, department_id TEXT, role TEXT NOT NULL, daily_budget TEXT,
  PRIMARY KEY (team_id, safe)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL, safe TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, event TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, response_code INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, safe TEXT NOT NULL, kind TEXT NOT NULL, threshold TEXT, last_fired INTEGER, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS x402_settlements (
  id TEXT PRIMARY KEY, payer TEXT NOT NULL, pay_to TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL,
  nonce TEXT NOT NULL, resource TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, tx_hash TEXT, error TEXT, created_at INTEGER NOT NULL,
  UNIQUE (payer, nonce)
);
CREATE TABLE IF NOT EXISTS x402_services (
  url TEXT PRIMARY KEY, pay_to TEXT NOT NULL, name TEXT NOT NULL, asset TEXT, price TEXT, uses INTEGER NOT NULL DEFAULT 0,
  payers TEXT NOT NULL DEFAULT '[]', delivered INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  refunds INTEGER NOT NULL DEFAULT 0, last_used INTEGER
);

CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY, safe TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL, cost_micro TEXT NOT NULL, receipt_id TEXT, task_id TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_sets (safe TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, on_flag INTEGER NOT NULL, PRIMARY KEY (safe, kind, value));

CREATE TABLE IF NOT EXISTS seen_logs (uniq TEXT PRIMARY KEY);

CREATE TABLE IF NOT EXISTS owner_sessions (token TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function kvGet(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(db: DB, key: string, value: string) {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}
