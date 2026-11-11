/**
 * A small Chrome DevTools Protocol driver for the end-to-end checks and the screenshots: headless Chrome with its
 * own profile, the debug port found by polling DevToolsActivePort, one flat session per page. No dependencies.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

export function chromePath() {
  return CHROME_PATHS.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1440, height = 900 } = {}) {
  const bin = chromePath();
  if (!bin) throw new Error("Chrome not found (set CHROME_PATH)");
  const profile = mkdtempSync(join(tmpdir(), "purser-chrome-"));
  const proc = spawn(
    "nice",
    [
      bin,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--hide-scrollbars",
      "--mute-audio",
      "--force-color-profile=srgb",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  let wsPath = null;
  for (let i = 0; i < 200 && !wsPath; i++) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
      if (port && path) wsPath = `ws://127.0.0.1:${port}${path}`;
    }
    if (!wsPath) await sleep(100);
  }
  if (!wsPath) {
    proc.kill("SIGKILL");
    throw new Error("Chrome did not open its debug port");
  }
  const ws = new WebSocket(wsPath);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    } else if (data.method) {
      for (const l of listeners) l(data);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  async function newPage() {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    await call("Page.enable");
    await call("Runtime.enable");
    const consoleErrors = [];
    const onEvent = (e) => {
      if (e.sessionId !== sessionId) return;
      if (e.method === "Runtime.exceptionThrown") consoleErrors.push(e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text);
      if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") consoleErrors.push(e.params.args.map((a) => a.value ?? a.description).join(" "));
    };
    listeners.add(onEvent);

    const page = {
      call,
      consoleErrors,
      /** Every protocol event of this page (method, params). */
      listen(fn) {
        const l = (e) => e.sessionId === sessionId && fn(e.method, e.params);
        listeners.add(l);
        return () => listeners.delete(l);
      },
      async viewport(w, h, mobile = false) {
        await call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile, screenWidth: w, screenHeight: h });
        await call("Emulation.setUserAgentOverride", {
          userAgent: mobile
            ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 PurserCheck"
            : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36 PurserCheck",
        });
        if (mobile) await call("Emulation.setTouchEmulationEnabled", { enabled: true });
      },
      async onNewDocument(source) {
        await call("Page.addScriptToEvaluateOnNewDocument", { source });
      },
      async goto(url, { wait = "load", timeout = 30000 } = {}) {
        const loaded = new Promise((resolve) => {
          const l = (e) => {
            if (e.sessionId === sessionId && e.method === (wait === "load" ? "Page.loadEventFired" : "Page.domContentEventFired")) {
              listeners.delete(l);
              resolve();
            }
          };
          listeners.add(l);
          setTimeout(() => {
            listeners.delete(l);
            resolve();
          }, timeout);
        });
        await call("Page.navigate", { url });
        await loaded;
      },
      async eval(expression) {
        const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      /** Polls an expression until it is truthy. */
      async waitFor(expression, { timeout = 30000, interval = 150, label } = {}) {
        const end = Date.now() + timeout;
        let last;
        while (Date.now() < end) {
          try {
            last = await page.eval(expression);
            if (last) return last;
          } catch (e) {
            last = e.message;
          }
          await sleep(interval);
        }
        throw new Error(`timed out waiting for ${label ?? expression} (last: ${JSON.stringify(last)})`);
      },
      async click(selector) {
        const ok = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`);
        if (!ok) throw new Error(`no element ${selector}`);
      },
      /** Clicks the first button or link whose text matches. */
      async clickText(text, { tag = "button,a", within = "body" } = {}) {
        const ok = await page.eval(`(() => {
          const root = document.querySelector(${JSON.stringify(within)});
          const els = [...root.querySelectorAll(${JSON.stringify(tag)})].filter((e) => !e.disabled && e.offsetParent !== null);
          const el = els.find((e) => e.textContent.trim().replace(/\\s+/g, " ") === ${JSON.stringify(text)}) ?? els.find((e) => e.textContent.includes(${JSON.stringify(text)}));
          if (!el) return false;
          el.scrollIntoView({ block: "center" });
          el.click();
          return true;
        })()`);
        if (!ok) throw new Error(`no clickable "${text}"`);
      },
      /** Sets an input's value the way React notices. */
      async fill(selector, value) {
        const ok = await page.eval(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`);
        if (!ok) throw new Error(`no field ${selector}`);
      },
      async text() {
        return page.eval("document.body.innerText");
      },
      async screenshot({ full = false } = {}) {
        const r = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: full, fromSurface: true });
        return Buffer.from(r.data, "base64");
      },
      async close() {
        listeners.delete(onEvent);
        await send("Target.closeTarget", { targetId }).catch(() => {});
      },
    };
    return page;
  }

  async function close() {
    await send("Browser.close").catch(() => {});
    ws.close();
    await new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve();
      const t = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 3000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    rmSync(profile, { recursive: true, force: true });
  }

  return { newPage, close, pid: proc.pid };
}
