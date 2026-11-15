import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import type { Address } from "viem";
import { submitIntent } from "../src/intents.ts";
import { issueOwnerSession } from "../src/keys.ts";
import { readChainAccount } from "../src/accounts.ts";
import { buildStatement, encryptPush, localClock, noteFor, sendStatements, statementSentence } from "../src/pocket.ts";
import { createAccount, makeWorld, randomAddress, usdg, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

/** What a phone's push service and browser do: undo RFC 8291 with the browser's private key. */
function decryptPush(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, "a single record ends with the 0x02 delimiter");
  return plain.subarray(0, plain.length - 1).toString();
}

describe("pocket: Web Push encryption", () => {
  it("matches the RFC 8291 example byte for byte", () => {
    const out = encryptPush(
      Buffer.from("When I grow up, I want to be a watermelon"),
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      "BTBZMqHH6r4Tts7J_aSIgg",
      Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
      Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"),
    );
    assert.equal(
      out.toString("base64url"),
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("a fresh message decrypts with the browser's key", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = Buffer.from("0123456789abcdef");
    const body = encryptPush(Buffer.from('{"title":"hi"}'), ua.getPublicKey().toString("base64url"), auth.toString("base64url"));
    assert.equal(decryptPush(body, ua.getPrivateKey(), auth), '{"title":"hi"}');
  });

  it("knows the local day and hour in a time zone", () => {
    const t = Date.UTC(2026, 10, 15, 23, 30, 0) / 1000;
    assert.deepEqual(localClock(t, "UTC"), { day: "2026-11-15", hour: 23, sinceMidnight: 23 * 3600 + 1800 });
    assert.equal(localClock(t, "Asia/Tokyo").day, "2026-11-16");
    assert.equal(localClock(t, "Asia/Tokyo").hour, 8);
  });
});

describe("pocket: the owner's phone (local anvil)", () => {
  let w: World;
  let a: Api;
  let safe: Address;
  let other: Address;
  let ownerToken: string;
  let phone: string;
  let server: Server;
  let endpoint: string;
  const received: { headers: Record<string, string | string[] | undefined>; body: Buffer }[] = [];
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = Buffer.from("phone-auth-0001!");

  before(async () => {
    w = await makeWorld();
    a = api(w);
    safe = await createAccount(w, { name: "Research agent" });
    other = await createAccount(w, { name: "Ops agent", config: { watchdog: randomAddress() } });
    ownerToken = issueOwnerSession(w.ctx, w.owner.address).token;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(201).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/push/abc`;
  });
  after(async () => {
    server?.close();
    await w?.stop();
  });

  const waitFor = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return pred();
  };
  const messages = () => received.map((m) => JSON.parse(decryptPush(m.body, ua.getPrivateKey(), auth)) as { title: string; body: string; url: string });

  it("pairs a phone with a code from the signed-in owner; a code works once", async () => {
    assert.equal((await a.post("/v1/pocket/pair", {})).status, 401);
    const p = await a.post("/v1/pocket/pair", {}, ownerToken);
    assert.equal(p.status, 200);
    assert.match(p.body.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const before = await a.get(`/v1/pocket/pair/${p.body.code}`, ownerToken);
    assert.equal(before.body.claimed, false);
    assert.equal((await a.post("/v1/pocket/claim", { code: "AAAA-AAAA", name: "iPhone" })).status, 400);
    const x = "0x" + "11".repeat(32);
    const claim = await a.post("/v1/pocket/claim", { code: p.body.code.toLowerCase().replace("-", " "), name: "iPhone", tz: "Europe/Paris", passkey: { x, y: x, credentialId: "cred-1" } });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    assert.match(claim.body.token, /^dev_/);
    phone = claim.body.token;
    const again = await a.post("/v1/pocket/claim", { code: p.body.code, name: "Other" });
    assert.equal(again.status, 400);
    assert.match(again.body.error.message, /already used/);
    const afterClaim = await a.get(`/v1/pocket/pair/${p.body.code}`, ownerToken);
    assert.equal(afterClaim.body.claimed, true);
    assert.equal(afterClaim.body.device.name, "iPhone");
    assert.deepEqual(afterClaim.body.passkey.x, x, "the computer gets the phone's passkey to put on chain");
    const stranger = issueOwnerSession(w.ctx, randomAddress()).token;
    assert.equal((await a.get(`/v1/pocket/pair/${p.body.code}`, stranger)).status, 404);
  });

  it("the phone sees its owner's agents and which ones it may freeze", async () => {
    assert.equal((await a.get("/v1/pocket/me")).status, 401);
    assert.equal((await a.get("/v1/pocket/me", "dev_nope")).status, 401);
    const me = await a.get("/v1/pocket/me", phone);
    assert.equal(me.status, 200);
    assert.equal(me.body.owner, w.owner.address.toLowerCase());
    assert.equal(me.body.device.tz, "Europe/Paris");
    assert.equal(me.body.passkey, "cred-1");
    const names = me.body.accounts.map((x: { name: string }) => x.name).sort();
    assert.deepEqual(names, ["Ops agent", "Research agent"]);
    assert.equal(me.body.canFreeze[safe], true);
    assert.equal(me.body.canFreeze[other], false);
    assert.match(me.body.vapidKey, /^[A-Za-z0-9_-]{87}$/);
  });

  it("notifications: a payment waiting for approval and a blocked payment reach the phone, encrypted", async () => {
    w.ctx.db.prepare("INSERT INTO pocket_push (endpoint, device_id, p256dh, auth, created_at) SELECT ?, id, ?, ?, 0 FROM pocket_devices WHERE revoked = 0").run(endpoint, ua.getPublicKey().toString("base64url"), auth.toString("base64url"));
    received.length = 0;
    const queued = await submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to: randomAddress(), amount: usdg(220) } }, category: "transfer", signer: w.agent });
    assert.equal(queued.intent.status, "queued", queued.intent.error ?? "");
    const { indexOnce } = await import("../src/indexer.ts");
    await indexOnce(w.ctx);
    assert.ok(await waitFor(() => messages().some((m) => m.title.startsWith("Research agent wants to pay"))), JSON.stringify(messages()));
    const ap = messages().find((m) => m.title.startsWith("Research agent wants to pay"))!;
    assert.equal(ap.title, "Research agent wants to pay $220.00");
    assert.equal(ap.url, `/pocket?approve=${queued.intent.id}`);
    assert.match(String(received[0].headers.authorization), /^vapid t=[^.]+\.[^.]+\.[^,]+, k=[A-Za-z0-9_-]{87}$/);
    assert.equal(received[0].headers["content-encoding"], "aes128gcm");

    const blocked = await submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to: randomAddress(), amount: usdg(300) } }, category: "transfer", signer: w.agent });
    assert.equal(blocked.intent.status, "blocked");
    assert.ok(await waitFor(() => messages().some((m) => m.title.startsWith("Blocked: Research agent"))), JSON.stringify(messages()));
    assert.match(messages().find((m) => m.title.startsWith("Blocked"))!.body, /Nothing was paid\.$/);
  });

  it("a phone that turned blocked alerts off does not hear about them", async () => {
    const r = await a.patch("/v1/pocket/prefs", { blocked: false }, phone);
    assert.equal(r.status, 200);
    assert.equal(r.body.prefs.blocked, false);
    assert.equal(r.body.prefs.approvals, true, "approvals cannot be switched off");
    received.length = 0;
    await submitIntent(w.ctx, { safe, spec: { kind: "pay", pay: { token: w.dep.usdg, to: randomAddress(), amount: usdg(300) } }, category: "transfer", signer: w.agent });
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(messages().filter((m) => m.title.startsWith("Blocked")).length, 0);
    await a.patch("/v1/pocket/prefs", { blocked: true }, phone);
  });

  it("events that are not worth a buzz send nothing", () => {
    assert.equal(noteFor(w.ctx, { id: 1, type: "receipt", safe, ts: 0, data: {} } as never), null);
    assert.equal(noteFor(w.ctx, { id: 2, type: "watchdog", safe, ts: 0, data: { severity: "warn", action: "alert", title: "x" } } as never), null);
  });

  it("the feed: blocked payments with their reason, newest first, only this owner's agents", async () => {
    const f = await a.get("/v1/pocket/feed", phone);
    assert.equal(f.status, 200);
    const blocked = f.body.items.filter((x: { kind: string }) => x.kind === "blocked");
    assert.ok(blocked.length >= 2);
    assert.equal(blocked[0].name, "Research agent");
    assert.ok(blocked[0].text.length > 3);
    const times = f.body.items.map((x: { createdAt: number }) => x.createdAt);
    assert.deepEqual(times, [...times].sort((x: number, y: number) => y - x));
    assert.equal((await a.get("/v1/pocket/feed")).status, 401);
  });

  it("freezes from the phone with the watchdog key; refuses where the owner did not allow it; never unfreezes", async () => {
    const off = await a.post("/v1/pocket/freeze", { safes: [other] }, phone);
    assert.equal(off.status, 200);
    assert.equal(off.body.results[0].frozen, false);
    assert.match(off.body.results[0].message, /off for this agent/);
    const stranger = await a.post("/v1/pocket/freeze", { safes: [randomAddress()] }, phone);
    assert.equal(stranger.status, 404);
    const r = await a.post("/v1/pocket/freeze", { safes: "all" }, phone);
    assert.equal(r.status, 200);
    const mine = r.body.results.find((x: { safe: string }) => x.safe.toLowerCase() === safe.toLowerCase());
    assert.equal(mine.frozen, true, mine.message);
    assert.ok(mine.txHash);
    assert.equal((await readChainAccount(w.ctx, safe)).frozen, true);
    const twice = await a.post("/v1/pocket/freeze", { safes: [safe] }, phone);
    assert.equal(twice.body.results[0].message, "Already frozen.");
    assert.equal((await a.post(`/v1/pocket/unfreeze`, { safes: [safe] }, phone)).status, 404, "there is no unfreeze for a phone");
  });

  it("builds the statement: spent, earned and blocked per agent", async () => {
    const t = Math.floor(Date.now() / 1000) + 3600 * 24 * 365;
    const s = await buildStatement(w.ctx, w.owner.address, 0, t, "2026-11-15");
    const research = s.agents.find((x) => x.name === "Research agent")!;
    assert.ok(research.blocked >= 2, `blocked ${research.blocked}`);
    assert.equal(s.agents.length, 2);
    assert.match(statementSentence(s), /^Your 2 agents spent \$[\d,]+\.\d\d and earned \$[\d,]+\.\d\d, and \d+ payments? (was|were) blocked\.$/);
    const today = await a.get("/v1/pocket/statement", phone);
    assert.equal(today.status, 200);
    assert.equal(today.body.today, true);
    assert.equal((await a.get("/v1/pocket/statement?day=1999-01-01", phone)).status, 404);
  });

  it("sends the daily statement once, after 08:00 in the phone's time zone", async () => {
    const hourNow = new Date().getUTCHours();
    // A time zone where it is between 08:00 and 20:00 right now.
    const tz = ["UTC", "Asia/Tokyo", "America/New_York", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland"].find((z) => {
      const h = localClock(Math.floor(Date.now() / 1000), z).hour;
      return h >= 8 && h < 20;
    }) ?? (hourNow >= 8 ? "UTC" : "Asia/Tokyo");
    // the weekly report has its own test; keep this one the same on a Monday
    w.ctx.db.prepare("UPDATE pocket_devices SET tz = ?, created_at = 0, prefs = ?").run(tz, JSON.stringify({ weekly: false }));
    received.length = 0;
    const n = await sendStatements(w.ctx);
    assert.equal(n, 1);
    assert.equal(await sendStatements(w.ctx), 0, "only once a day");
    const m = messages().find((x) => x.title === "Your daily statement")!;
    assert.match(m.body, /^Your 2 agents spent/);
    assert.match(m.url, /^\/pocket\/statement\?day=\d{4}-\d\d-\d\d$/);
    const days = await a.get("/v1/pocket/statements", phone);
    assert.equal(days.body.days.length, 1);
    const stored = await a.get(`/v1/pocket/statement?day=${days.body.days[0]}`, phone);
    assert.equal(stored.status, 200);
    assert.equal(stored.body.today, false);
  });

  it("the owner sees and unpairs the phone; the token stops working", async () => {
    const list = await a.get("/v1/pocket/devices", ownerToken);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].push, true);
    assert.equal((await a.del(`/v1/pocket/devices/${list.body.items[0].id}`, issueOwnerSession(w.ctx, randomAddress()).token)).status, 404);
    assert.equal((await a.del(`/v1/pocket/devices/${list.body.items[0].id}`, ownerToken)).status, 200);
    assert.equal((await a.get("/v1/pocket/me", phone)).status, 401);
    assert.equal((w.ctx.db.prepare("SELECT COUNT(*) AS n FROM pocket_push").get() as { n: number }).n, 0);
  });
});
