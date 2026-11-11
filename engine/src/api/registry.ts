import type { Hono } from "hono";
import type { Ctx } from "../ctx.ts";

/** Feature modules register their routes here; kept free of imports so any module can load it first. */
export type RouteModule = (app: Hono, ctx: Ctx) => void;
export const routeModules: RouteModule[] = [];

export function registerRoutes(m: RouteModule) {
  if (!routeModules.includes(m)) routeModules.push(m);
}
