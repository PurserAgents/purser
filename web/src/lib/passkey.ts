/**
 * Passkeys for approvals (WebAuthn, P-256). The public key goes on chain in PurserPasskey; approving a queued
 * payment signs its digest, and the chain checks the signature with the P-256 precompile.
 * The credential id is remembered per account in this browser (localStorage, in try/catch).
 */
const STORE = "purser-passkey:";
const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

const toHex = (bytes: Uint8Array) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => Uint8Array.from((hex.replace(/^0x/, "").match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function passkeySupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined" && !!navigator.credentials;
}

export function storedCredential(safe: string): string | null {
  try {
    return localStorage.getItem(STORE + safe.toLowerCase());
  } catch {
    return null;
  }
}

/** Creates a passkey on this device for one account. Returns the P-256 public key for the chain. */
export async function createPasskey(safe: string, label: string): Promise<{ x: string; y: string }> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Purser" },
      user: { id: fromHex(safe).slice(0, 20), name: `Purser ${label}`, displayName: label },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = new Uint8Array(response.getPublicKey?.() ?? new ArrayBuffer(0));
  if (spki.length < 65 || spki[spki.length - 65] !== 0x04) throw new Error("This device made a key that is not P-256.");
  const point = spki.slice(spki.length - 64);
  try {
    localStorage.setItem(STORE + safe.toLowerCase(), b64url(new Uint8Array(credential.rawId)));
  } catch {
    /* the passkey still works with a discoverable credential */
  }
  return { x: toHex(point.slice(0, 32)), y: toHex(point.slice(32)) };
}

function derToRs(der: Uint8Array): { r: bigint; s: bigint } {
  // SEQUENCE { INTEGER r, INTEGER s }
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const read = () => {
    if (der[i] !== 0x02) throw new Error("bad signature");
    const len = der[i + 1];
    const value = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    return BigInt(toHex(value));
  };
  const r = read();
  let s = read();
  if (s > N / 2n) s = N - s;
  return { r, s };
}

/** Signs an approval digest with the passkey; the answer goes to POST /v1/approvals/:id/passkey. */
export async function signWithPasskey(safe: string, digest: string) {
  const id = storedCredential(safe);
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: fromHex(digest),
      allowCredentials: id ? [{ type: "public-key", id: fromB64url(id) }] : [],
      userVerification: "required",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error("The passkey did not sign.");
  const response = assertion.response as AuthenticatorAssertionResponse;
  const clientDataJSON = new TextDecoder().decode(response.clientDataJSON);
  const { r, s } = derToRs(new Uint8Array(response.signature));
  return {
    authenticatorData: toHex(new Uint8Array(response.authenticatorData)),
    clientDataJSON,
    challengeIndex: clientDataJSON.indexOf('"challenge":"'),
    typeIndex: clientDataJSON.indexOf('"type":"webauthn.get"'),
    r: "0x" + r.toString(16),
    s: "0x" + s.toString(16),
  };
}
