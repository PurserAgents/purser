import { keccak256, recoverMessageAddress, toHex, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { AuditEntry, AuditVerifyResult } from "../../packages/sdk/src/schema.ts";
import type { DB } from "./db.ts";
import { now, sameAddress } from "./util.ts";

const GENESIS = ("0x" + "00".repeat(32)) as Hex;

/** Deterministic JSON: sorted keys, bigints as strings. Used for hashing audit entries. */
export function canonical(v: unknown): string {
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export function entryHash(e: Omit<AuditEntry, "hash" | "signature">): Hex {
  return keccak256(
    toHex(canonical({ seq: e.seq, ts: e.ts, actor: e.actor, action: e.action, safe: e.safe, data: e.data, prevHash: e.prevHash })),
  );
}

export type Audit = ReturnType<typeof makeAudit>;

/** Every engine action is appended here: hash-chained (each entry commits to the previous) and signed. */
export function makeAudit(db: DB, signer: PrivateKeyAccount) {
  const insert = db.prepare(
    "INSERT INTO audit (seq, ts, actor, action, safe, data, prev_hash, hash, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  let chain: Promise<unknown> = Promise.resolve();

  function last(): { seq: number; hash: Hex } {
    const row = db.prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; hash: Hex }
      | undefined;
    return row ?? { seq: 0, hash: GENESIS };
  }

  async function append(actor: string, action: string, safe: string | null, data: Record<string, unknown>) {
    const run = chain.then(async () => {
      const prev = last();
      const base = {
        seq: prev.seq + 1,
        ts: now(),
        actor,
        action,
        safe: (safe?.toLowerCase() ?? null) as Address | null,
        data: JSON.parse(canonical(data)) as Record<string, unknown>,
        prevHash: prev.hash,
      };
      const hash = entryHash(base);
      const signature = await signer.signMessage({ message: { raw: hash } });
      insert.run(base.seq, base.ts, actor, action, base.safe, JSON.stringify(base.data), base.prevHash, hash, signature);
      return { ...base, hash, signature } as AuditEntry;
    });
    chain = run.catch(() => undefined);
    return run;
  }

  function list(opts: { safe?: string; limit?: number; before?: number } = {}): AuditEntry[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.safe) {
      where.push("safe = ?");
      args.push(opts.safe.toLowerCase());
    }
    if (opts.before) {
      where.push("seq < ?");
      args.push(opts.before);
    }
    const rows = db
      .prepare(
        `SELECT * FROM audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...args, opts.limit ?? 100) as Row[];
    return rows.map(toEntry);
  }

  function exportAll(): AuditEntry[] {
    return (db.prepare("SELECT * FROM audit ORDER BY seq ASC").all() as Row[]).map(toEntry);
  }

  return { append, list, exportAll, signer: signer.address };
}

interface Row {
  seq: number;
  ts: number;
  actor: string;
  action: string;
  safe: string | null;
  data: string;
  prev_hash: Hex;
  hash: Hex;
  signature: Hex;
}

const toEntry = (r: Row): AuditEntry => ({
  seq: r.seq,
  ts: r.ts,
  actor: r.actor,
  action: r.action,
  safe: r.safe as Address | null,
  data: JSON.parse(r.data),
  prevHash: r.prev_hash,
  hash: r.hash,
  signature: r.signature,
});

/** Verifies a full export: every hash recomputed, every link to the previous entry, every signature. */
export async function verifyAudit(entries: AuditEntry[], expectedSigner?: Address): Promise<AuditVerifyResult> {
  let prev = GENESIS;
  let signer: Address | null = expectedSigner ?? null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const fail = (problem: string): AuditVerifyResult => ({
      ok: false,
      entries: entries.length,
      signer: (signer ?? "0x") as Address,
      brokenAt: e.seq,
      problem,
    });
    if (e.seq !== i + 1) return fail(`entry ${i + 1} is missing or out of order`);
    if (e.prevHash !== prev) return fail(`entry ${e.seq} does not link to the entry before it`);
    if (entryHash(e) !== e.hash) return fail(`entry ${e.seq} was changed after it was written`);
    const who = await recoverMessageAddress({ message: { raw: e.hash }, signature: e.signature });
    if (!signer) signer = who;
    if (!sameAddress(who, signer)) return fail(`entry ${e.seq} is signed by another key`);
    prev = e.hash;
  }
  return { ok: true, entries: entries.length, signer: (signer ?? "0x") as Address, brokenAt: null, problem: null };
}
