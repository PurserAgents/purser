"use client";

import { useEffect } from "react";
import { IconMoon, IconSun } from "./Icons";

const KEY = "purser-theme";

/** Page colour behind the browser chrome, per theme (the --bg token). */
const CHROME = { light: "#ffffff", dark: "#0b0b0c" } as const;

/**
 * Runs in <head> before first paint. Light is the default for every first visit, whatever the system setting;
 * dark only when the visitor chose it with the toggle before.
 */
export const themeScript = `(function(){var d=document.documentElement;var t=null;try{t=localStorage.getItem("${KEY}")}catch(e){}d.setAttribute("data-theme",t==="dark"?"dark":"light");d.classList.add("js")})()`;

function paintChrome(theme: "light" | "dark") {
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", CHROME[theme]);
}

export function ThemeToggle() {
  useEffect(() => {
    paintChrome(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  }, []);
  function toggle() {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    paintChrome(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
  }
  return (
    <button type="button" className="icon-btn theme-toggle" onClick={toggle} aria-label="Switch between light and dark">
      <IconSun size={18} className="icon-sun" />
      <IconMoon size={18} className="icon-moon" />
    </button>
  );
}
