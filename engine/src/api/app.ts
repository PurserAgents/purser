import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { Ctx } from "../ctx.ts";
import { send, onError } from "./http.ts";
import { routeModules } from "./registry.ts";
import { coreRoutes } from "./routes-core.ts";

export { registerRoutes, type RouteModule } from "./registry.ts";

export const MAX_BODY = 2 * 1024 * 1024;

export function buildApp(ctx: Ctx): Hono {
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "PAYMENT-SIGNATURE", "X-PAYMENT", "Last-Event-ID"], exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] }));
  // no request body larger than 2 MB (a long model prompt fits many times over)
  app.use("*", bodyLimit({ maxSize: MAX_BODY, onError: (c) => send(c, { error: { code: "too_large", message: "The request body is larger than 2 MB." } }, 413) }));
  app.onError(onError);
  coreRoutes(app, ctx);
  for (const m of routeModules) m(app, ctx);
  app.notFound((c) => send(c, { error: { code: "not_found", message: "No such endpoint." } }, 404));
  return app;
}
