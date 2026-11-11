import type * as S from "./schema.js";

export interface PurserOptions {
  /** The engine, e.g. http://localhost:8787 */
  baseUrl: string;
  /** An agent API key (prs_...). Needed for paying, selling and everything an agent does. */
  apiKey?: string;
  /** An owner session token (own_...) from sign-in. Needed for keys, webhooks, teams and account settings. */
  ownerToken?: string;
  fetch?: typeof fetch;
}

export class PurserError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "PurserError";
  }
}

type Q = Record<string, string | number | boolean | undefined | null>;
const qs = (q?: Q) => {
  if (!q) return "";
  const p = Object.entries(q).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join("&")}` : "";
};
const amt = (v: bigint | number | string) => (typeof v === "bigint" ? v.toString() : String(v));

/**
 * The Purser engine API, typed. Amounts are base units (USDG has 6 decimals: 1 USDG = 1000000).
 * Methods that move money return the intent, the firewall verdict and the receipt; a blocked payment comes back
 * with status "blocked" and the reasons, it does not throw.
 */
export class Purser {
  private f: typeof fetch;
  constructor(public opts: PurserOptions) {
    this.f = opts.fetch ?? fetch.bind(globalThis);
  }

  private async req<T>(method: string, path: string, body?: unknown, auth: "agent" | "owner" | "none" = "none", raw = false): Promise<T> {
    const token = auth === "agent" ? this.opts.apiKey : auth === "owner" ? this.opts.ownerToken : undefined;
    if (auth !== "none" && !token) throw new PurserError(401, "unauthorized", auth === "agent" ? "This call needs an agent API key (apiKey)." : "This call needs an owner session (ownerToken).");
    const res = await this.f(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    if (raw) return (await res.text()) as T;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    // 422 = blocked by the rules or the firewall: a normal answer with a verdict
    if (!res.ok && !(res.status === 422 && data && "verdict" in data)) {
      throw new PurserError(res.status, data?.error?.code ?? "http_error", data?.error?.message ?? `HTTP ${res.status}`, data);
    }
    return data as T;
  }

  // ------------------------------------------------------------------------------------------------ meta
  health = () => this.req<S.Health>("GET", "/v1/health");
  config = () => this.req<Record<string, unknown>>("GET", "/v1/config");
  me = () => this.req<{ safe: S.Address; key: S.ApiKey; sessionAddress: S.Address | null }>("GET", "/v1/me", undefined, "agent");

  // ------------------------------------------------------------------------------------------------ the agent's money
  /** Pay someone from the agent's account. */
  pay = (p: { to: string; amount: bigint | number | string; token?: string; service?: string; memo?: string; trigger?: string; taskId?: string; customer?: string; category?: string; cosignature?: string }) =>
    this.req<S.PayResult>("POST", "/v1/pay", { ...p, amount: amt(p.amount) }, "agent");
  /** Ask the firewall about a payment without making it. */
  checkPayment = (p: { to: string; amount: bigint | number | string; token?: string; service?: string; trigger?: string }) =>
    this.req<S.Verdict>("POST", "/v1/firewall/check", { ...p, amount: amt(p.amount) }, "agent");
  /** Send an intent signed by a key the agent keeps itself (see signPayIntent in the SDK). */
  submitIntent = (body: Record<string, unknown>) => this.req<S.PayResult>("POST", "/v1/intents", body);
  cosign = (intentId: string, signature: string) => this.req<S.PayResult>("POST", `/v1/intents/${intentId}/cosign`, { signature });
  intent = (id: string) => this.req<S.Intent>("GET", `/v1/intents/${id}`);
  call = (p: { target: string; data: string; value?: bigint | string; spendToken?: string; spendLimit?: bigint | string; memo?: string; trigger?: string }) =>
    this.req<S.PayResult>("POST", "/v1/call", { ...p, value: p.value === undefined ? undefined : amt(p.value), spendLimit: p.spendLimit === undefined ? undefined : amt(p.spendLimit) }, "agent");
  swap = (p: { tokenIn: string; tokenOut: string; amountIn: bigint | string; minOut: bigint | string; fee?: number }) =>
    this.req<S.PayResult>("POST", "/v1/swap", { ...p, amountIn: amt(p.amountIn), minOut: amt(p.minOut) }, "agent");
  /** Fetch an x402 URL; if it asks for payment, pay it from the account within the rules. */
  x402Fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; maxAmount?: bigint | string; trigger?: string; taskId?: string } = {}) =>
    this.req<{ status: number; paid: boolean; body: string; headers: Record<string, string>; payment: S.PayResult | null; settlement: unknown }>(
      "POST",
      "/v1/x402/fetch",
      { url, ...init, maxAmount: init.maxAmount === undefined ? undefined : amt(init.maxAmount) },
      "agent",
    );

  /** OpenAI-compatible chat completions, paid from the agent's account. */
  chat = {
    completions: {
      create: (body: { model: string; messages: { role: string; content: unknown }[]; [k: string]: unknown }) =>
        this.req<{ choices: { message: { role: string; content: string } }[]; usage?: Record<string, number>; purser: { costUsd: string; receipt: string | null; paid: boolean } }>("POST", "/v1/chat/completions", body, "agent"),
    },
  };
  models = () => this.req<{ data: { id: string }[] }>("GET", "/v1/models", undefined, "agent");

  streams = {
    create: (p: { payee: string; ratePerSecond: bigint | string; maxDurationSeconds: number; graceSeconds?: number; token?: string }) =>
      this.req<S.PayResult & { streamId?: string }>("POST", "/v1/streams", { ...p, ratePerSecond: amt(p.ratePerSecond) }, "agent"),
    stop: (id: string) => this.req<{ txHash: string }>("POST", `/v1/streams/${id}/stop`, {}, "agent"),
    heartbeat: (id: string, upTo: number, signature: string) => this.req<{ txHash: string }>("POST", `/v1/streams/${id}/heartbeat`, { upTo, signature }),
    get: (id: string) => this.req<S.Stream>("GET", `/v1/streams/${id}`),
    list: (safe: string) => this.req<S.Page<S.Stream>>("GET", `/v1/accounts/${safe}/streams`),
  };
  subscriptions = {
    create: (p: { payee: string; amount: bigint | string; periodSeconds: number; maxCharges: number; token?: string }) =>
      this.req<S.PayResult & { subscriptionId?: string }>("POST", "/v1/subscriptions", { ...p, amount: amt(p.amount) }, "agent"),
    cancel: (id: string) => this.req<{ txHash: string }>("POST", `/v1/subscriptions/${id}/cancel`, {}, "agent"),
    list: (safe: string) => this.req<S.Page<S.Subscription>>("GET", `/v1/accounts/${safe}/subscriptions`),
  };

  // ------------------------------------------------------------------------------------------------ money in
  store = {
    create: (p: { name: string; description?: string; model?: "per_call" | "per_minute" | "subscription"; price: bigint | string; periodSeconds?: number; upstream?: string; response?: string }) =>
      this.req<S.StoreService>("POST", "/v1/storefront/services", { ...p, price: amt(p.price) }, "agent"),
    update: (id: string, p: { active?: boolean; price?: bigint | string; description?: string }) =>
      this.req<S.StoreService>("PATCH", `/v1/storefront/services/${id}`, { ...p, price: p.price === undefined ? undefined : amt(p.price) }, "agent"),
    list: (safe?: string) => this.req<S.Page<S.StoreService>>("GET", `/v1/storefront/services${qs({ safe })}`),
    usage: (id: string) => this.req<{ service: S.StoreService; items: unknown[] }>("GET", `/v1/storefront/services/${id}/usage`),
  };
  splits = {
    get: (safe: string) => this.req<{ items: (S.Split & { role: string; paid: S.Money[] })[]; keptBps: number }>("GET", `/v1/accounts/${safe}/splits`),
    prepare: (safe: string, splits: { to: string; bps: number; label?: string; role?: string }[]) => this.req<S.PreparedSafeTx>("POST", `/v1/accounts/${safe}/splits/prepare`, { splits }),
  };
  invoices = {
    create: (p: { payer: string; amount: bigint | string; description: string; token?: string; dueInSeconds?: number; reviewPeriodSeconds?: number; arbiter?: string | null }) =>
      this.req<S.Invoice>("POST", "/v1/invoices", { ...p, amount: amt(p.amount) }, "agent"),
    pay: (id: string) => this.req<S.PayResult & { invoice?: S.Invoice }>("POST", `/v1/invoices/${id}/pay`, {}, "agent"),
    deliver: (id: string, note?: string) => this.req<{ invoice: S.Invoice }>("POST", `/v1/invoices/${id}/deliver`, { note }, "agent"),
    release: (id: string) => this.req<{ invoice: S.Invoice }>("POST", `/v1/invoices/${id}/release`, {}, "agent"),
    dispute: (id: string) => this.req<{ invoice: S.Invoice }>("POST", `/v1/invoices/${id}/dispute`, {}, "agent"),
    resolve: (id: string, payeeBps: number) => this.req<{ invoice: S.Invoice }>("POST", `/v1/invoices/${id}/resolve`, { payeeBps }, "agent"),
    claim: (id: string) => this.req<{ txHash: string; invoice: S.Invoice }>("POST", `/v1/invoices/${id}/claim`, {}),
    refund: (id: string) => this.req<{ txHash: string; invoice: S.Invoice }>("POST", `/v1/invoices/${id}/refund`, {}),
    get: (id: string) => this.req<S.Invoice>("GET", `/v1/invoices/${id}`),
    list: (safe: string) => this.req<S.Page<S.Invoice>>("GET", `/v1/accounts/${safe}/invoices`),
  };
  treasury = {
    get: (safe: string) => this.req<S.Treasury>("GET", `/v1/accounts/${safe}/treasury`),
    vaults: () => this.req<S.Page<S.TreasuryVault>>("GET", "/v1/treasury/vaults"),
    deposit: (vault: string, amount: bigint | string) => this.req<S.PayResult>("POST", "/v1/treasury/deposit", { vault, amount: amt(amount) }, "agent"),
    withdraw: (vault: string, amount: bigint | string) => this.req<S.PayResult>("POST", "/v1/treasury/withdraw", { vault, amount: amt(amount) }, "agent"),
    sweep: (buffer: bigint | string = 0n) => this.req<S.PayResult | { moved: string; reason: string }>("POST", "/v1/treasury/sweep", { buffer: amt(buffer) }, "agent"),
  };

  // ------------------------------------------------------------------------------------------------ accounts (read)
  accounts = {
    list: (owner?: string) => this.req<S.Page<S.AccountSummary>>("GET", `/v1/accounts${qs({ owner })}`),
    get: (safe: string) => this.req<S.Account>("GET", `/v1/accounts/${safe}`),
    rules: (safe: string) => this.req<Pick<S.Account, "config" | "rules" | "allowlist" | "services" | "treasuryVaults" | "splits">>("GET", `/v1/accounts/${safe}/rules`),
    receipts: (safe: string, q?: { direction?: "in" | "out"; category?: string; before?: number; limit?: number }) => this.req<S.Page<S.Receipt>>("GET", `/v1/accounts/${safe}/receipts${qs(q)}`),
    intents: (safe: string, q?: { status?: string; limit?: number }) => this.req<S.Page<S.Intent>>("GET", `/v1/accounts/${safe}/intents${qs(q)}`),
    verdicts: (safe: string, q?: { decision?: "allow" | "block"; limit?: number }) => this.req<S.Page<S.Verdict>>("GET", `/v1/accounts/${safe}/verdicts${qs(q)}`),
    approvals: (safe: string, all = false) => this.req<S.Page<S.PendingApproval>>("GET", `/v1/accounts/${safe}/approvals${qs({ all: all ? 1 : undefined })}`),
    watchdog: (safe: string) => this.req<{ baseline: S.WatchdogBaseline; events: S.WatchdogEvent[] }>("GET", `/v1/accounts/${safe}/watchdog`),
    pnl: (safe: string, q?: { from?: number; to?: number }) => this.req<S.Pnl>("GET", `/v1/accounts/${safe}/pnl${qs(q)}`),
    exportCsv: (safe: string, q?: { from?: number; to?: number }) => this.req<string>("GET", `/v1/accounts/${safe}/export.csv${qs(q)}`, undefined, "none", true),
  };
  receipt = (id: string) => this.req<S.Receipt>("GET", `/v1/receipts/${id}`);
  verdict = (id: string) => this.req<S.Verdict>("GET", `/v1/verdicts/${id}`);

  // ------------------------------------------------------------------------------------------------ owner actions (return transactions to sign)
  owner = {
    signInMessage: (address: string) => this.req<{ nonce: string; issued: number; message: string }>("POST", "/v1/auth/nonce", { address }),
    signIn: (p: { address: string; nonce: string; issued: number; signature: string }) => this.req<{ token: string; address: string; expires: number }>("POST", "/v1/auth/verify", p),
    prepareAccount: (p: Record<string, unknown>) => this.req<{ predictedSafe: S.Address; tx: S.PreparedTx }>("POST", "/v1/accounts/prepare", p),
    register: (p: { safe: string; name: string; kind?: string; public?: boolean; template?: string }) => this.req<S.Account>("POST", "/v1/accounts/register", p, "owner"),
    update: (safe: string, p: { name?: string; kind?: string; public?: boolean }) => this.req<S.Account>("PATCH", `/v1/accounts/${safe}`, p, "owner"),
    prepareRules: (safe: string, change: Record<string, unknown>) => this.req<S.PreparedSafeTx>("POST", `/v1/accounts/${safe}/rules/prepare`, change),
    prepareTemplate: (safe: string, template: string) => this.req<S.PreparedSafeTx>("POST", `/v1/accounts/${safe}/template/prepare`, { template }),
    prepareFreeze: (safe: string) => this.req<S.PreparedTx>("POST", `/v1/accounts/${safe}/freeze/prepare`, {}),
    prepareUnfreeze: (safe: string) => this.req<S.PreparedTx>("POST", `/v1/accounts/${safe}/unfreeze/prepare`, {}),
    preparePasskey: (safe: string, x: string, y: string) => this.req<S.PreparedSafeTx>("POST", `/v1/accounts/${safe}/passkey/prepare`, { x, y }),
    prepareApproval: (intentId: string, decision: "approve" | "reject") => this.req<S.PreparedTx>("POST", `/v1/approvals/${intentId}/prepare`, { decision }),
    passkeyDecision: (intentId: string, decision: "approve" | "reject", assertion: Record<string, unknown>) => this.req<{ txHash: string; result: S.PayResult | null }>("POST", `/v1/approvals/${intentId}/passkey`, { decision, assertion }),
    createKey: (safe: string, p: { name?: string; scopes?: S.ApiScope[]; managed?: boolean } = {}) => this.req<{ key: S.ApiKey; secret: string }>("POST", `/v1/accounts/${safe}/keys`, p, "owner"),
    keys: (safe: string) => this.req<S.Page<S.ApiKey>>("GET", `/v1/accounts/${safe}/keys`, undefined, "owner"),
    revokeKey: (safe: string, id: string) => this.req<{ ok: true }>("DELETE", `/v1/accounts/${safe}/keys/${id}`, undefined, "owner"),
    setAutoFreeze: (safe: string, autoFreeze: boolean) => this.req<{ autoFreeze: boolean }>("PATCH", `/v1/accounts/${safe}/watchdog`, { autoFreeze }, "owner"),
    addProvider: (safe: string, p: Record<string, unknown>) => this.req<unknown>("POST", `/v1/accounts/${safe}/providers`, p, "owner"),
  };

  teams = {
    create: (p: { name: string; treasury: string }) => this.req<S.Team>("POST", "/v1/teams", p, "owner"),
    get: (id: string) => this.req<S.Team>("GET", `/v1/teams/${id}`),
    list: (owner?: string) => this.req<S.Page<S.Team>>("GET", `/v1/teams${qs({ owner })}`),
    org: (id: string) => this.req<S.OrgChartNode>("GET", `/v1/teams/${id}/org`),
    addDepartment: (id: string, p: { name: string; dailyBudget?: string | null }) => this.req<S.Team>("POST", `/v1/teams/${id}/departments`, p, "owner"),
    addMember: (id: string, p: { safe: string; departmentId?: string | null; role?: string; dailyBudget?: string | null }) => this.req<{ team: S.Team; treasuryTx: S.PreparedSafeTx }>("POST", `/v1/teams/${id}/members`, p, "owner"),
    topUp: (id: string, member: string, amount: bigint | string, memo?: string) => this.req<S.PayResult>("POST", `/v1/teams/${id}/topups`, { member, amount: amt(amount), memo }, "agent"),
    pnl: (id: string, q?: { from?: number; to?: number }) => this.req<S.Pnl>("GET", `/v1/teams/${id}/pnl${qs(q)}`),
  };

  webhooks = {
    create: (p: { url: string; events: S.WebhookEventType[]; safe?: string | null }) => this.req<{ webhook: S.Webhook; secret: string }>("POST", "/v1/webhooks", p, "owner"),
    list: () => this.req<S.Page<S.Webhook>>("GET", "/v1/webhooks", undefined, "owner"),
    remove: (id: string) => this.req<{ ok: true }>("DELETE", `/v1/webhooks/${id}`, undefined, "owner"),
    deliveries: (id: string) => this.req<S.Page<S.WebhookDelivery>>("GET", `/v1/webhooks/${id}/deliveries`, undefined, "owner"),
    test: (id: string) => this.req<{ delivered: number }>("POST", `/v1/webhooks/${id}/test`, {}, "owner"),
  };
  alerts = {
    list: (safe: string) => this.req<S.Page<S.Alert>>("GET", `/v1/accounts/${safe}/alerts`),
    set: (safe: string, alerts: { kind: S.AlertKind; threshold?: string | null }[]) => this.req<S.Page<S.Alert>>("PUT", `/v1/accounts/${safe}/alerts`, { alerts }, "owner"),
  };

  // ------------------------------------------------------------------------------------------------ the network
  directory = (q?: { source?: string; limit?: number }) => this.req<S.Page<S.DirectoryEntry>>("GET", `/v1/directory${qs(q)}`);
  economy = () => this.req<S.Economy>("GET", "/v1/economy");
  leaderboard = (q?: { limit?: number }) => this.req<S.Page<S.LeaderboardEntry>>("GET", `/v1/leaderboard${qs(q)}`);
  publicAgent = (safe: string) => this.req<S.PublicAgent>("GET", `/v1/agents/${safe}/public`);
  templates = () => this.req<S.Page<S.Template>>("GET", "/v1/templates");
  audit = {
    list: (q?: { safe?: string; limit?: number; before?: number }) => this.req<{ items: S.AuditEntry[]; signer: string }>("GET", `/v1/audit${qs(q)}`),
    export: () => this.req<string>("GET", "/v1/audit/export", undefined, "none", true),
    verify: (jsonl: string, signer?: string) => this.req<S.AuditVerifyResult>("POST", `/v1/audit/verify${qs({ signer })}`, jsonl),
  };
  demo = {
    runFirewall: (paceMs = 0) => this.req<{ safe: string; steps: S.DemoStep[] }>("POST", "/v1/demo/firewall/run", { paceMs }),
    lastFirewall: () => this.req<{ steps: S.DemoStep[]; safe: string | null }>("GET", "/v1/demo/firewall"),
  };

  /** Live events over Server-Sent Events. Returns a function that stops the stream. */
  events(onEvent: (e: S.EngineEvent) => void, opts: { safe?: string; types?: S.EngineEventType[]; since?: number } = {}): () => void {
    const ac = new AbortController();
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/v1/events${qs({ safe: opts.safe, types: opts.types?.join(","), since: opts.since })}`;
    (async () => {
      const res = await this.f(url, { signal: ac.signal, headers: { accept: "text/event-stream" } });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          const event = chunk.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim();
          if (data && event !== "ping") {
            try {
              onEvent(JSON.parse(data));
            } catch {
              /* not JSON */
            }
          }
        }
      }
    })().catch(() => undefined);
    return () => ac.abort();
  }
}
