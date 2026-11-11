import { encodeFunctionData, encodePacked, keccak256, type Address, type Hex } from "viem";
import { purserModuleAbi, purserPasskeyAbi } from "../../packages/sdk/src/abi.ts";
import type { PayResult, PendingApproval, PreparedSafeTx, PreparedTx } from "../../packages/sdk/src/schema.ts";
import { prepareModuleCall, prepareSafeTx, sendAsTestOwner } from "./accounts.ts";
import { explainRevert } from "./chain.ts";
import { requireDep, type Ctx } from "./ctx.ts";
import { registerTask } from "./engine.ts";
import { ingestReceipt } from "./indexer.ts";
import { resumeIntent } from "./intents.ts";
import { getIntentRow, intentFromRow, type IntentRow } from "./receipts.ts";
import { fail, lower } from "./util.ts";

export const rejectChallenge = (digest: Hex): Hex => keccak256(encodePacked(["string", "bytes32"], ["reject", digest]));

function toPending(ctx: Ctx, r: IntentRow): PendingApproval {
  const i = intentFromRow(ctx, r);
  return {
    id: r.id,
    safe: i.safe,
    digest: i.digest,
    rejectChallenge: rejectChallenge(i.digest),
    summary: i.summary,
    money: i.money,
    to: i.to,
    status: r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : "queued",
    createdAt: i.createdAt,
  };
}

export function listApprovals(ctx: Ctx, safe?: string, all = false): PendingApproval[] {
  const states = all ? "('queued','approved','rejected')" : "('queued')";
  const rows = (
    safe
      ? ctx.db.prepare(`SELECT * FROM intents WHERE safe = ? AND status IN ${states} ORDER BY created_at DESC`).all(lower(safe))
      : ctx.db.prepare(`SELECT * FROM intents WHERE status IN ${states} ORDER BY created_at DESC`).all()
  ) as IntentRow[];
  return rows.map((r) => toPending(ctx, r));
}

export function getApproval(ctx: Ctx, iid: string): PendingApproval {
  const r = getIntentRow(ctx, iid) ?? fail(404, "not_found", "No such approval.");
  return toPending(ctx, r);
}

/** The transaction an owner wallet sends to approve or reject (direct call to the module, no Safe transaction). */
export function prepareDecision(ctx: Ctx, iid: string, approve: boolean): PreparedTx {
  const p = getApproval(ctx, iid);
  return prepareModuleCall(ctx, approve ? "approveIntent" : "rejectIntent", [p.safe, p.digest], `${approve ? "Approve" : "Reject"}: ${p.summary}`);
}

export interface PasskeyAssertion {
  authenticatorData: Hex;
  clientDataJSON: string;
  challengeIndex: number;
  typeIndex: number;
  r: Hex | string;
  s: Hex | string;
}

/** Submits a passkey approval (or rejection) through PurserPasskey; anyone may relay it. */
export async function decideWithPasskey(ctx: Ctx, iid: string, approve: boolean, a: PasskeyAssertion): Promise<{ txHash: Hex; result: PayResult | null }> {
  const dep = requireDep(ctx);
  const p = getApproval(ctx, iid);
  const relayer = ctx.chain.accounts.relayer ?? fail(503, "no_relayer", "This engine does not relay transactions.");
  const assertion = {
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    challengeIndex: BigInt(a.challengeIndex),
    typeIndex: BigInt(a.typeIndex),
    r: BigInt(a.r),
    s: BigInt(a.s),
  };
  let receipt;
  try {
    receipt = await ctx.chain.send(relayer, {
      to: dep.passkey,
      data: encodeFunctionData({ abi: purserPasskeyAbi, functionName: approve ? "approve" : "reject", args: [p.safe, p.digest, assertion] }),
    });
  } catch (e) {
    return fail(400, "passkey_refused", explainRevert(e));
  }
  if (receipt.status !== "success") fail(400, "passkey_refused", "The passkey approval was refused on chain.");
  await ingestReceipt(ctx, receipt);
  await ctx.audit.append(`owner:passkey`, approve ? "approval.passkey_approved" : "approval.passkey_rejected", p.safe, { intent: iid, tx: receipt.transactionHash });
  const result = approve ? await resumeIntent(ctx, iid) : null;
  return { txHash: receipt.transactionHash, result };
}

/** Registers a passkey for approvals: setPasskey on PurserPasskey and setApprover on the module, as one Safe tx. */
export function preparePasskeySetup(ctx: Ctx, safe: Address, x: Hex | string, y: Hex | string): Promise<PreparedSafeTx> {
  const dep = requireDep(ctx);
  return prepareSafeTx(
    ctx,
    safe,
    [
      { to: dep.passkey, data: encodeFunctionData({ abi: purserPasskeyAbi, functionName: "setPasskey", args: [BigInt(x), BigInt(y)] }) },
      { to: dep.module, data: encodeFunctionData({ abi: purserModuleAbi, functionName: "setApprover", args: [dep.passkey] }) },
    ],
    "Use this passkey to approve payments from your phone.",
  );
}

/** Test mode: the test owner wallet approves or rejects, then the intent resumes. */
export async function decideAsTestOwner(ctx: Ctx, iid: string, approve: boolean): Promise<PayResult | null> {
  const r = await sendAsTestOwner(ctx, prepareDecision(ctx, iid, approve));
  await ingestReceipt(ctx, r);
  return approve ? resumeIntent(ctx, iid) : null;
}

/** Approved intents run by themselves: the indexer marks them approved, this task sends them. */
registerTask({
  name: "approvals",
  every: 3000,
  async run(ctx) {
    const rows = ctx.db.prepare("SELECT id FROM intents WHERE status = 'approved' LIMIT 10").all() as { id: string }[];
    for (const r of rows) {
      try {
        await resumeIntent(ctx, r.id);
      } catch {
        /* reported on the intent */
      }
    }
  },
});
