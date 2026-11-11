import type { Address } from "viem";
import {
  decodeHeader,
  encodeHeader,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  HEADER_V1_PAYMENT,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "./x402.js";

/**
 * Merchant side of x402: price an endpoint, receive into an address (a Purser account receives through the Purser
 * module, so the owner's revenue splits apply on arrival). Works with any facilitator that speaks x402 v2; the
 * default is a Purser engine's facilitator.
 */
export interface PaywallOptions {
  facilitatorUrl: string; // e.g. https://engine.example/x402
  payTo: Address;
  asset: Address;
  price: string | bigint; // base units
  network?: string; // default eip155:4663
  description?: string;
  mimeType?: string;
  serviceName?: string;
  maxTimeoutSeconds?: number;
  tokenName?: string; // EIP-712 domain name of the token (USDG: "Global Dollar")
  tokenVersion?: string;
  fetch?: typeof fetch;
}

export function requirementsFor(o: PaywallOptions): PaymentRequirements {
  return {
    scheme: "exact",
    network: o.network ?? "eip155:4663",
    amount: o.price.toString(),
    asset: o.asset,
    payTo: o.payTo,
    maxTimeoutSeconds: o.maxTimeoutSeconds ?? 120,
    extra: { name: o.tokenName ?? "Global Dollar", version: o.tokenVersion ?? "1" },
  };
}

export type PaywallDecision =
  | { kind: "pay"; status: 402; headers: Record<string, string>; body: PaymentRequired }
  | { kind: "ok"; payment: PaymentPayload; payer: Address | undefined; settle: () => Promise<SettleResponse> };

/** Framework-neutral check: returns either the 402 to send, or a verified payment to settle after the work. */
export async function checkPayment(o: PaywallOptions, url: string, headers: { get(name: string): string | null | undefined }): Promise<PaywallDecision> {
  const f = o.fetch ?? fetch;
  const req = requirementsFor(o);
  const required = (error?: string): PaywallDecision => {
    const body: PaymentRequired = {
      x402Version: 2,
      ...(error ? { error } : {}),
      resource: { url, description: o.description, mimeType: o.mimeType ?? "application/json", serviceName: o.serviceName },
      accepts: [req],
    };
    return { kind: "pay", status: 402, headers: { [HEADER_REQUIRED]: encodeHeader(body), "content-type": "application/json" }, body };
  };
  const raw = headers.get(HEADER_SIGNATURE) ?? headers.get(HEADER_SIGNATURE.toLowerCase()) ?? headers.get(HEADER_V1_PAYMENT) ?? headers.get(HEADER_V1_PAYMENT.toLowerCase());
  if (!raw) return required();
  const payment = decodeHeader<PaymentPayload>(raw);
  if (!payment) return required("invalid_payment_header");
  const call = async <T>(path: "verify" | "settle"): Promise<T> => {
    const r = await f(`${o.facilitatorUrl.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payment, paymentRequirements: req }),
    });
    return (await r.json()) as T;
  };
  const v = await call<VerifyResponse>("verify");
  if (!v.isValid) return required(v.invalidReason ?? "invalid_payment");
  return { kind: "ok", payment, payer: v.payer, settle: () => call<SettleResponse>("settle") };
}

/** Hono middleware. Settles after the handler answered with a status below 400. */
export function purserPaywall(o: PaywallOptions) {
  return async (c: any, next: () => Promise<void>) => {
    const d = await checkPayment(o, c.req.url, { get: (n: string) => c.req.header(n) });
    if (d.kind === "pay") return c.json(d.body, 402, d.headers);
    c.set?.("x402Payer", d.payer);
    await next();
    if (c.res.status >= 400) return;
    const s = await d.settle();
    if (!s.success) {
      c.res = c.json({ error: "payment_failed", reason: s.errorReason }, 402);
      return;
    }
    c.res.headers.set(HEADER_RESPONSE, encodeHeader(s));
  };
}

/** Express middleware. Settles when the response finishes with a status below 400. */
export function purserPaywallExpress(o: PaywallOptions) {
  return async (req: any, res: any, next: (e?: unknown) => void) => {
    try {
      const url = `${req.protocol}://${req.get?.("host") ?? req.headers.host}${req.originalUrl ?? req.url}`;
      const d = await checkPayment(o, url, { get: (n: string) => req.headers[n.toLowerCase()] });
      if (d.kind === "pay") {
        for (const [k, v] of Object.entries(d.headers)) res.setHeader(k, v);
        res.status(402).json(d.body);
        return;
      }
      req.x402Payer = d.payer;
      const end = res.end.bind(res);
      res.end = async (...args: unknown[]) => {
        if (res.statusCode < 400) {
          const s = await d.settle();
          if (s.success) res.setHeader(HEADER_RESPONSE, encodeHeader(s));
        }
        return end(...args);
      };
      next();
    } catch (e) {
      next(e);
    }
  };
}
