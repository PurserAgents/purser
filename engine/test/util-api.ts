import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { Hono } from "hono";
import type { Hex } from "viem";
import { buildApp } from "../src/api/app.ts";
import "../src/features.ts";
import type { World } from "./harness.ts";

export interface Api {
  app: Hono;
  get<T = any>(path: string, token?: string): Promise<{ status: number; body: T }>;
  post<T = any>(path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }>;
  patch<T = any>(path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }>;
  del<T = any>(path: string, token?: string): Promise<{ status: number; body: T }>;
}

export function api(w: World): Api {
  const app = buildApp(w.ctx);
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return {
    app,
    get: (p, t) => call("GET", p, undefined, t),
    post: (p, b, t) => call("POST", p, b ?? {}, t),
    patch: (p, b, t) => call("PATCH", p, b ?? {}, t),
    del: (p, t) => call("DELETE", p, undefined, t),
  };
}

/** A software passkey (P-256) that produces WebAuthn assertions the way a phone does. */
export function softPasskey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = ("0x" + Buffer.from(jwk.x!, "base64url").toString("hex")) as Hex;
  const y = ("0x" + Buffer.from(jwk.y!, "base64url").toString("hex")) as Hex;
  const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  function assert(challenge: Hex) {
    const authenticatorData = Buffer.concat([createHash("sha256").update("purseragents.fun").digest(), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
    const clientDataJSON = `{"type":"webauthn.get","challenge":"${Buffer.from(challenge.slice(2), "hex").toString("base64url")}","origin":"https://purseragents.fun","crossOrigin":false}`;
    const data = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
    const sig = sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" });
    const r = BigInt("0x" + sig.subarray(0, 32).toString("hex"));
    let s = BigInt("0x" + sig.subarray(32).toString("hex"));
    if (s > N / 2n) s = N - s;
    return {
      authenticatorData: ("0x" + authenticatorData.toString("hex")) as Hex,
      clientDataJSON,
      challengeIndex: clientDataJSON.indexOf('"challenge"'),
      typeIndex: clientDataJSON.indexOf('"type"'),
      r: "0x" + r.toString(16),
      s: "0x" + s.toString(16),
    };
  }
  return { x, y, assert };
}
