import type { Hono } from "hono";
import type { AuditEntry } from "../../packages/sdk/src/schema.ts";
import { verifyAudit } from "./audit.ts";
import { registerRoutes } from "./api/registry.ts";
import { qInt, send } from "./api/http.ts";
import type { Ctx } from "./ctx.ts";
import { fail } from "./util.ts";

/** Parses an export: JSON Lines (one entry per line) or a JSON array. */
export function parseExport(text: string): AuditEntry[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[")) return JSON.parse(t) as AuditEntry[];
  return t.split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditEntry);
}

registerRoutes((app: Hono, ctx: Ctx) => {
  app.get("/v1/audit", (c) => send(c, { items: ctx.audit.list({ safe: c.req.query("safe"), limit: qInt(c, "limit", 100), before: qInt(c, "before") }), signer: ctx.audit.signer, next: null }));
  app.get("/v1/audit/key", (c) => send(c, { signer: ctx.audit.signer, scheme: "keccak256 over canonical JSON, EIP-191 signature, each entry links the previous hash" }));
  /** The whole chain as JSON Lines: verifiable on its own with the signer address. */
  app.get("/v1/audit/export", (c) => {
    const lines = ctx.audit.exportAll().map((e) => JSON.stringify(e)).join("\n");
    return c.body(lines + "\n", 200, { "content-type": "application/x-ndjson", "content-disposition": `attachment; filename="purser-audit-${Date.now()}.jsonl"` });
  });
  app.post("/v1/audit/verify", async (c) => {
    let entries: AuditEntry[];
    try {
      entries = parseExport(await c.req.text());
    } catch {
      return fail(400, "bad_export", "The export is not JSON Lines or a JSON array.");
    }
    const signer = c.req.query("signer") as `0x${string}` | undefined;
    return send(c, await verifyAudit(entries, signer ?? ctx.audit.signer));
  });
});
