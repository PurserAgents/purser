import type { MetadataRoute } from "next";
import { guideOrder } from "@/lib/guides";
import { site } from "@/lib/site";

const routes = [
  "",
  "/how",
  "/firewall",
  "/shield",
  "/templates",
  "/pay",
  "/token",
  "/roadmap",
  "/economy",
  "/directory",
  "/leaderboard",
  "/docs",
  "/developers",
  "/developers/guides",
  "/changelog",
  "/own-risk",
  "/app",
  "/app/open",
];

export default function sitemap(): MetadataRoute.Sitemap {
  return [...routes, ...guideOrder.map((g) => `/developers/guides/${g.slug}`)].map((route) => ({ url: site.url + route }));
}
