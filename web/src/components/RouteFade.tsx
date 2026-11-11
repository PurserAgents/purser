"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

const OUT_MS = 170;

/**
 * Fades the page out before a click on an internal link navigates; the next page fades in (app/template.tsx).
 * Back/forward, new tabs, modified clicks, downloads, hash links and other sites are left alone.
 */
export function RouteFade() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    document.getElementById("main")?.classList.remove("page-leaving");
  }, [pathname]);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onClick = (e: MouseEvent) => {
      if (reduce.matches || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !a.href || a.target && a.target !== "_self" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname) return; // same page (or only a hash change)
      if (url.pathname.startsWith("/v1/")) return; // engine proxy: files, CSV
      const main = document.getElementById("main");
      if (!main) return;
      e.preventDefault();
      main.classList.add("page-leaving");
      window.setTimeout(() => router.push(url.pathname + url.search + url.hash), OUT_MS);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [router]);

  return null;
}
