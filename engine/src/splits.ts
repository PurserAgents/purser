import type { Hono } from "hono";
import type { Address } from "viem";
import { z } from "zod";
import { purserModuleAbi } from "../../packages/sdk/src/abi.ts";
import { prepareSafeTx, ruleChangeCalls } from "./accounts.ts";
import { registerRoutes } from "./api/registry.ts";
import { body, safeParam, send, zAddr } from "./api/http.ts";
import { requireDep, type Ctx } from "./ctx.ts";
import { fail, lower } from "./util.ts";

export const SPLIT_ROLES = ["owner", "developer", "model_provider", "coworker", "other"] as const;

/** The account's split rules, who each recipient is, and what each has received so far. */
export async function readSplits(ctx: Ctx, safe: Address) {
  const dep = requireDep(ctx);
  const splits = await ctx.chain.pub.readContract({ address: dep.module, abi: purserModuleAbi, functionName: "getSplits", args: [safe] });
  const items = splits.map((s) => {
    const meta = ctx.db.prepare("SELECT label FROM split_labels WHERE safe = ? AND address = ?").get(lower(safe), lower(s.to)) as { label: string } | undefined;
    const [label, role] = (meta?.label ?? "|other").split("|");
    const paid = ctx.db
      .prepare("SELECT token, COALESCE(SUM(CAST(amount AS INTEGER)),0) AS total, COUNT(*) AS n FROM receipts WHERE safe = ? AND category = 'split' AND counterparty = ? GROUP BY token")
      .all(lower(safe), lower(s.to)) as { token: string; total: number; n: number }[];
    return {
      to: lower(s.to),
      bps: s.bps,
      percent: (s.bps / 100).toFixed(2),
      label: label || null,
      role: role || "other",
      paid: paid.map((p) => ctx.tokens.money(p.token, BigInt(p.total))),
      payments: paid.reduce((n, p) => n + p.n, 0),
    };
  });
  const totalBps = items.reduce((s, i) => s + i.bps, 0);
  return { safe: lower(safe), items, keptBps: 10_000 - totalBps };
}

registerRoutes((app: Hono, ctx: Ctx) => {
  app.get("/v1/accounts/:safe/splits", async (c) => send(c, await readSplits(ctx, safeParam(c))));
  app.post("/v1/accounts/:safe/splits/prepare", async (c) => {
    const safe = safeParam(c);
    const b = await body(
      c,
      z.object({
        splits: z
          .array(z.object({ to: zAddr, bps: z.number().int().min(1).max(10_000), label: z.string().max(40).optional(), role: z.enum(SPLIT_ROLES).default("other") }))
          .max(8),
      }),
    );
    const total = b.splits.reduce((s, x) => s + x.bps, 0);
    if (total > 10_000) fail(400, "bad_request", `The shares add up to ${total / 100}%, more than 100%.`);
    if (b.splits.some((s) => s.to === safe)) fail(400, "bad_request", "The account cannot split to itself.");
    for (const s of b.splits) {
      ctx.db
        .prepare("INSERT INTO split_labels (safe, address, label) VALUES (?, ?, ?) ON CONFLICT(safe, address) DO UPDATE SET label = excluded.label")
        .run(safe, s.to, `${s.label ?? ""}|${s.role}`);
    }
    const tx = await prepareSafeTx(ctx, safe, ruleChangeCalls(ctx, { splits: b.splits.map((s) => ({ to: s.to, bps: s.bps })) }), "Split incoming revenue on arrival.");
    return send(c, tx);
  });
});
