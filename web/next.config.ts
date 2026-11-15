import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // The smoke test builds into its own folder so it never disturbs a running preview.
  distDir: process.env.PURSER_DIST_DIR || ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: path.resolve(import.meta.dirname) },
  outputFileTracingRoot: path.resolve(import.meta.dirname),
  // The phone app's service worker: always checked for a new version, allowed to serve the whole site.
  async headers() {
    return [{ source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/" }] }];
  },
};

export default config;
