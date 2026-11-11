import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyMessage, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { safeAbi } from "../../packages/sdk/src/abi.ts";
import type { ApiKey, ApiScope } from "../../packages/sdk/src/schema.ts";
import type { Ctx } from "./ctx.ts";
import { fail, id, lower, now, parseJson } from "./util.ts";

export const ALL_SCOPES: ApiScope[] = ["pay", "models", "x402", "call", "sell", "read", "treasury", "recurring", "invoices"];

interface KeyRow {
  id: string;
  safe: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string;
  session_address: string | null;
  session_enc: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function kek(secret: string, keyId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from(keyId), Buffer.from("purser-session-key"), 32));
}

export function sealSessionKey(pk: Hex, secret: string, keyId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek(secret, keyId), iv);
  const ct = Buffer.concat([c.update(Buffer.from(pk.slice(2), "hex")), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function openSessionKey(sealed: string, secret: string, keyId: string): Hex {
  const raw = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", kek(secret, keyId), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return `0x${Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("hex")}` as Hex;
}

const toApiKey = (r: KeyRow): ApiKey => ({
  id: r.id,
  safe: r.safe as Address,
  name: r.name,
  prefix: r.prefix,
  scopes: parseJson<ApiScope[]>(r.scopes, []),
  sessionAddress: (r.session_address as Address) ?? null,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

/**
 * Creates an agent API key. With `managed`, the engine also creates the agent's session key and stores it
 * encrypted under a key derived from the API key secret; the owner then sets that address as the account's agent.
 * The secret is returned once and never stored.
 */
export function createApiKey(
  ctx: Ctx,
  input: { safe: string; name?: string; scopes?: ApiScope[]; managed?: boolean; sessionKey?: Hex },
): { key: ApiKey; secret: string } {
  const keyId = id("key");
  const secret = `prs_${randomBytes(24).toString("base64url")}`;
  let sessionAddress: Address | null = null;
  let sealed: string | null = null;
  if (input.managed !== false) {
    const pk = input.sessionKey ?? generatePrivateKey();
    sessionAddress = lower(privateKeyToAccount(pk).address);
    sealed = sealSessionKey(pk, secret, keyId);
  }
  const scopes = (input.scopes?.length ? input.scopes : ALL_SCOPES).filter((s) => ALL_SCOPES.includes(s));
  ctx.db
    .prepare(
      "INSERT INTO api_keys (id, safe, name, prefix, hash, scopes, session_address, session_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(keyId, lower(input.safe), input.name ?? "agent key", secret.slice(0, 10), sha256(secret), JSON.stringify(scopes), sessionAddress, sealed, now());
  const row = ctx.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(keyId) as KeyRow;
  return { key: toApiKey(row), secret };
}

export function listApiKeys(ctx: Ctx, safe: string): ApiKey[] {
  return (ctx.db.prepare("SELECT * FROM api_keys WHERE safe = ? ORDER BY created_at DESC").all(lower(safe)) as KeyRow[]).map(toApiKey);
}

export function revokeApiKey(ctx: Ctx, keyId: string, safe: string) {
  const r = ctx.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND safe = ? AND revoked_at IS NULL").run(now(), keyId, lower(safe));
  if (!r.changes) fail(404, "not_found", "No active key with this id for this account.");
}

export interface AgentAuth {
  key: ApiKey;
  safe: Address;
  session: PrivateKeyAccount | null;
}

/** Resolves `Authorization: Bearer prs_...` and checks the scope. Decrypts the session key for this request only. */
export function authAgent(ctx: Ctx, header: string | undefined, scope: ApiScope): AgentAuth {
  const secret = header?.replace(/^Bearer\s+/i, "").trim();
  if (!secret?.startsWith("prs_")) fail(401, "unauthorized", "An agent API key is required (Authorization: Bearer prs_...).");
  const row = ctx.db.prepare("SELECT * FROM api_keys WHERE hash = ?").get(sha256(secret!)) as KeyRow | undefined;
  if (!row || !timingSafeEqual(Buffer.from(row.hash), Buffer.from(sha256(secret!)))) fail(401, "unauthorized", "Unknown API key.");
  if (row!.revoked_at) fail(401, "revoked", "This API key was revoked.");
  const key = toApiKey(row!);
  if (!key.scopes.includes(scope)) fail(403, "scope", `This key may not use "${scope}".`);
  ctx.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), row!.id);
  const session = row!.session_enc ? privateKeyToAccount(openSessionKey(row!.session_enc, secret!, row!.id)) : null;
  return { key, safe: row!.safe as Address, session };
}

// ---------------------------------------------------------------------------------------------------- owner sign-in

export function signInMessage(address: string, nonce: string, issued: number) {
  return `Purser sign-in\nAddress: ${lower(address)}\nNonce: ${nonce}\nIssued: ${issued}`;
}

export function newSignInNonce(ctx: Ctx) {
  const nonce = randomBytes(16).toString("hex");
  ctx.db.prepare("INSERT INTO auth_nonces (nonce, expires) VALUES (?, ?)").run(nonce, now() + 600);
  return nonce;
}

export async function verifySignIn(ctx: Ctx, input: { address: Address; nonce: string; issued: number; signature: Hex }) {
  const n = ctx.db.prepare("DELETE FROM auth_nonces WHERE nonce = ? AND expires > ? RETURNING nonce").get(input.nonce, now());
  if (!n) fail(401, "bad_nonce", "The sign-in request expired. Ask for a new one.");
  const ok = await verifyMessage({ address: input.address, message: signInMessage(input.address, input.nonce, input.issued), signature: input.signature });
  if (!ok) fail(401, "bad_signature", "The signature does not match the address.");
  return issueOwnerSession(ctx, input.address);
}

export function issueOwnerSession(ctx: Ctx, address: string) {
  const token = `own_${randomBytes(24).toString("base64url")}`;
  const expires = now() + 7 * 86400;
  ctx.db.prepare("INSERT INTO owner_sessions (token, address, expires) VALUES (?, ?, ?)").run(sha256(token), lower(address), expires);
  return { token, address: lower(address), expires };
}

export function authOwner(ctx: Ctx, header: string | undefined): Address {
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token?.startsWith("own_")) fail(401, "unauthorized", "Sign in with an owner wallet first.");
  const row = ctx.db.prepare("SELECT address FROM owner_sessions WHERE token = ? AND expires > ?").get(sha256(token!), now()) as
    | { address: Address }
    | undefined;
  if (!row) fail(401, "unauthorized", "The session expired. Sign in again.");
  return row!.address;
}

/** The signed-in wallet must be an owner of the Safe (checked on chain). */
export async function requireSafeOwner(ctx: Ctx, header: string | undefined, safe: string): Promise<Address> {
  const who = authOwner(ctx, header);
  const ok = await ctx.chain.pub.readContract({ address: lower(safe), abi: safeAbi, functionName: "isOwner", args: [who] });
  if (!ok) fail(403, "not_owner", "This wallet is not an owner of the account.");
  return who;
}
