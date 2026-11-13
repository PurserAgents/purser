import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { z } from "zod";
import { erc20Abi } from "../../../packages/sdk/src/abi.ts";
import type { Health } from "../../../packages/sdk/src/schema.ts";
import {
  execAsTestOwner,
  listAccounts,
  prepareAttach,
  prepareCreate,
  prepareModuleCall,
  prepareSafeTx,
  readAccount,
  ruleChangeCalls,
  sendAsTestOwner,
  upsertAccount,
} from "../accounts.ts";
import { decideAsTestOwner, decideWithPasskey, getApproval, listApprovals, prepareDecision, preparePasskeySetup } from "../approvals.ts";
import { applyTemplateAlerts } from "../alerts.ts";
import { VERSION } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { requireDep } from "../ctx.ts";
import { getVerdict, listVerdicts } from "../firewall.ts";
import { indexOnce, ingestReceipt } from "../indexer.ts";
import { getIntent, listIntents, resumeIntent, submitIntent } from "../intents.ts";
import { createApiKey, issueOwnerSession, listApiKeys, newSignInNonce, revokeApiKey, signInMessage, verifySignIn } from "../keys.ts";
import { getReceipt, listReceipts } from "../receipts.ts";
import { setupFromTemplate, TEMPLATES, getTemplate } from "../templates.ts";
import { fail, lower, now, ZERO } from "../util.ts";
import { agent, body, param, qInt, safeOwner, safeParam, send, zAddr, zAmount, zBytes32, zHex, zNullableAmount } from "./http.ts";

const zConfig = z.object({
  agent: zAddr,
  cosigner: zAddr.nullable().default(null),
  firewall: zAddr.nullable().default(null),
  watchdog: zAddr.nullable().default(null),
  maxPerMinute: z.number().int().min(0).max(65535).nullable().default(null),
  hoursUtc: z.array(z.number().int().min(0).max(23)).default([]),
  weekdays: z.array(z.number().int().min(0).max(6)).default([]),
  payeeAllowlist: z.boolean().default(false),
  serviceAllowlist: z.boolean().default(false),
});

const zRule = z.object({
  enabled: z.boolean().optional(),
  receivable: z.boolean().optional(),
  maxSingle: zNullableAmount.optional(),
  daily: zNullableAmount.optional(),
  weekly: zNullableAmount.optional(),
  perCounterpartyDaily: zNullableAmount.optional(),
  approvalAbove: zNullableAmount.optional(),
  cosignAbove: zNullableAmount.optional(),
  keepLiquid: zAmount.optional(),
});

const zRuleChange = z.object({
  config: zConfig.optional(),
  rules: z.array(z.object({ token: zAddr, rule: zRule })).optional(),
  allow: z.array(zAddr).optional(),
  disallow: z.array(zAddr).optional(),
  services: z.array(zBytes32).optional(),
  removeServices: z.array(zBytes32).optional(),
  vaults: z.array(zAddr).optional(),
  removeVaults: z.array(zAddr).optional(),
  splits: z.array(z.object({ to: zAddr, bps: z.number().int().min(1).max(10000) })).optional(),
  counterpartyLimits: z.array(z.object({ token: zAddr, counterparty: zAddr, limit: zAmount })).optional(),
  approver: zAddr.nullable().optional(),
  guardian: z.object({ address: zAddr, delaySeconds: z.number().int().min(86400) }).nullable().optional(),
});

const zAssertion = z.object({
  authenticatorData: zHex,
  clientDataJSON: z.string(),
  challengeIndex: z.number().int().min(0),
  typeIndex: z.number().int().min(0),
  r: z.string(),
  s: z.string(),
});

export function coreRoutes(app: Hono, ctx: Ctx) {
  // ------------------------------------------------------------------------------------------------ meta
  app.get("/v1/health", async (c) => {
    let block: string | null = null;
    try {
      block = (await ctx.chain.pub.getBlockNumber()).toString();
    } catch {
      /* node down */
    }
    const dep = ctx.dep;
    const h: Health = {
      ok: block !== null,
      mode: dep ? (dep.mode === "live" ? "readonly" : dep.mode) : "readonly",
      chainId: ctx.cfg.chainId,
      block,
      broadcast: ctx.chain.broadcast,
      contracts: {
        module: dep?.module ?? null,
        factory: dep?.factory ?? null,
        recurring: dep?.recurring ?? null,
        escrow: dep?.escrow ?? null,
        passkey: dep?.passkey ?? null,
        usdg: dep?.usdg ?? null,
      },
      version: VERSION,
    };
    return send(c, h);
  });

  app.get("/v1/config", (c) => {
    const dep = requireDep(ctx);
    return send(c, {
      chainId: ctx.cfg.chainId,
      network: `eip155:${ctx.cfg.chainId}`,
      contracts: { module: dep.module, factory: dep.factory, recurring: dep.recurring, escrow: dep.escrow, passkey: dep.passkey },
      tokens: [ctx.tokens.infoSync(ZERO), ctx.tokens.infoSync(dep.usdg)],
      feeBps: dep.feeBps,
      vaults: dep.vaults,
      firewall: ctx.chain.accounts.firewall?.address ?? null,
      watchdog: ctx.chain.accounts.watchdog?.address ?? null,
      facilitator: `${ctx.cfg.publicUrl}/x402`,
      auditSigner: ctx.audit.signer,
      testMode: ctx.cfg.testMode,
    });
  });

  app.get("/v1/events", (c) => {
    const safe = c.req.query("safe")?.toLowerCase();
    const types = c.req.query("types")?.split(",");
    // Replay only when asked (since=, or Last-Event-ID on a reconnect); a fresh connection starts from now.
    const lastRaw = c.req.header("last-event-id") ?? c.req.query("since");
    const lastId = lastRaw === undefined ? Number.POSITIVE_INFINITY : Number(lastRaw) || 0;
    return streamSSE(c, async (stream) => {
      // A first message at once, so proxies pass the headers on and the client knows the stream is open.
      await stream.writeSSE({ event: "ping", data: String(now()) });
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const accept = (e: { safe: string | null; type: string }) => (!safe || e.safe === safe) && (!types || types.includes(e.type));
      for (const e of ctx.bus.since(lastId)) if (accept(e)) await stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) });
      const unsub = ctx.bus.subscribe((e) => {
        if (!accept(e)) return;
        queue.push(JSON.stringify(e));
        wake?.();
      });
      stream.onAbort(() => {
        unsub();
        wake?.();
      });
      let ping = 0;
      while (!stream.aborted) {
        while (queue.length) {
          const data = queue.shift()!;
          const e = JSON.parse(data);
          await stream.writeSSE({ id: String(e.id), event: e.type, data });
        }
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 15000);
        });
        wake = null;
        if (++ping && !queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: String(now()) });
      }
      unsub();
    });
  });

  /** An agent key asks who it is: its account, scopes and session key. */
  app.get("/v1/me", (c) => {
    const auth = agent(ctx, c, "read");
    return send(c, { safe: auth.safe, key: auth.key, sessionAddress: auth.session?.address ?? null });
  });

  // ------------------------------------------------------------------------------------------------ owner sign-in
  app.post("/v1/auth/nonce", async (c) => {
    const { address } = await body(c, z.object({ address: zAddr }));
    const nonce = newSignInNonce(ctx);
    const issued = now();
    return send(c, { nonce, issued, message: signInMessage(address, nonce, issued) });
  });
  app.post("/v1/auth/verify", async (c) => {
    const b = await body(c, z.object({ address: zAddr, nonce: z.string(), issued: z.number().int(), signature: zHex }));
    return send(c, await verifySignIn(ctx, b));
  });

  // ------------------------------------------------------------------------------------------------ accounts
  app.get("/v1/accounts", async (c) => send(c, { items: await listAccounts(ctx, { owner: c.req.query("owner") }), next: null }));
  app.get("/v1/accounts/:safe", async (c) => send(c, await readAccount(ctx, safeParam(c))));

  app.post("/v1/accounts/prepare", async (c) => {
    const b = await body(
      c,
      z.object({
        owners: z.array(zAddr).min(1),
        threshold: z.number().int().min(1).default(1),
        creator: zAddr,
        template: z.string().default("custom"),
        agent: zAddr,
        cosigner: zAddr.nullable().optional(),
        agentURI: z.string().optional(),
        allow: z.array(zAddr).optional(),
        salt: zAmount.optional(),
        config: zConfig.optional(),
        rules: z.array(z.object({ token: zAddr, rule: zRule })).optional(),
      }),
    );
    const setup = setupFromTemplate(ctx, b.template, { agent: b.agent, cosigner: b.cosigner, agentURI: b.agentURI, allow: b.allow });
    if (b.config) setup.config = b.config;
    if (b.rules) setup.rules = b.rules;
    return send(c, await prepareCreate(ctx, { owners: b.owners, threshold: b.threshold, creator: b.creator, setup, salt: b.salt ? BigInt(b.salt) : undefined }));
  });

  app.post("/v1/accounts/:safe/attach/prepare", async (c) => {
    const safe = safeParam(c);
    const b = await body(c, z.object({ template: z.string().default("custom"), agent: zAddr, agentURI: z.string().optional() }));
    return send(c, await prepareAttach(ctx, safe, setupFromTemplate(ctx, b.template, { agent: b.agent, agentURI: b.agentURI })));
  });

  app.post("/v1/accounts/register", async (c) => {
    const b = await body(c, z.object({ safe: zAddr, name: z.string().min(1).max(60), kind: z.string().default("custom"), public: z.boolean().default(false), template: z.string().optional() }));
    await safeOwner(ctx, c, b.safe);
    await indexOnce(ctx).catch(() => 0);
    const owners = (await readAccount(ctx, b.safe)).owners;
    upsertAccount(ctx, { ...b, owners });
    if (b.template) applyTemplateAlerts(ctx, b.safe, b.template);
    return send(c, await readAccount(ctx, b.safe), 201);
  });

  app.patch("/v1/accounts/:safe", async (c) => {
    const safe = safeParam(c);
    await safeOwner(ctx, c, safe);
    const b = await body(c, z.object({ name: z.string().min(1).max(60).optional(), kind: z.string().optional(), public: z.boolean().optional() }));
    upsertAccount(ctx, { safe, ...b });
    return send(c, await readAccount(ctx, safe));
  });

  // ------------------------------------------------------------------------------------------------ rules
  app.get("/v1/accounts/:safe/rules", async (c) => {
    const a = await readAccount(ctx, safeParam(c));
    return send(c, { config: a.config, rules: a.rules, allowlist: a.allowlist, services: a.services, treasuryVaults: a.treasuryVaults, splits: a.splits, approver: a.approver, guardian: a.guardian });
  });
  app.post("/v1/accounts/:safe/rules/prepare", async (c) => {
    const safe = safeParam(c);
    const change = await body(c, zRuleChange);
    return send(c, await prepareSafeTx(ctx, safe, ruleChangeCalls(ctx, change), "Change this agent's rules."));
  });
  app.post("/v1/accounts/:safe/template/prepare", async (c) => {
    const safe = safeParam(c);
    const { template } = await body(c, z.object({ template: z.string() }));
    const a = await readAccount(ctx, safe);
    const s = setupFromTemplate(ctx, template, { agent: a.config.agent, cosigner: a.config.cosigner });
    return send(c, await prepareSafeTx(ctx, safe, ruleChangeCalls(ctx, { config: s.config, rules: s.rules }), `Apply the "${getTemplate(template).name}" rules.`));
  });
  app.post("/v1/accounts/:safe/freeze/prepare", (c) => send(c, prepareModuleCall(ctx, "freeze", [safeParam(c)], "Freeze this agent now. No payment can leave until you unfreeze it.")));
  app.post("/v1/accounts/:safe/unfreeze/prepare", (c) => send(c, prepareModuleCall(ctx, "unfreeze", [safeParam(c)], "Unfreeze this agent.")));
  app.post("/v1/accounts/:safe/recovery/cancel/prepare", (c) => send(c, prepareModuleCall(ctx, "cancelRecovery", [safeParam(c)], "Cancel the pending recovery. The owners stay as they are.")));
  app.post("/v1/accounts/:safe/passkey/prepare", async (c) => {
    const b = await body(c, z.object({ x: z.string(), y: z.string() }));
    return send(c, await preparePasskeySetup(ctx, safeParam(c), b.x as Hex, b.y as Hex));
  });

  // ------------------------------------------------------------------------------------------------ API keys
  app.get("/v1/accounts/:safe/keys", async (c) => {
    const safe = safeParam(c);
    await safeOwner(ctx, c, safe);
    return send(c, { items: listApiKeys(ctx, safe), next: null });
  });
  app.post("/v1/accounts/:safe/keys", async (c) => {
    const safe = safeParam(c);
    await safeOwner(ctx, c, safe);
    const b = await body(c, z.object({ name: z.string().max(60).optional(), scopes: z.array(z.enum(["pay", "models", "x402", "call", "sell", "read", "treasury", "recurring", "invoices"])).optional(), managed: z.boolean().default(true) }));
    const { key, secret } = createApiKey(ctx, { safe, ...b });
    await ctx.audit.append(`owner`, "key.created", safe, { key: key.id, scopes: key.scopes, session: key.sessionAddress });
    return send(c, { key, secret, note: key.sessionAddress ? "Set the session address as this account's agent (rules) before the key can pay." : null }, 201);
  });
  app.delete("/v1/accounts/:safe/keys/:id", async (c) => {
    const safe = safeParam(c);
    await safeOwner(ctx, c, safe);
    revokeApiKey(ctx, param(c, "id"), safe);
    await ctx.audit.append(`owner`, "key.revoked", safe, { key: param(c, "id") });
    return send(c, { ok: true });
  });

  // ------------------------------------------------------------------------------------------------ payments
  const zPay = z.object({
    to: zAddr,
    token: zAddr.optional(),
    amount: zAmount,
    service: z.string().optional(),
    memo: z.string().max(280).optional(),
    trigger: z.string().max(20000).optional(),
    taskId: z.string().max(80).optional(),
    customer: z.string().max(80).optional(),
    category: z.enum(["model", "x402", "onchain", "transfer", "internal", "storefront"]).default("transfer"),
    cosignature: zHex.optional(),
  });
  app.post("/v1/pay", async (c) => {
    const auth = agent(ctx, c, "pay");
    const b = await body(c, zPay);
    const dep = requireDep(ctx);
    const internal = !!ctx.db.prepare("SELECT 1 FROM accounts WHERE safe = ?").get(b.to);
    const res = await submitIntent(ctx, {
      safe: auth.safe,
      spec: { kind: "pay", pay: { token: b.token ?? dep.usdg, to: b.to, amount: BigInt(b.amount), service: b.service } },
      category: internal && b.category === "transfer" ? "internal" : b.category,
      signer: auth.session,
      meta: { memo: b.memo, trigger: b.trigger, taskId: b.taskId, customer: b.customer },
      cosignature: b.cosignature,
    });
    return send(c, res, res.intent.status === "blocked" ? 422 : 200);
  });

  app.post("/v1/firewall/check", async (c) => {
    const auth = agent(ctx, c, "pay");
    const b = await body(c, zPay);
    const res = await submitIntent(ctx, {
      safe: auth.safe,
      spec: { kind: "pay", pay: { token: b.token ?? requireDep(ctx).usdg, to: b.to, amount: BigInt(b.amount), service: b.service } },
      category: b.category,
      signer: auth.session,
      meta: { memo: b.memo, trigger: b.trigger },
      dryRun: true,
    });
    return send(c, res.verdict);
  });

  /** Agents that keep their own session key sign the EIP-712 intent and send it here. */
  app.post("/v1/intents", async (c) => {
    const b = await body(
      c,
      z.object({
        kind: z.enum(["pay", "call"]),
        safe: zAddr,
        nonce: zAmount,
        deadline: zAmount,
        signature: zHex,
        pay: z.object({ token: zAddr, to: zAddr, amount: zAmount, service: z.string().optional() }).optional(),
        call: z.object({ target: zAddr, value: zAmount.default("0"), data: zHex, spendToken: zAddr.default(ZERO), spendLimit: zAmount.default("0") }).optional(),
        category: z.enum(["model", "x402", "onchain", "transfer", "internal", "storefront", "swap"]).default("transfer"),
        memo: z.string().max(280).optional(),
        trigger: z.string().max(20000).optional(),
        cosignature: zHex.optional(),
      }),
    );
    const spec =
      b.kind === "pay" && b.pay
        ? ({ kind: "pay", pay: { token: b.pay.token, to: b.pay.to, amount: BigInt(b.pay.amount), service: b.pay.service } } as const)
        : b.call
          ? ({ kind: "call", call: { target: b.call.target, value: BigInt(b.call.value), data: b.call.data, spendToken: b.call.spendToken, spendLimit: BigInt(b.call.spendLimit) } } as const)
          : fail(400, "bad_request", "pay or call is required");
    const res = await submitIntent(ctx, { safe: b.safe, spec, category: b.category, signature: b.signature, nonce: BigInt(b.nonce), deadline: BigInt(b.deadline), meta: { memo: b.memo, trigger: b.trigger }, cosignature: b.cosignature });
    return send(c, res, res.intent.status === "blocked" ? 422 : 200);
  });
  app.get("/v1/intents/:id", (c) => send(c, getIntent(ctx, param(c, "id")) ?? fail(404, "not_found", "No such intent.")));
  app.post("/v1/intents/:id/cosign", async (c) => {
    const { signature } = await body(c, z.object({ signature: zHex }));
    return send(c, await resumeIntent(ctx, param(c, "id"), signature));
  });
  app.get("/v1/accounts/:safe/intents", (c) => send(c, { items: listIntents(ctx, { safe: safeParam(c), status: c.req.query("status"), limit: qInt(c, "limit") }), next: null }));

  // ------------------------------------------------------------------------------------------------ receipts
  app.get("/v1/accounts/:safe/receipts", (c) =>
    send(c, listReceipts(ctx, { safe: safeParam(c), direction: c.req.query("direction"), category: c.req.query("category"), before: qInt(c, "before"), limit: qInt(c, "limit") })),
  );
  app.get("/v1/receipts", (c) => send(c, listReceipts(ctx, { direction: c.req.query("direction"), category: c.req.query("category"), before: qInt(c, "before"), limit: qInt(c, "limit") })));
  app.get("/v1/receipts/:id", (c) => send(c, getReceipt(ctx, param(c, "id")) ?? fail(404, "not_found", "No such receipt.")));

  // ------------------------------------------------------------------------------------------------ approvals
  app.get("/v1/accounts/:safe/approvals", (c) => send(c, { items: listApprovals(ctx, safeParam(c), c.req.query("all") === "1"), next: null }));
  app.get("/v1/approvals", (c) => send(c, { items: listApprovals(ctx, undefined, c.req.query("all") === "1"), next: null }));
  app.get("/v1/approvals/:id", (c) => send(c, getApproval(ctx, param(c, "id"))));
  app.post("/v1/approvals/:id/prepare", async (c) => {
    const { decision } = await body(c, z.object({ decision: z.enum(["approve", "reject"]) }));
    return send(c, prepareDecision(ctx, param(c, "id"), decision === "approve"));
  });
  app.post("/v1/approvals/:id/passkey", async (c) => {
    const b = await body(c, z.object({ decision: z.enum(["approve", "reject"]), assertion: zAssertion }));
    return send(c, await decideWithPasskey(ctx, param(c, "id"), b.decision === "approve", b.assertion));
  });
  app.post("/v1/approvals/:id/resume", async (c) => send(c, await resumeIntent(ctx, param(c, "id"))));

  // ------------------------------------------------------------------------------------------------ firewall verdicts
  app.get("/v1/verdicts", (c) => send(c, { items: listVerdicts(ctx, { decision: c.req.query("decision"), limit: qInt(c, "limit") }), next: null }));
  app.get("/v1/accounts/:safe/verdicts", (c) => send(c, { items: listVerdicts(ctx, { safe: safeParam(c), decision: c.req.query("decision"), limit: qInt(c, "limit") }), next: null }));
  app.get("/v1/verdicts/:id", (c) => send(c, getVerdict(ctx, param(c, "id")) ?? fail(404, "not_found", "No such verdict.")));

  // ------------------------------------------------------------------------------------------------ templates
  app.get("/v1/templates", (c) => send(c, { items: TEMPLATES, next: null }));
  app.get("/v1/templates/:id", (c) => send(c, getTemplate(param(c, "id"))));

  // ------------------------------------------------------------------------------------------------ test mode (local node only)
  if (ctx.cfg.testMode) {
    app.post("/v1/testmode/session", (c) => {
      const o = ctx.chain.accounts.owner ?? fail(403, "not_test_mode", "No test owner.");
      return send(c, { ...issueOwnerSession(ctx, o.address), agent: ctx.chain.accounts.agent?.address ?? null });
    });
    app.post("/v1/testmode/accounts", async (c) => {
      const b = await body(c, z.object({ name: z.string().default("Test agent"), kind: z.string().optional(), template: z.string().default("research"), fund: zAmount.default("1000000000"), public: z.boolean().default(true), agent: zAddr.optional() }));
      const o = ctx.chain.accounts.owner ?? fail(403, "not_test_mode", "No test owner.");
      const agentAddr = b.agent ?? ctx.chain.accounts.agent?.address ?? fail(400, "bad_request", "agent required");
      const setup = setupFromTemplate(ctx, b.template, { agent: agentAddr, agentURI: `https://purseragents.fun/agents/${encodeURIComponent(b.name)}.json` });
      const { predictedSafe, tx } = await prepareCreate(ctx, { owners: [o.address], creator: o.address, setup, salt: BigInt(now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)) });
      const r = await sendAsTestOwner(ctx, tx);
      await ingestReceipt(ctx, r);
      await fundForTest(ctx, predictedSafe, BigInt(b.fund));
      upsertAccount(ctx, { safe: predictedSafe, name: b.name, kind: b.kind ?? getTemplate(b.template).kind, owners: [o.address], public: b.public, template: b.template });
      applyTemplateAlerts(ctx, predictedSafe, b.template);
      return send(c, await readAccount(ctx, predictedSafe), 201);
    });
    app.post("/v1/testmode/safe-tx", async (c) => {
      const b = await body(c, z.object({ safe: zAddr, to: zAddr, value: zAmount.default("0"), data: zHex, operation: z.union([z.literal(0), z.literal(1)]), safeTxHash: zBytes32, nonce: zAmount, chainId: z.number(), typedData: z.any().optional(), description: z.string().default("") }));
      const r = await execAsTestOwner(ctx, { ...b, typedData: b.typedData ?? null });
      await ingestReceipt(ctx, r);
      return send(c, { txHash: r.transactionHash });
    });
    app.post("/v1/testmode/tx", async (c) => {
      const b = await body(c, z.object({ to: zAddr, data: zHex, value: zAmount.default("0"), chainId: z.number().optional(), description: z.string().default("") }));
      const r = await sendAsTestOwner(ctx, { ...b, chainId: ctx.cfg.chainId });
      await ingestReceipt(ctx, r);
      return send(c, { txHash: r.transactionHash });
    });
    app.post("/v1/testmode/approvals/:id", async (c) => {
      const { decision } = await body(c, z.object({ decision: z.enum(["approve", "reject"]) }));
      return send(c, { result: await decideAsTestOwner(ctx, param(c, "id"), decision === "approve") });
    });
    app.post("/v1/testmode/fund", async (c) => {
      const b = await body(c, z.object({ to: zAddr, amount: zAmount }));
      await fundForTest(ctx, b.to, BigInt(b.amount));
      return send(c, { ok: true });
    });
  }
}

/** Test mode: gives an address test USDG (mint on a local chain, a transfer from a large holder on a fork). */
export async function fundForTest(ctx: Ctx, to: Address, amount: bigint) {
  const dep = requireDep(ctx);
  const rpc = (m: string, p: unknown[]) => ctx.chain.pub.request({ method: m as never, params: p as never });
  if (dep.mode === "local") {
    await ctx.chain.send(ctx.chain.accounts.relayer!, { to: dep.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [lower(to), amount] }) });
  } else {
    const whale = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca";
    await rpc("anvil_impersonateAccount", [whale]);
    await rpc("anvil_setBalance", [whale, "0xDE0B6B3A7640000"]);
    await rpc("eth_sendTransaction", [{ from: whale, to: dep.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [lower(to), amount] }) }]);
    await rpc("anvil_stopImpersonatingAccount", [whale]);
  }
  await rpc("anvil_setBalance", [lower(to), "0xDE0B6B3A7640000"]);
}
