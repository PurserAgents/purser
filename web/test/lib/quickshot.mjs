/**
 * Quick look while building: node test/lib/quickshot.mjs <base> <outDir> <w>x<h> <theme> <path...>
 * Uses the test wallet when the engine is in test mode. Full-page PNGs.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "./cdp.mjs";

const [base, out, size, theme, ...paths] = process.argv.slice(2);
const [w, h] = size.split("x").map(Number);
const browser = await launch({ width: w, height: h });
try {
  const page = await browser.newPage();
  await page.viewport(w, h, w < 600);
  await page.onNewDocument(`try { localStorage.setItem("purser-theme", ${JSON.stringify(theme)}); localStorage.setItem("purser-wallet-mode", "test"); } catch {}`);
  for (const p of paths) {
    await page.goto(base + p);
    await new Promise((r) => setTimeout(r, Number(process.env.WAIT ?? 2500)));
    const name = (p === "/" ? "home" : p.replace(/^\//, "").replace(/[/?=&]/g, "-")) + `-${w}-${theme}.png`;
    writeFileSync(join(out, name), await page.screenshot({ full: process.env.FULL !== "0" }));
    const sw = await page.eval("document.documentElement.scrollWidth");
    console.log(name, sw > w ? `HORIZONTAL SCROLL ${sw}` : "", page.consoleErrors.splice(0).join(" | ").slice(0, 300));
  }
} finally {
  await browser.close();
}
