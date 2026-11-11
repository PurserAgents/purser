import type { Hono } from "hono";
import type { Address } from "viem";
import { z } from "zod";
import { erc4626Abi } from "../../packages/sdk/src/abi.ts";
import type { Treasury, TreasuryVault } from "../../packages/sdk/src/schema.ts";
import { balanceOf, prepareSafeTx, readRule, ruleChangeCalls, setsOf } from "./accounts.ts";
import { registerRoutes } from "./api/registry.ts";
import { agent, body, safeParam, send, zAddr, zAmount } from "./api/http.ts";
import { requireDep, type Ctx } from "./ctx.ts";
import { kvSet } from "./db.ts";
import { submitIntent } from "./intents.ts";
import { fail, lower, sameAddress, ZERO } from "./util.ts";

export const SLIPPAGE_BPS = 50n; // 0.5% on share prices

export async function vaultInfo(ctx: Ctx, vault: Address): Promise<TreasuryVault> {
  const [asset, name, total] = await Promise.all([
    ctx.chain.pub.readContract({ address: vault, abi: erc4626Abi, functionName: "asset" }),
    ctx.chain.pub.readContract({ address: vault, abi: erc4626Abi, functionName: "name" }).catch(() => "Vault"),
    ctx.chain.pub.readContract({ address: vault, abi: erc4626Abi, functionName: "totalAssets" }),
  ]);
  const info = await ctx.tokens.info(asset);
  kvSet(ctx.db, `vault_asset:${lower(vault)}`, lower(asset));
  return { address: lower(vault), name, asset: info, totalAssets: ctx.tokens.money(asset, total), kind: "erc4626" };
}

/** Idle money: what sits liquid in the Safe, what sits in each allowed vault (in assets), and the keep-liquid floor. */
export async function readTreasury(ctx: Ctx, safe: Address): Promise<Treasury> {
  const dep = requireDep(ctx);
  const allowed = setsOf(ctx, safe, "vault") as Address[];
  const positions = [];
  for (const v of allowed) {
    const vault = await vaultInfo(ctx, v);
    const shares = await ctx.chain.pub.readContract({ address: v, abi: erc4626Abi, functionName: "balanceOf", args: [safe] });
    const assets = shares > 0n ? await ctx.chain.pub.readContract({ address: v, abi: erc4626Abi, functionName: "convertToAssets", args: [shares] }) : 0n;
    positions.push({ vault, shares: shares.toString(), assets: ctx.tokens.money(vault.asset.address, assets) });
  }
  const tokens = [dep.usdg, ZERO as Address];
  const liquid = await Promise.all(tokens.map(async (t) => ctx.tokens.money(t, await balanceOf(ctx, t, safe))));
  const keep = await Promise.all(tokens.map(async (t) => ({ token: ctx.tokens.infoSync(t), amount: (await readRule(ctx, safe, t)).keepLiquid.toString() })));
  return { safe: lower(safe), liquid, positions, allowedVaults: allowed.map(lower), keepLiquid: keep };
}

async function move(ctx: Ctx, auth: { safe: Address; session: import("viem/accounts").PrivateKeyAccount | null }, vault: Address, deposit: boolean, assets: bigint, memo: string) {
  if (!setsOf(ctx, auth.safe, "vault").some((v) => sameAddress(v, vault))) fail(400, "vault_not_allowed", "The owner has not allowed this vault for the account.");
  await vaultInfo(ctx, vault);
  const preview = await ctx.chain.pub.readContract({ address: vault, abi: erc4626Abi, functionName: deposit ? "previewDeposit" : "previewWithdraw", args: [assets] });
  const limit = deposit ? (preview * (10_000n - SLIPPAGE_BPS)) / 10_000n : (preview * (10_000n + SLIPPAGE_BPS)) / 10_000n + 1n;
  return submitIntent(ctx, { safe: auth.safe, spec: { kind: "treasury", treasury: { vault, deposit, assets, limit } }, category: "treasury", signer: auth.session, meta: { memo } });
}

registerRoutes((app: Hono, ctx: Ctx) => {
  app.get("/v1/treasury/vaults", async (c) => {
    const dep = requireDep(ctx);
    const items = [];
    for (const v of dep.vaults) items.push(await vaultInfo(ctx, v).catch(() => null));
    return send(c, { items: items.filter(Boolean), next: null });
  });
  app.get("/v1/accounts/:safe/treasury", async (c) => send(c, await readTreasury(ctx, safeParam(c))));
  app.post("/v1/accounts/:safe/treasury/prepare", async (c) => {
    const safe = safeParam(c);
    const b = await body(c, z.object({ vaults: z.array(zAddr).default([]), removeVaults: z.array(zAddr).default([]), keepLiquid: zAmount.optional() }));
    const rule = b.keepLiquid !== undefined ? await readRule(ctx, safe, requireDep(ctx).usdg) : null;
    const calls = ruleChangeCalls(ctx, {
      vaults: b.vaults,
      removeVaults: b.removeVaults,
      rules: rule
        ? [{ token: requireDep(ctx).usdg, rule: { ...Object.fromEntries(Object.entries(rule).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])), keepLiquid: b.keepLiquid } as never }]
        : undefined,
    });
    return send(c, await prepareSafeTx(ctx, safe, calls, "Choose where idle money may earn, and how much stays liquid."));
  });
  app.post("/v1/treasury/deposit", async (c) => {
    const auth = agent(ctx, c, "treasury");
    const b = await body(c, z.object({ vault: zAddr, amount: zAmount }));
    const r = await move(ctx, auth, b.vault, true, BigInt(b.amount), "Idle money into the vault");
    return send(c, r, r.intent.status === "blocked" ? 422 : 200);
  });
  app.post("/v1/treasury/withdraw", async (c) => {
    const auth = agent(ctx, c, "treasury");
    const b = await body(c, z.object({ vault: zAddr, amount: zAmount }));
    const r = await move(ctx, auth, b.vault, false, BigInt(b.amount), "Money back from the vault");
    return send(c, r, r.intent.status === "blocked" ? 422 : 200);
  });
  /** Moves everything above the keep-liquid floor (plus a buffer) into the first allowed vault. */
  app.post("/v1/treasury/sweep", async (c) => {
    const auth = agent(ctx, c, "treasury");
    const b = await body(c, z.object({ buffer: zAmount.default("0") }));
    const dep = requireDep(ctx);
    const vault = (setsOf(ctx, auth.safe, "vault")[0] as Address | undefined) ?? fail(400, "no_vault", "The owner has not allowed a vault yet.");
    const bal = await balanceOf(ctx, dep.usdg, auth.safe);
    const keep = (await readRule(ctx, auth.safe, dep.usdg)).keepLiquid + BigInt(b.buffer);
    if (bal <= keep) return send(c, { moved: "0", reason: "Nothing above the keep-liquid amount." });
    const r = await move(ctx, auth, vault, true, bal - keep, "Sweep idle money into the vault");
    return send(c, r, r.intent.status === "blocked" ? 422 : 200);
  });
});
