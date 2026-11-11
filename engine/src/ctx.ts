import type { Audit } from "./audit.ts";
import type { Bus } from "./bus.ts";
import type { Chain } from "./chain.ts";
import type { Config, Deployment } from "./config.ts";
import type { DB } from "./db.ts";
import type { Tokens } from "./tokens.ts";
import { fail } from "./util.ts";

/** Everything a feature needs, passed explicitly. */
export interface Ctx {
  cfg: Config;
  db: DB;
  chain: Chain;
  dep: Deployment | null;
  tokens: Tokens;
  audit: Audit;
  bus: Bus;
  hooks: {
    afterExecuted: ((safe: string, intentId: string) => Promise<void> | void)[];
  };
}

export function requireDep(ctx: Ctx): Deployment {
  return ctx.dep ?? fail(503, "no_deployment", "The engine has no Purser deployment configured (run test mode).");
}

/** The chain's clock (never behind the wall clock). A local test node can be moved forward in time. */
export async function chainNow(ctx: Ctx): Promise<number> {
  const wall = Math.floor(Date.now() / 1000);
  try {
    const b = await ctx.chain.pub.getBlock({ blockTag: "latest" });
    return Math.max(Number(b.timestamp), wall);
  } catch {
    return wall;
  }
}
