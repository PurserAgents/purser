/**
 * Screenshots of every page at 1440x900 and 390x844, light and dark, with the engine in test mode on a local node
 * (seeded agents, the firewall scenario run once) and the test wallet connected, into docs/shots/.
 * Fails if any page scrolls sideways.
 *
 *   npm run shots                     (from web/)
 *   FULL_DIR=/some/dir npm run shots  also writes full-page images there, for review
 *   SHOTS_SITE=http://127.0.0.1:3100 SHOTS_ENGINE=http://localhost:8787 npm run shots
 *                                     a site and a test-mode engine that already run: nothing is started, built or
 *                                     stopped, and the firewall scenario is left as it is
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./lib/cdp.mjs";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = join(webDir, "..", "engine");
const outDir = join(webDir, "..", "docs", "shots");
const fullDir = process.env.FULL_DIR || null;
const DIST = ".next-shots";
const nextBin = join(webDir, "node_modules", "next", "dist", "bin", "next");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function until(fn, label, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error("timed out: " + label);
}

function stopAll() {
  for (const p of procs) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
}

let browser;
try {
  const running = process.env.SHOTS_SITE && process.env.SHOTS_ENGINE;
  const engineUrl = running ? process.env.SHOTS_ENGINE : `http://127.0.0.1:${await freePort()}`;
  let site = process.env.SHOTS_SITE;
  const port = new URL(engineUrl).port;
  if (!running) {
    const eng = spawn("nice", ["npx", "tsx", "scripts/testmode.ts", "--port", String(port)], { cwd: engineDir, env: { ...process.env, PURSER_LOG: "0" }, stdio: "pipe", detached: true });
    procs.push(eng);
    let log = "";
    eng.stdout.on("data", (d) => (log += d));
    eng.stderr.on("data", (d) => (log += d));
    await until(async () => /is running/.test(log), "engine", 240_000);
    console.log("engine in test mode at", engineUrl);
    const run = await fetch(engineUrl + "/v1/demo/firewall/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paceMs: 0 }) });
    if (!run.ok) throw new Error("firewall scenario failed: " + (await run.text()));
  }
  const accounts = (await (await fetch(engineUrl + "/v1/accounts")).json()).items;
  const seller = accounts.find((a) => a.name.startsWith("Quill"))?.safe;
  const research = accounts.find((a) => a.name.startsWith("Atlas"))?.safe;

  if (!running) {
    const env = { ...process.env, PURSER_ENGINE_URL: engineUrl, PURSER_DIST_DIR: DIST, NEXT_TELEMETRY_DISABLED: "1" };
    await new Promise((resolve, reject) => {
      const b = spawn("nice", [process.execPath, nextBin, "build"], { cwd: webDir, env, stdio: "pipe" });
      let out = "";
      b.stdout.on("data", (d) => (out += d));
      b.stderr.on("data", (d) => (out += d));
      b.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("build failed\n" + out))));
    });
    const sitePort = await freePort();
    site = `http://127.0.0.1:${sitePort}`;
    procs.push(spawn("nice", [process.execPath, nextBin, "start", "-p", String(sitePort), "-H", "127.0.0.1"], { cwd: webDir, env, stdio: "ignore", detached: true }));
    await until(async () => (await fetch(site + "/own-risk")).ok, "site", 60_000);
  }
  const routes = [
    ["home", "/"],
    ["how", "/how"],
    ["firewall", "/firewall"],
    ["templates", "/templates"],
    ["pay", `/pay?agent=${seller}`],
    ["token", "/token"],
    ["economy", "/economy"],
    ["directory", "/directory"],
    ["leaderboard", "/leaderboard"],
    ["agent-public", `/agents/${seller}`],
    ["docs", "/docs"],
    ["developers", "/developers"],
    ["guides", "/developers/guides"],
    ["guide", "/developers/guides/claude-agent-sdk"],
    ["changelog", "/changelog"],
    ["own-risk", "/own-risk"],
    ["not-found", "/this-page-does-not-exist"],
    ["app-overview", "/app"],
    ["app-open", "/app/open"],
    ["app-agent", `/app/agents/${research}`],
    ["app-approvals", "/app/approvals"],
    ["app-safety", "/app/safety"],
    ["app-money-out", "/app/money-out"],
    ["app-money-in", "/app/money-in"],
    ["app-treasury", "/app/treasury"],
    ["app-teams", "/app/teams"],
    ["app-accounting", "/app/accounting"],
    ["app-audit", "/app/audit"],
    ["app-alerts", "/app/alerts"],
  ];
  const sizes = [
    ["desktop", 1440, 900, false],
    ["mobile", 390, 844, true],
  ];

  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.endsWith(".png")) rmSync(join(outDir, f));
  rmSync(join(outDir, "web"), { recursive: true, force: true });
  if (fullDir) mkdirSync(fullDir, { recursive: true });

  browser = await launch({ width: 1440, height: 900 });
  const sideways = [];
  let count = 0;
  for (const theme of ["light", "dark"]) {
    for (const [size, w, h, mobile] of sizes) {
      const page = await browser.newPage();
      await page.viewport(w, h, mobile);
      await page.onNewDocument(`try { localStorage.setItem("purser-theme", ${JSON.stringify(theme)}); localStorage.setItem("purser-wallet-mode", "test"); } catch {}`);
      for (const [name, path] of routes) {
        await page.goto(site + path);
        // live data loads after the first paint; owner pages wait for the test wallet and the engine
        await page.waitFor(`!document.querySelector('[aria-busy="true"]')`, { timeout: 15_000 }).catch(() => {});
        await sleep(name.startsWith("app") ? 2200 : 900);
        await page.eval("window.scrollTo(0, 0)");
        const file = `${name}-${size}-${theme}.png`;
        writeFileSync(join(outDir, file), await page.screenshot());
        if (fullDir) writeFileSync(join(fullDir, file), await page.screenshot({ full: true }));
        const width = await page.eval("document.documentElement.scrollWidth");
        if (width > w) sideways.push(`${file}: ${width}px`);
        count++;
      }
      // chrome states: the open header menu on desktop, the menu sheet on phones
      await page.goto(site + "/");
      await sleep(900);
      if (mobile) await page.click(".header__menu-btn");
      else await page.eval(`[...document.querySelectorAll(".nav__trigger")].find((b) => b.textContent.includes("Dashboard")).click()`);
      await sleep(400);
      writeFileSync(join(outDir, `menu-${size}-${theme}.png`), await page.screenshot());
      count++;
      await page.close();
    }
  }
  console.log(`${count} screenshots in docs/shots`);
  if (sideways.length) {
    console.error("Pages that scroll sideways:\n" + sideways.join("\n"));
    process.exitCode = 1;
  }
} finally {
  await browser?.close().catch(() => {});
  stopAll();
  await sleep(1500);
  for (const p of procs) {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  rmSync(join(webDir, DIST), { recursive: true, force: true });
}
