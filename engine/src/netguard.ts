import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { Ctx } from "./ctx.ts";

/**
 * Every URL the engine fetches for a caller (x402 resources, model providers, storefront upstreams, webhooks, push
 * endpoints) goes through here. Only the public internet: https only; the host is resolved and every address is
 * checked against loopback, private, link-local, unique-local, metadata and other special ranges; the connection
 * goes to the address that was checked; redirects are not followed; the answer is capped in size and time.
 *
 * A local engine (test mode on a local node, never a live one) may reach its own machine when
 * PURSER_FETCH_PRIVATE=1 is set; the test harness does that for its stand-in services.
 */

export class FetchRefused extends Error {
  code = "fetch_refused";
}

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, bits, "ipv6");

/** IPv4 written inside IPv6 (mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::/96) is checked as IPv4. */
function embeddedV4(addr: string): string | null {
  const a = addr.toLowerCase();
  const m = a.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  const h = a.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (h) {
    const hi = parseInt(h[1], 16);
    const lo = parseInt(h[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True when the address is not on the public internet. */
export function isPrivateAddress(addr: string): boolean {
  const ip = addr.replace(/^\[|\]$/g, "").split("%")[0];
  const fam = isIP(ip);
  if (fam === 4) return blocked.check(ip, "ipv4");
  if (fam === 6) {
    const v4 = embeddedV4(ip);
    if (v4) return blocked.check(v4, "ipv4");
    return blocked.check(ip, "ipv6");
  }
  return true; // not an address at all
}

/** Private hosts are reachable only for a local engine that asked for it (tests, the local preview). */
export function privateAllowed(ctx: Ctx | null): boolean {
  return process.env.PURSER_FETCH_PRIVATE === "1" && !!ctx && !ctx.chain.live;
}

/** Checks a URL before it is stored (webhooks, providers, upstreams) so a bad one is refused at once. */
export function checkUrl(ctx: Ctx | null, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchRefused("Not a valid URL.");
  }
  const open = privateAllowed(ctx);
  if (u.protocol !== "https:" && !(open && u.protocol === "http:")) throw new FetchRefused("Only https URLs can be fetched.");
  if (u.username || u.password) throw new FetchRefused("URLs with credentials are not fetched.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!open && isIP(host) && isPrivateAddress(host)) throw new FetchRefused("That address is not on the public internet.");
  if (!open && /(^|\.)(localhost|internal|local|localdomain|railway\.internal)$/i.test(host)) throw new FetchRefused("That host is not on the public internet.");
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(open: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number }, cb: LookupCb) => {
    dnsLookup(hostname, { all: true, family: options?.family }, (err, addrs) => {
      if (err) return cb(err, "");
      if (!addrs.length) return cb(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), "");
      if (!open && addrs.some((a) => isPrivateAddress(a.address))) return cb(new FetchRefused("That host resolves to an address that is not on the public internet."), "");
      if (options?.all) return cb(null, addrs);
      return cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

export interface GuardedInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * fetch for caller-chosen URLs. Returns a standard Response (the body already read, at most `maxBytes`). A refused
 * URL throws FetchRefused; a 3xx answer is returned as it is, never followed.
 */
export async function guardedFetch(ctx: Ctx | null, raw: string, init: GuardedInit = {}): Promise<Response> {
  const u = checkUrl(ctx, raw);
  const open = privateAllowed(ctx);
  const maxBytes = init.maxBytes ?? 2_000_000;
  const timeoutMs = init.timeoutMs ?? 15_000;
  const lib = u.protocol === "https:" ? https : http;
  return new Promise<Response>((resolve, reject) => {
    let done = false;
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      f();
    };
    const req = lib.request(
      u,
      { method: init.method ?? "GET", headers: init.headers, lookup: guardedLookup(open) as never, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            finish(() => reject(new FetchRefused(`The answer is larger than ${maxBytes} bytes.`)));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          finish(() => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (v === undefined) continue;
              for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
            }
            const status = res.statusCode ?? 502;
            const empty = [101, 204, 205, 304].includes(status) || status < 200;
            resolve(new Response(empty ? null : Buffer.concat(chunks), { status: status < 200 ? 502 : status, statusText: res.statusMessage, headers }));
          }),
        );
        res.on("error", (e) => finish(() => reject(e)));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new FetchRefused(`No answer within ${Math.round(timeoutMs / 1000)} seconds.`)));
    }, timeoutMs);
    req.on("error", (e) => finish(() => reject(e)));
    if (init.body !== undefined && init.body !== null) req.write(init.body);
    req.end();
  });
}
