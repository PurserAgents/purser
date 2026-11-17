import type { Context } from "hono";
import { z } from "zod";
import type { ApiScope } from "../../../packages/sdk/src/schema.ts";
import type { Ctx } from "../ctx.ts";
import { authAgent, authOwner, requireSafeOwner } from "../keys.ts";
import { ApiFailure, fail, json, lower, MAX_U128 } from "../util.ts";

export const send = (c: Context, data: unknown, status = 200) =>
  c.body(json(data), status as 200, { "content-type": "application/json; charset=utf-8" });

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    fail(400, "bad_json", "The request body is not valid JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    fail(400, "bad_request", `${first.path.join(".") || "body"}: ${first.message}`);
  }
  return r.data as z.infer<T>;
}

export const zAddr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address").transform((s) => lower(s) as `0x${string}`);
export const zHex = z.string().regex(/^0x[0-9a-fA-F]*$/, "must be 0x hex").transform((s) => s as `0x${string}`);
export const zBytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes hex").transform((s) => s as `0x${string}`);
const MAX_U256 = (1n << 256n) - 1n;

/**
 * An amount in base units: at most 78 digits and at most 2^256 - 1, so nothing stored or printed can be huge.
 * zAmount128 is at most 2^128 - 1: what the escrow and the module's rules take (listing prices, invoices, budgets).
 */
export const zAmount = z
  .union([z.string().regex(/^\d{1,78}$/, "must be an integer in base units, at most 78 digits"), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform((v) => String(v))
  .refine((v) => BigInt(v) <= MAX_U256, "must be at most 2^256 - 1");
export const zAmount128 = zAmount.refine((v) => BigInt(v) <= MAX_U128, "must be at most 2^128 - 1");
export const zNullableAmount = zAmount.nullable();

export function param(c: Context, name: string): string {
  return c.req.param(name) ?? fail(400, "bad_request", `missing ${name}`);
}

export function safeParam(c: Context): `0x${string}` {
  const s = param(c, "safe");
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) fail(400, "bad_request", "safe must be a 0x address");
  return lower(s) as `0x${string}`;
}

export const agent = (ctx: Ctx, c: Context, scope: ApiScope) => authAgent(ctx, c.req.header("authorization"), scope);
export const owner = (ctx: Ctx, c: Context) => authOwner(ctx, c.req.header("authorization"));
export const safeOwner = (ctx: Ctx, c: Context, safe: string) => requireSafeOwner(ctx, c.req.header("authorization"), safe);

export function onError(err: Error, c: Context) {
  if (err instanceof ApiFailure) return send(c, { error: { code: err.code, message: err.message } }, err.status);
  if (process.env.PURSER_LOG !== "0") console.error(err);
  return send(c, { error: { code: "internal", message: err.message?.split("\n")[0] ?? "internal error" } }, 500);
}

export const qInt = (c: Context, name: string, dflt?: number) => {
  const v = c.req.query(name);
  return v === undefined ? dflt : Number(v);
};
