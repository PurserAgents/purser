import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // The smoke test builds into its own folder so it never disturbs a running preview.
  distDir: process.env.PURSER_DIST_DIR || ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: path.resolve(import.meta.dirname) },
  outputFileTracingRoot: path.resolve(import.meta.dirname),
};

export default config;
