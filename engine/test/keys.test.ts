import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ALL_SCOPES,
  authAgent,
  authOwner,
  createApiKey,
  issueOwnerSession,
  listApiKeys,
  newSignInNonce,
  openSessionKey,
  requireSafeOwner,
  revokeApiKey,
  sealSessionKey,
  signInMessage,
  verifySignIn,
} from "../src/keys.ts";
import { ApiFailure } from "../src/util.ts";
import { createAccount, makeOfflineEngine, makeWorld, randomAddress, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

const rejectsWith = (status: number, code?: string) => (e: unknown) => e instanceof ApiFailure && e.status === status && (!code || e.code === code);

describe("agent API keys and the sealed session key (offline)", () => {
  const engine = makeOfflineEngine();
  const ctx = engine.ctx;
  const safe = randomAddress();
  after(() => ctx.db.close());

  it("seals a session key under the API secret; only the same secret and key id open it", () => {
    const pk = generatePrivateKey();
    const sealed = sealSessionKey(pk, "prs_secret", "key_1");
    assert.equal(openSessionKey(sealed, "prs_secret", "key_1"), pk);
    assert.notEqual(sealSessionKey(pk, "prs_secret", "key_1"), sealed, "a fresh IV every time");
    assert.throws(() => openSessionKey(sealed, "prs_other", "key_1"), "wrong secret");
    assert.throws(() => openSessionKey(sealed, "prs_secret", "key_2"), "wrong key id");
    const raw = Buffer.from(sealed, "base64");
    raw[raw.length - 1] ^= 1;
    assert.throws(() => openSessionKey(raw.toString("base64"), "prs_secret", "key_1"), "tampered ciphertext");
  });

  it("creates a managed key: the secret is shown once, only its hash is stored, the session key opens per request", () => {
    const { key, secret } = createApiKey(ctx, { safe, name: "main" });
    assert.match(secret, /^prs_/);
    assert.equal(key.prefix, secret.slice(0, 10));
    assert.deepEqual(key.scopes, ALL_SCOPES);
    assert.match(key.sessionAddress!, /^0x[0-9a-f]{40}$/);
    const row = ctx.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(key.id) as Record<string, string>;
    assert.equal(JSON.stringify(row).includes(secret), false, "the secret is never stored");
    assert.equal(row.session_enc.includes(key.sessionAddress!.slice(2)), false);
    const auth = authAgent(ctx, `Bearer ${secret}`, "pay");
    assert.equal(auth.safe, safe.toLowerCase());
    assert.equal(auth.session!.address.toLowerCase(), key.sessionAddress);
    assert.ok(listApiKeys(ctx, safe)[0].lastUsedAt, "use is recorded");
  });

  it("an unmanaged key has no session key; a given session key is kept; unknown scopes are dropped", () => {
    const self = createApiKey(ctx, { safe, managed: false, scopes: ["read"] });
    assert.equal(self.key.sessionAddress, null);
    assert.equal(authAgent(ctx, `Bearer ${self.secret}`, "read").session, null);
    const pk = generatePrivateKey();
    const given = createApiKey(ctx, { safe, sessionKey: pk });
    assert.equal(given.key.sessionAddress, privateKeyToAccount(pk).address.toLowerCase());
    const odd = createApiKey(ctx, { safe, scopes: ["pay", "admin" as never] });
    assert.deepEqual(odd.key.scopes, ["pay"]);
    const none = createApiKey(ctx, { safe, scopes: [] });
    assert.deepEqual(none.key.scopes, ALL_SCOPES, "an empty list means all scopes");
  });

  it("refuses missing, malformed, unknown, revoked and out-of-scope keys", () => {
    const { key, secret } = createApiKey(ctx, { safe, scopes: ["read", "x402"] });
    assert.throws(() => authAgent(ctx, undefined, "read"), rejectsWith(401, "unauthorized"));
    assert.throws(() => authAgent(ctx, "Bearer own_abc", "read"), rejectsWith(401, "unauthorized"));
    assert.throws(() => authAgent(ctx, "Bearer prs_unknown", "read"), rejectsWith(401, "unauthorized"));
    assert.throws(() => authAgent(ctx, `Bearer ${secret}`, "pay"), rejectsWith(403, "scope"));
    assert.ok(authAgent(ctx, `bearer   ${secret}`, "x402"), "the scheme is case-insensitive");
    assert.throws(() => revokeApiKey(ctx, key.id, randomAddress()), rejectsWith(404), "another account cannot revoke it");
    revokeApiKey(ctx, key.id, safe.toUpperCase().replace("0X", "0x"));
    assert.throws(() => authAgent(ctx, `Bearer ${secret}`, "read"), rejectsWith(401, "revoked"));
    assert.throws(() => revokeApiKey(ctx, key.id, safe), rejectsWith(404), "revoking twice");
    assert.throws(() => revokeApiKey(ctx, "key_nope", safe), rejectsWith(404));
    assert.ok(listApiKeys(ctx, safe).find((k) => k.id === key.id)!.revokedAt);
  });
});

describe("owner sign-in with a wallet signature (offline)", () => {
  const engine = makeOfflineEngine();
  const ctx = engine.ctx;
  const wallet = privateKeyToAccount(generatePrivateKey());
  after(() => ctx.db.close());

  const signIn = async (signer = wallet, address: Address = wallet.address) => {
    const nonce = newSignInNonce(ctx);
    const issued = Math.floor(Date.now() / 1000);
    const signature = await signer.signMessage({ message: signInMessage(address, nonce, issued) });
    return { address, nonce, issued, signature };
  };

  it("a signed nonce gives a 7-day session token that authenticates the wallet", async () => {
    const s = await verifySignIn(ctx, await signIn());
    assert.match(s.token, /^own_/);
    assert.equal(s.address, wallet.address.toLowerCase());
    assert.ok(s.expires - Date.now() / 1000 > 6.9 * 86400);
    assert.equal(authOwner(ctx, `Bearer ${s.token}`), wallet.address.toLowerCase());
    assert.equal(signInMessage("0xABC", "n", 1), "Purser sign-in\nAddress: 0xabc\nNonce: n\nIssued: 1");
  });

  it("a nonce works once", async () => {
    const req = await signIn();
    await verifySignIn(ctx, req);
    await assert.rejects(verifySignIn(ctx, req), rejectsWith(401, "bad_nonce"));
  });

  it("an expired or unknown nonce is refused", async () => {
    const req = await signIn();
    ctx.db.prepare("UPDATE auth_nonces SET expires = ? WHERE nonce = ?").run(Math.floor(Date.now() / 1000) - 1, req.nonce);
    await assert.rejects(verifySignIn(ctx, req), rejectsWith(401, "bad_nonce"));
    await assert.rejects(verifySignIn(ctx, { ...(await signIn()), nonce: "deadbeef" }), rejectsWith(401, "bad_nonce"));
  });

  it("a signature from another wallet, or over other words, is refused and burns the nonce", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const forged = await signIn(other, wallet.address);
    await assert.rejects(verifySignIn(ctx, forged), rejectsWith(401, "bad_signature"));
    await assert.rejects(verifySignIn(ctx, forged), rejectsWith(401, "bad_nonce"), "the nonce is gone after one try");
    const shifted = await signIn();
    await assert.rejects(verifySignIn(ctx, { ...shifted, issued: shifted.issued + 1 }), rejectsWith(401, "bad_signature"));
  });

  it("owner tokens: missing, agent-style, unknown and expired tokens are refused", () => {
    assert.throws(() => authOwner(ctx, undefined), rejectsWith(401));
    assert.throws(() => authOwner(ctx, "Bearer prs_abc"), rejectsWith(401));
    assert.throws(() => authOwner(ctx, "Bearer own_unknown"), rejectsWith(401));
    const s = issueOwnerSession(ctx, wallet.address);
    ctx.db.prepare("UPDATE owner_sessions SET expires = 0").run();
    assert.throws(() => authOwner(ctx, `Bearer ${s.token}`), rejectsWith(401));
  });

  it("over the API: bad bodies are 400, bad signatures 401", async () => {
    const a = api({ ctx } as World);
    assert.equal((await a.post("/v1/auth/nonce", { address: "nope" })).status, 400);
    const n = await a.post("/v1/auth/nonce", { address: wallet.address });
    assert.equal(n.status, 200);
    assert.equal(n.body.message, signInMessage(wallet.address, n.body.nonce, n.body.issued));
    assert.equal((await a.post("/v1/auth/verify", { address: wallet.address, nonce: n.body.nonce })).status, 400);
    const other = privateKeyToAccount(generatePrivateKey());
    const bad = await a.post("/v1/auth/verify", { address: wallet.address, nonce: n.body.nonce, issued: n.body.issued, signature: await other.signMessage({ message: n.body.message }) });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, "bad_signature");
  });
});

describe("Safe ownership checks for owner routes (local anvil)", () => {
  let w: World;
  let a: Api;
  let safe: Address;
  let owner: string;
  let stranger: string;
  before(async () => {
    w = await makeWorld();
    a = api(w);
    safe = await createAccount(w);
    owner = issueOwnerSession(w.ctx, w.owner.address).token;
    stranger = issueOwnerSession(w.ctx, randomAddress()).token;
  });
  after(async () => w?.stop());

  it("requireSafeOwner asks the Safe itself", async () => {
    assert.equal(await requireSafeOwner(w.ctx, `Bearer ${owner}`, safe), w.owner.address.toLowerCase());
    await assert.rejects(requireSafeOwner(w.ctx, `Bearer ${stranger}`, safe), rejectsWith(403, "not_owner"));
    await assert.rejects(requireSafeOwner(w.ctx, undefined, safe), rejectsWith(401));
  });

  it("key routes: 401 without a session, 403 for a stranger, 400 for bad input, 404 for an unknown key", async () => {
    assert.equal((await a.get(`/v1/accounts/${safe}/keys`)).status, 401);
    assert.equal((await a.get(`/v1/accounts/${safe}/keys`, stranger)).status, 403);
    assert.equal((await a.post(`/v1/accounts/${safe}/keys`, { name: "x" }, stranger)).status, 403);
    assert.equal((await a.get(`/v1/accounts/not-an-address/keys`, owner)).status, 400);
    const badScope = await a.post(`/v1/accounts/${safe}/keys`, { scopes: ["admin"] }, owner);
    assert.equal(badScope.status, 400);
    assert.match(badScope.body.error.message, /scopes/);
    assert.equal((await a.post(`/v1/accounts/${safe}/keys`, { name: "x".repeat(61) }, owner)).status, 400);
    assert.equal((await a.del(`/v1/accounts/${safe}/keys/key_nope`, owner)).status, 404);
    const k = await a.post(`/v1/accounts/${safe}/keys`, { name: "reader", scopes: ["read"], managed: false }, owner);
    assert.equal(k.status, 201);
    assert.equal(k.body.note, null, "no session address to set for an unmanaged key");
    assert.equal((await a.del(`/v1/accounts/${safe}/keys/${k.body.key.id}`, stranger)).status, 403);
    const me = await a.get("/v1/me", k.body.secret);
    assert.equal(me.status, 200);
    assert.equal(me.body.safe, safe.toLowerCase());
    assert.equal(me.body.sessionAddress, null);
    assert.equal((await a.get("/v1/me")).status, 401);
    assert.equal((await a.del(`/v1/accounts/${safe}/keys/${k.body.key.id}`, owner)).status, 200);
    assert.equal((await a.get("/v1/me", k.body.secret)).body.error.code, "revoked");
  });

  it("PATCH on an account needs its owner", async () => {
    assert.equal((await a.patch(`/v1/accounts/${safe}`, { name: "Hijacked" })).status, 401);
    assert.equal((await a.patch(`/v1/accounts/${safe}`, { name: "Hijacked" }, stranger)).status, 403);
    assert.equal((await a.patch(`/v1/accounts/${safe}`, { name: "" }, owner)).status, 400);
    assert.equal((await a.patch(`/v1/accounts/${safe}`, { name: "Renamed" }, owner)).body.name, "Renamed");
  });
});
