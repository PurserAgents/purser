import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Ctx } from "../ctx.ts";
import { send, onError } from "./http.ts";
import { routeModules } from "./registry.ts";
import { coreRoutes } from "./routes-core.ts";

export { registerRoutes, type RouteModule } from "./registry.ts";

export function buildApp(ctx: Ctx): Hono {
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "PAYMENT-SIGNATURE", "X-PAYMENT", "Last-Event-ID"], exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] }));
  app.onError(onError);
  coreRoutes(app, ctx);
  for (const m of routeModules) m(app, ctx);
  app.notFound((c) => send(c, { error: { code: "not_found", message: "No such endpoint." } }, 404));
  return app;
}
