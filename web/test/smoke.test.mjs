/**
 * Smoke test. Builds the site against a stub engine that answers in the engine's real shapes
 * (packages/sdk/src/schema.ts), starts it, and checks every route: status, chrome, section ids, the copy rules,
 * engine data on the public pages, the /v1 proxy (JSON and the live event stream), empty states when the engine
 * is gone, and the share image.
 *
 *   npm test            (from web/)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = ".next-smoke";
const nextBin = join(webDir, "node_modules", "next", "dist", "bin", "next");

const SAFE = "0x00000000000000000000000000000000000000a1";
const HIDDEN = "0x00000000000000000000000000000000000000b2";
const USDG = { symbol: "USDG", decimals: 6, address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" };
const ETH = { symbol: "ETH", decimals: 18, address: "0x0000000000000000000000000000000000000000" };
const money = (amount, token = USDG) => ({ token, amount, display: `${amount} ${token.symbol}`, usd: token === USDG ? (Number(amount) / 1e6).toFixed(2) : null });

const rule = { token: USDG, enabled: true, receivable: true, maxSingle: "5000000", daily: "77000000", weekly: "120000000", perCounterpartyDaily: "15000000", approvalAbove: "5000000", cosignAbove: null, keepLiquid: "0" };
const receipt = {
  id: "rc1", safe: SAFE, direction: "out", category: "model", money: money("1230000"), fee: null, counterparty: "0x00000000000000000000000000000000000000c3",
  counterpartyName: "Stub model", service: "model:stub", memo: "Stub call", status: "executed", txHash: null, intentId: null, verdictId: null, taskId: null, customer: null, model: null, createdAt: 1794397960,
};
const service = { id: "svc_stub", safe: SAFE, name: "Stub report", description: "A service of the stub agent.", pricing: { model: "per_call", price: money("4000000"), periodSeconds: null }, endpoint: "http://stub/v1/store/svc_stub", uses: 3, revenue: money("12000000"), active: true, createdAt: 1794397960 };
const template = {
  id: "research", name: "Research assistant", kind: "research", description: "Stub template.", highlights: ["$25 a day"],
  config: { maxPerMinute: 20, hoursUtc: [], weekdays: [], payeeAllowlist: false, serviceAllowlist: false, useFirewall: true, useWatchdog: true },
  rules: { maxSingle: "5000000", daily: "25000000", weekly: "120000000", perCounterpartyDaily: "15000000", approvalAbove: "5000000", cosignAbove: null, keepLiquid: "0" },
  alerts: [{ kind: "payment_blocked", threshold: null }],
};
const entry = { id: "dir1", name: "Stub search service", url: "https://stub.service/search", payTo: SAFE, source: "x402", price: money("150000"), uses: 4242, payers: 2, deliveryRate: 0.97, refunds: 1, lastUsed: 1794397960 };
const engineData = {
  "/v1/health": { ok: true, mode: "local", chainId: 4663, block: "1", broadcast: true, contracts: {}, version: "0.1.0" },
  "/v1/config": {
    chainId: 4663, network: "eip155:4663", contracts: { module: SAFE, factory: SAFE, recurring: SAFE, escrow: SAFE, passkey: SAFE }, tokens: [ETH, USDG], feeBps: 10, vaults: [],
    firewall: null, watchdog: null, facilitator: "http://stub-engine/x402", auditSigner: SAFE, testMode: false,
  },
  "/v1/economy": {
    totals: { spendUsd: "4242.42", earnUsd: "321.00", payments: 99, agents: 4242, services: 3, blocked: 17 },
    last24h: { spendUsd: "12.00", earnUsd: "3.00", payments: 5 },
    topServices: [entry],
    priceIndex: [{ category: "model-call", unit: "call", priceUsd: "0.4200", samples: 3, change24h: -0.04 }, { category: "x402-call", unit: "call", priceUsd: "2.5000", samples: 2, change24h: null }],
    series: [{ t: 1794394800, spendUsd: "1.00", earnUsd: "0.50" }, { t: 1794398400, spendUsd: "2.00", earnUsd: "1.00" }],
  },
  "/v1/leaderboard": { items: [{ rank: 1, safe: SAFE, name: "Stub agent", kind: "research", earnedUsd: "9.00", spentUsd: "1.00", profitUsd: "8.00", payments: 12 }], next: null },
  "/v1/templates": { items: [template], next: null },
  "/v1/directory": { items: [entry], next: null },
  "/v1/accounts": { items: [{ safe: SAFE, name: "Stub agent", kind: "research", public: true }, { safe: HIDDEN, name: "Hidden agent", kind: "custom", public: false }], next: null },
  "/v1/demo/firewall": { steps: [], safe: null, startedAt: null, finishedAt: null },
  [`/v1/agents/${SAFE}/public`]: { safe: SAFE, name: "Stub agent", kind: "research", agentId: "7", earnedUsd: "9.00", spentUsd: "1.00", profitUsd: "8.00", receipts: [receipt], rules: [rule], services: [service], createdAt: 1794397960 },
};

let stub;
let stubUrl;
let server;
let base;
const serverLog = [];

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("nice", [process.execPath, nextBin, ...args], { cwd: webDir, env: { ...process.env, ...env }, stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error("next " + args.join(" ") + " failed:\n" + out))));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function get(path) {
  const response = await fetch(base + path, { redirect: "manual" });
  const body = await response.text();
  return { status: response.status, body, headers: response.headers };
}

/** Visible text: scripts, styles and tags removed. */
function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, " ");
}

before(async () => {
  stub = createServer((req, res) => {
    const path = new URL(req.url, "http://stub").pathname;
    if (path === "/v1/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`id: 1\nevent: receipt\ndata: ${JSON.stringify({ id: 1, type: "receipt", safe: SAFE, ts: 1, data: receipt })}\n\n`);
      setTimeout(() => res.end(), 200);
      return;
    }
    const data = engineData[path];
    res.writeHead(data ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(data ?? { error: { code: "not_found", message: "No such endpoint." } }));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubUrl = `http://127.0.0.1:${stub.address().port}`;

  const env = { PURSER_ENGINE_URL: stubUrl, PURSER_DIST_DIR: DIST, NEXT_TELEMETRY_DISABLED: "1" };
  await run(["build"], env);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn("nice", [process.execPath, nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: webDir, env: { ...process.env, ...env }, stdio: "pipe" });
  server.stdout.on("data", (d) => serverLog.push(String(d)));
  server.stderr.on("data", (d) => serverLog.push(String(d)));
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(base + "/own-risk");
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("site did not start:\n" + serverLog.join(""));
});

after(async () => {
  server?.kill();
  await new Promise((resolve) => (stub?.listening ? stub.close(resolve) : resolve()));
  stub?.closeAllConnections?.();
  rmSync(join(webDir, DIST), { recursive: true, force: true });
});

const docIds = [
  "overview", "quickstart", "agent-accounts", "identity", "rules", "approvals", "co-sign", "freeze", "recovery",
  "agent-key", "x402", "models", "apps", "streams", "subscriptions",
  "storefront", "pay-button", "splits", "invoices",
  "firewall", "watchdog", "audit-trail",
  "treasury", "teams", "accounting",
  "sdk", "mcp", "cli", "webhooks", "api", "guides", "test-mode",
  "directory", "economy", "templates", "leaderboard",
];

const routes = {
  "/": ["hero", "how", "safety", "money", "money-out", "money-in", "developers", "network", "start"],
  "/how": ["account", "rules", "payment", "safety", "books", "never"],
  "/firewall": [],
  "/templates": ["research"],
  "/pay": [],
  "/token": ["token"],
  "/economy": [],
  "/directory": [],
  "/leaderboard": [],
  [`/agents/${SAFE}`]: ["store"],
  "/docs": docIds,
  "/developers": ["sdk", "mcp", "models", "sell", "webhooks", "test-mode"],
  "/developers/guides": [],
  "/developers/guides/claude-agent-sdk": [],
  "/developers/guides/openai-agents-sdk": [],
  "/developers/guides/langchain": [],
  "/developers/guides/elizaos": [],
  "/changelog": [],
  "/own-risk": [],
  "/app": [],
  "/app/open": [],
  [`/app/agents/${SAFE}`]: [],
  "/app/approvals": [],
  "/app/safety": [],
  "/app/money-out": [],
  "/app/money-in": [],
  "/app/treasury": [],
  "/app/teams": [],
  "/app/accounting": [],
  "/app/audit": [],
  "/app/alerts": [],
};

const forbidden = [
  [/—/, "em dash"],
  [/[←-⇿✀-➿⬀-⯿\u{1f000}-\u{1faff}☀-⛿✅✓✔]/u, "arrow, emoji or symbol character"],
  [/memecoin/i, "the word memecoin"],
  [/nothing invented|verify it yourself/i, "a defensive phrase"],
  [/lorem ipsum|coming soon\.\.\.|TODO/i, "placeholder text"],
];
/** Rule 11: no sample, demo, example or illustration labels in anything a visitor can read. */
const forbiddenText = /\b(sample|demo|example|illustration)s?\b/i;

for (const [route, ids] of Object.entries(routes)) {
  test(`route ${route}`, async () => {
    const { status, body } = await get(route);
    assert.equal(status, 200);
    assert.match(body, /<header class="header"/, "header");
    assert.match(body, /<footer class="footer"/, "footer");
    assert.match(body, /href="https:\/\/github\.com\/PurserAgents"/, "GitHub link");
    assert.match(body, /href="https:\/\/x\.com\/PurserAgents"/, "X link");
    assert.match(body, /Connect wallet/, "wallet button");
    assert.match(body, /theme-toggle/, "theme toggle");
    assert.match(body, /Use at your own risk/, "own-risk footer line");
    assert.match(body, /<title>[^<]*Purser[^<]*<\/title>/, "title");
    assert.equal((body.match(/<h1[\s>]/g) ?? []).length, 1, "exactly one h1");
    assert.doesNotMatch(body, /class="[^"]*sidebar/, "no sidebar navigation");
    for (const id of ids) assert.match(body, new RegExp(`id="${id}"`), `section id ${id}`);
    for (const [pattern, name] of forbidden) assert.doesNotMatch(body, pattern, `${route} contains ${name}`);
    const text = textOf(body);
    assert.doesNotMatch(text, forbiddenText, `${route} says sample, demo, example or illustration: ${text.match(forbiddenText)?.[0]}`);
  });
}

test("header menus reach every page group", async () => {
  const { body } = await get("/");
  for (const label of ["Product", "Dashboard", "Network", "Developers"]) assert.match(body, new RegExp(`>${label}<`), label);
  for (const href of ["/firewall", "/economy", "/directory", "/templates", "/pay", "/developers", "/app/approvals", "/app/audit"]) assert.match(body, new RegExp(`href="${href}"`), href);
});

test("no dead internal links", async () => {
  const seen = new Set();
  for (const route of Object.keys(routes)) {
    const { body } = await get(route);
    for (const match of body.matchAll(/href="(\/[^"#?]*)/g)) seen.add(match[1]);
  }
  for (const href of seen) {
    if (href.startsWith("/_next/") || href.startsWith("/v1/")) continue;
    const { status } = await get(href);
    assert.equal(status, 200, `link ${href}`);
  }
});

test("public pages show the engine's data", async () => {
  const home = await get("/");
  assert.match(home.body, /id="network"/, "network numbers shown with live data");
  assert.match(home.body, /4,242/, "agents counted from the engine");
  const economy = textOf((await get("/economy")).body);
  assert.match(economy, /\$4,242\.42/);
  assert.match(economy, /Stub search service/);
  assert.match(economy, /AI model call/);
  const board = textOf((await get("/leaderboard")).body);
  assert.match(board, /Stub agent/);
  assert.match(board, /\+\$8\.00/);
  const agent = textOf((await get(`/agents/${SAFE}`)).body);
  assert.match(agent, /Stub report/);
  assert.match(agent, /\$4\.00 per call/);
  assert.match(agent, /Stub model/);
  const directory = textOf((await get("/directory")).body);
  assert.match(directory, /Stub search service/);
  assert.match(directory, /97%/);
  const templates = textOf((await get("/templates")).body);
  assert.match(templates, /Research assistant/);
  assert.match(templates, /\$25/);
  const pay = (await get("/pay")).body;
  assert.match(pay, /http:\/\/stub-engine\/embed\.js/, "pay button points at the engine's public address");
});

test("firewall page without test mode says how to run it", async () => {
  const text = textOf((await get("/firewall")).body);
  assert.match(text, /Watch an attack get blocked/);
  assert.match(text, /npm run testmode/);
});

test("agent pages: unknown is 404, private stays private", async () => {
  assert.equal((await get("/agents/0x00000000000000000000000000000000000000ff")).status, 404);
  assert.equal((await get("/agents/not-an-address")).status, 404);
  const hidden = await get(`/agents/${HIDDEN}`);
  assert.equal(hidden.status, 200);
  assert.match(hidden.body, /This agent is private/);
  assert.doesNotMatch(hidden.body, /Enforced on chain/, "no rules shown for a private agent");
});

test("the /v1 proxy forwards JSON, errors and the live event stream", async () => {
  const health = await get("/v1/health");
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).chainId, 4663);
  const missing = await get("/v1/nothing-here");
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).error.code, "not_found");
  const events = await get("/v1/events");
  assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(events.body, /event: receipt/);
});

test("token page says $PURSER is live and shows no fee percentages or split", async () => {
  const { body } = await get("/token");
  const text = textOf(body.split('<main id="main">')[1].split("</main>")[0]);
  assert.match(text, /\$PURSER is live/);
  assert.doesNotMatch(text, /\d\s?%|percent|split|tax|memecoin/i);
});

test("own-risk page carries the disclaimer", async () => {
  const text = textOf((await get("/own-risk")).body);
  for (const phrase of ["not a bank", "never holds your funds", "advice", "at your own risk"]) {
    assert.match(text, new RegExp(phrase, "i"));
  }
});

test("theme: always light on a first visit, dark only from the saved choice, dark tokens and the no-flash script are present", async () => {
  const { body } = await get("/");
  assert.match(body, /<html[^>]*data-theme="light"/);
  assert.match(body, /purser-theme/);
  // the no-flash script reads the saved choice and nothing else: the system setting never picks the theme
  assert.match(body, /getItem\("purser-theme"\)\}catch\(e\)\{\}d\.setAttribute\("data-theme",t==="dark"\?"dark":"light"\)/);
  assert.doesNotMatch(body, /prefers-color-scheme|matchMedia/);
  assert.match(body, /<meta name="theme-color" content="#ffffff"/);
  const css = (await Promise.all([...body.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((m) => get(m[1])))).map((r) => r.body).join("\n");
  assert.match(css, /\[data-theme="?dark"?\]/);
  assert.doesNotMatch(css, /prefers-color-scheme/, "no style follows the system colour setting");
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /geist\.woff2/);
  assert.match(css, /\.fw__step/, "product styles loaded");
});

test("share image is a 1200 x 630 PNG and the page points at it", async () => {
  const home = await get("/");
  const og = home.body.match(/property="og:image" content="([^"]+)"/)?.[1];
  assert.ok(og, "og:image tag");
  const response = await fetch(base + new URL(og).pathname + new URL(og).search);
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG");
  assert.equal(bytes.readUInt32BE(16), 1200);
  assert.equal(bytes.readUInt32BE(20), 630);
  const homeHtml = await (await fetch(base + "/")).text();
  const href = (homeHtml.match(/<link rel="icon" href="([^"]+)"/) || [])[1];
  assert.ok(href, "favicon link present");
  const icon = await fetch(base + href.replace(/&amp;/g, "&"));
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") || "", /image\/png/);
  const logo = await fetch(base + "/logo.png");
  assert.equal(logo.status, 200);
});

test("when the engine stops answering, pages show empty states and never invent numbers", async () => {
  await new Promise((resolve) => stub.close(resolve));
  stub.closeAllConnections?.();
  // Pages are cached for 15 seconds, then re-rendered on the next request.
  await new Promise((resolve) => setTimeout(resolve, 16_500));
  for (const route of ["/", "/leaderboard", "/economy", "/templates"]) await get(route);
  let text = "";
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    text = textOf((await get("/leaderboard")).body);
    if (!/Stub agent/.test(text)) break;
  }
  assert.doesNotMatch(text, /Stub agent/, "engine rows gone once the engine stops");
  assert.match(text, /No agents are listed yet/);
  const home = (await get("/")).body;
  assert.doesNotMatch(home, /id="network"/, "network numbers hidden without live data");
  assert.match(textOf((await get("/economy")).body), /No payments counted yet/);
  assert.match(textOf((await get("/directory")).body), /No services yet/);
  assert.match(textOf((await get("/templates")).body), /Templates load from the engine/);
  for (const route of Object.keys(routes)) {
    if (route.startsWith("/agents/")) continue;
    const page = await get(route);
    assert.equal(page.status, 200, route);
    assert.doesNotMatch(textOf(page.body), forbiddenText, route + " says sample/demo/example/illustration");
  }
  assert.equal((await get("/v1/health")).status, 503, "the proxy answers 503 when the engine is gone");
});
