"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { formatDuration, formatMoney, formatTime, money, parseUnits, relativeTime, sameAddress, shortAddress, usd } from "@/lib/format";
import { kindLabel } from "@/lib/labels";
import { withOwner } from "@/lib/owner";
import { createPasskey, passkeySupported } from "@/lib/passkey";
import type { Account, ApiKey, ApiScope, Page, Pnl, PreparedSafeTx, PreparedTx, Receipt, Template, TokenInfo } from "@/lib/types";
import { DayChart } from "../DayChart";
import { IconCheck, IconCopy, IconFingerprint, IconKey, IconLock, IconPlus, IconSnow, IconTrash, IconWallet } from "../Icons";
import { useEngine, useNow } from "../Live";
import { ReceiptList } from "../Receipts";
import { RulesList, daysText, dollarRule, hoursText } from "../Rules";
import { Card, EmptyState, Loading, Meter, initials } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { OwnerFrame, type OwnerView } from "./Frame";

const REFRESH = ["account", "receipt", "intent", "approval"] as const;

/** Base units to a plain decimal for an input field ("12.5"), no grouping. */
function plain(units: string | null, decimals: number): string {
  if (units === null) return "";
  const v = BigInt(units);
  const unit = 10n ** BigInt(decimals);
  const frac = (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (v / unit).toString() + (frac ? "." + frac : "");
}

function toUnitsOrNull(value: string, decimals: number): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : parseUnits(trimmed, decimals).toString();
}

export function AgentDetail({ safe }: { safe: string }) {
  const account = useEngine<Account>(`/v1/accounts/${safe}`, { refreshOn: [...REFRESH] });
  const a = account.data;
  return (
    <OwnerFrame
      eyebrow={a ? kindLabel[a.kind] ?? "Agent" : "Agent"}
      title={a ? a.name : "Agent account"}
      lead={a ? `Safe ${shortAddress(a.safe)}${a.agentId ? `, ERC-8004 identity ${a.agentId}` : ""}. You own it; the rules below are enforced on chain.` : undefined}
      aside={
        a ? (
          <div className="row">
            {a.frozen ? (
              <span className="badge">
                <IconSnow size={12} />
                Frozen
              </span>
            ) : (
              <span className="badge badge--ok">
                <span className="dot" />
                Active
              </span>
            )}
            {a.public ? (
              <Link className="badge" href={`/agents/${a.safe}`}>
                Public page
              </Link>
            ) : (
              <span className="badge">Private</span>
            )}
          </div>
        ) : null
      }
    >
      {(owner) =>
        account.error && !a ? (
          <EmptyState panel icon={IconWallet} title="This account could not be read" text={account.error} />
        ) : !a ? (
          <div className="empty" aria-busy="true" />
        ) : !a.owners.some((o) => sameAddress(o, owner.address)) ? (
          <EmptyState panel icon={IconLock} title="This wallet does not own this agent" text="Only the wallets that own the agent's Safe can see its settings and change them. Connect the owner wallet.">
            <Link href="/app" className="btn btn--secondary">
              Your agents
            </Link>
          </EmptyState>
        ) : (
          <Detail a={a} owner={owner} reload={account.reload} />
        )
      }
    </OwnerFrame>
  );
}

function Detail({ a, owner, reload }: { a: Account; owner: OwnerView; reload(): void }) {
  const usdgBalance = a.balances.find((b) => b.token.symbol === "USDG");
  const ethBalance = a.balances.find((b) => b.token.symbol === "ETH");
  const spend = a.spentToday.find((s) => s.token.symbol === "USDG");
  const budget = spend?.remaining != null ? (BigInt(spend.spent) + BigInt(spend.remaining)).toString() : null;
  const hour = Math.floor(useNow(600_000) / 3600) * 3600;
  const pnl = useEngine<Pnl>(`/v1/accounts/${a.safe}/pnl?from=${hour - 14 * 86400}`, { refreshOn: ["receipt"] });
  const receipts = useEngine<Page<Receipt>>(`/v1/accounts/${a.safe}/receipts?limit=12`, { refreshOn: ["receipt"] });
  const done = () => {
    reload();
    owner.reload();
  };

  return (
    <div className="dash">
      <dl className="cells cells--4">
        <div className="cell">
          <dt className="stat__label">Balance</dt>
          <dd className="stat__value">{usdgBalance ? money(usdgBalance) : "$0.00"}</dd>
          <dd className="stat__note">{ethBalance ? `${money(ethBalance)} for gas and ETH payments` : "USDG in the agent's Safe"}</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Spent today</dt>
          <dd className="stat__value">{spend ? formatMoney(spend.spent, spend.token) : "$0.00"}</dd>
          {budget && spend ? (
            <>
              <dd>
                <Meter percent={Number((BigInt(spend.spent) * 10000n) / (BigInt(budget) || 1n)) / 100} label="Daily budget used" limit />
              </dd>
              <dd className="stat__note num">of the {formatMoney(budget, spend.token, 0)} daily budget</dd>
            </>
          ) : (
            <dd className="stat__note">No daily cap</dd>
          )}
        </div>
        <div className="cell">
          <dt className="stat__label">Earned today</dt>
          <dd className="stat__value">{usd(a.earnedTodayUsd)}</dd>
          <dd className="stat__note num">{a.receiptsToday} receipts today</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Waiting for you</dt>
          <dd className="stat__value num">{a.pendingApprovals}</dd>
          <dd className="stat__note">
            <Link href="/app/approvals" className="link">
              Payments to approve
            </Link>
          </dd>
        </div>
      </dl>

      <div className="grid-2">
        <TopUpCard a={a} owner={owner} done={done} />
        <ControlsCard a={a} owner={owner} done={done} />
      </div>

      <div className="cols-main">
        <div className="dash">
          <Card title="Income and spend, last 14 days">
            {pnl.data ? <DayChart series={fillDays(pnl.data.byDay, 14)} /> : <Loading />}
          </Card>
          <Card
            title="Receipts"
            action={
              <a className="link-arrow small" href={`/v1/accounts/${a.safe}/export.csv`} download>
                CSV
              </a>
            }
            flush
          >
            {receipts.data ? <ReceiptList receipts={receipts.data.items} names={owner.names} compact /> : <Loading />}
          </Card>
        </div>
        <div className="dash">
          <RulesCard a={a} owner={owner} done={done} />
        </div>
      </div>

      <div className="grid-2">
        <KeysCard a={a} owner={owner} done={done} />
        <AllowlistCard a={a} owner={owner} done={done} />
      </div>
      <div className="grid-2">
        <PasskeyCard a={a} owner={owner} done={done} />
        <RecoveryCard a={a} owner={owner} done={done} />
      </div>
    </div>
  );
}

export function fillDays(byDay: { day: string; incomeUsd: string; spendUsd: string }[], days: number) {
  const out: { day: string; incomeUsd: string; spendUsd: string }[] = [];
  const today = Math.floor(Date.now() / 86_400_000);
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date((today - i) * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.find((d) => d.day === day) ?? { day, incomeUsd: "0", spendUsd: "0" });
  }
  return out;
}

type CardProps = { a: Account; owner: OwnerView; done(): void };

function TopUpCard({ a, owner, done }: CardProps) {
  const tokens = owner.engine.tokens;
  const [symbol, setSymbol] = useState("USDG");
  const [amount, setAmount] = useState("25");
  const action = useAction();
  const token = tokens.find((t) => t.symbol === symbol) as TokenInfo | undefined;
  return (
    <Card title="Top up">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!token) return;
          void action.run(async () => {
            const units = parseUnits(amount || "0", token.decimals);
            await owner.signer.topUp(a.safe, token, units);
            done();
            return `Sent ${formatMoney(units, token)} to ${a.name}.`;
          });
        }}
      >
        <div className="form__row">
          <label className="field">
            <span className="field__label">Amount</span>
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
          </label>
          <label className="field">
            <span className="field__label">Token</span>
            <select className="select" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {tokens.map((t) => (
                <option key={t.address} value={t.symbol}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </label>
        </div>
        <span className="field__hint">From your wallet straight into the agent&apos;s Safe {shortAddress(a.safe)}. Purser never holds it.</span>
        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={action.busy || !Number(amount)}>
            <IconWallet size={15} />
            Send to the agent
          </button>
        </div>
        <ActionStatus state={action.state} />
      </form>
    </Card>
  );
}

function ControlsCard({ a, owner, done }: CardProps) {
  const action = useAction();
  const [name, setName] = useState(a.name);
  const freeze = () =>
    action.run(async () => {
      const tx = await api<PreparedTx>(`/v1/accounts/${a.safe}/${a.frozen ? "unfreeze" : "freeze"}/prepare`, { body: {} });
      await owner.signer.sendTx(tx);
      done();
      return a.frozen ? "Unfrozen. The agent can pay again inside its rules." : "Frozen. No payment can leave until you unfreeze it.";
    });
  const save = (patch: { name?: string; public?: boolean }) =>
    action.run(async () => {
      await withOwner(owner.signer, (token) => api(`/v1/accounts/${a.safe}`, { method: "PATCH", token, body: patch }));
      done();
      return "Saved.";
    }, "Sign in with your wallet...");
  return (
    <Card title="Controls">
      <div className="form">
        <div className="toolbar">
          <div className="stack" style={{ gap: 2 }}>
            <span className="field__label">{a.frozen ? "Frozen" : "Freeze"}</span>
            <span className="field__hint">{a.frozen ? "No payment can leave. Unfreeze to let the agent pay again." : "Stops every payment at once, on chain."}</span>
          </div>
          <button type="button" className={"btn " + (a.frozen ? "btn--secondary" : "btn--danger")} disabled={action.busy} onClick={() => void freeze()}>
            <IconSnow size={15} />
            {a.frozen ? "Unfreeze" : "Freeze now"}
          </button>
        </div>
        <label className="switch">
          <input type="checkbox" checked={a.public} disabled={action.busy} onChange={(e) => void save({ public: e.target.checked })} />
          <span>Public page and leaderboard</span>
        </label>
        <form
          className="row"
          style={{ flexWrap: "nowrap" }}
          onSubmit={(e) => {
            e.preventDefault();
            void save({ name: name.trim() });
          }}
        >
          <input className="input" aria-label="Name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn btn--secondary" disabled={action.busy || !name.trim() || name.trim() === a.name}>
            Rename
          </button>
        </form>
        <ActionStatus state={action.state} />
      </div>
    </Card>
  );
}

function RulesCard({ a, owner, done }: CardProps) {
  const rule = dollarRule(a.rules);
  const [editing, setEditing] = useState(false);
  const templates = useEngine<Page<Template>>(editing ? "/v1/templates" : null);
  const action = useAction();
  const d = rule?.token.decimals ?? 6;
  const [form, setForm] = useState(() => ({
    daily: plain(rule?.daily ?? null, d),
    weekly: plain(rule?.weekly ?? null, d),
    maxSingle: plain(rule?.maxSingle ?? null, d),
    perCounterpartyDaily: plain(rule?.perCounterpartyDaily ?? null, d),
    approvalAbove: plain(rule?.approvalAbove ?? null, d),
    maxPerMinute: a.config.maxPerMinute === null ? "" : String(a.config.maxPerMinute),
    from: a.config.hoursUtc.length ? String(Math.min(...a.config.hoursUtc)) : "",
    to: a.config.hoursUtc.length ? String(Math.max(...a.config.hoursUtc) + 1) : "",
    payeeAllowlist: a.config.payeeAllowlist,
  }));
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value.replace(key === "from" || key === "to" ? /[^0-9]/g : /[^0-9.]/g, "") }));

  if (!rule) return null;

  const submit = () =>
    action.run(async () => {
      const from = form.from === "" ? null : Number(form.from);
      const to = form.to === "" ? null : Number(form.to);
      const hoursUtc = from !== null && to !== null && to > from ? Array.from({ length: to - from }, (_, i) => from + i) : [];
      const change = {
        config: { ...a.config, maxPerMinute: form.maxPerMinute === "" ? null : Number(form.maxPerMinute), hoursUtc, payeeAllowlist: form.payeeAllowlist },
        rules: [
          {
            token: rule.token.address,
            rule: {
              daily: toUnitsOrNull(form.daily, d),
              weekly: toUnitsOrNull(form.weekly, d),
              maxSingle: toUnitsOrNull(form.maxSingle, d),
              perCounterpartyDaily: toUnitsOrNull(form.perCounterpartyDaily, d),
              approvalAbove: toUnitsOrNull(form.approvalAbove, d),
            },
          },
        ],
      };
      const tx = await api<PreparedSafeTx>(`/v1/accounts/${a.safe}/rules/prepare`, { body: change });
      await owner.signer.execSafeTx(tx);
      done();
      setEditing(false);
      return "The new rules are on chain.";
    }, "Preparing the change...");

  const applyTemplate = (id: string) =>
    action.run(async () => {
      const tx = await api<PreparedSafeTx>(`/v1/accounts/${a.safe}/template/prepare`, { body: { template: id } });
      await owner.signer.execSafeTx(tx);
      done();
      setEditing(false);
      return "Template applied.";
    });

  const field = (key: "daily" | "weekly" | "maxSingle" | "perCounterpartyDaily" | "approvalAbove", label: string, hint: string) => (
    <label className="field">
      <span className="field__label">{label}</span>
      <span className="input-affix">
        <input className="input" inputMode="decimal" value={form[key] as string} onChange={set(key)} placeholder={key === "approvalAbove" ? "Never" : "No cap"} />
        <span className="input-affix__unit">{rule.token.symbol}</span>
      </span>
      <span className="field__hint">{hint}</span>
    </label>
  );

  return (
    <Card
      title="Rules"
      id="rules"
      action={
        editing ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
        ) : (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setEditing(true)}>
            Change rules
          </button>
        )
      }
    >
      {!editing ? (
        <div className="form">
          <RulesList rule={rule} config={a.config} />
          <span className="field__hint">
            Enforced by the Purser module on chain. Active {hoursText(a.config.hoursUtc).toLowerCase()}, {daysText(a.config.weekdays).toLowerCase()}.
          </span>
          <ActionStatus state={action.state} />
        </div>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="form__row">
            {field("daily", "Daily budget", "Total per UTC day, fee included.")}
            {field("weekly", "Weekly budget", "From Monday 00:00 UTC.")}
          </div>
          <div className="form__row">
            {field("maxSingle", "Largest single payment", "Anything bigger is refused.")}
            {field("perCounterpartyDaily", "Per payee per day", "Most one payee can get a day.")}
          </div>
          <div className="form__row">
            {field("approvalAbove", "Ask me above", "Bigger payments wait for you.")}
            <label className="field">
              <span className="field__label">Payments per minute</span>
              <input className="input" inputMode="numeric" value={form.maxPerMinute} onChange={set("maxPerMinute")} placeholder="No cap" />
              <span className="field__hint">Stops runaway loops.</span>
            </label>
          </div>
          <div className="form__row">
            <label className="field">
              <span className="field__label">Active from (UTC hour)</span>
              <input className="input" inputMode="numeric" value={form.from} onChange={set("from")} placeholder="Any time" />
            </label>
            <label className="field">
              <span className="field__label">Until (UTC hour)</span>
              <input className="input" inputMode="numeric" value={form.to} onChange={set("to")} placeholder="Any time" />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={form.payeeAllowlist} onChange={set("payeeAllowlist")} />
            <span>Only pay addresses on the allowlist</span>
          </label>
          <div className="row">
            <button type="submit" className="btn btn--primary" disabled={action.busy}>
              Sign the new rules
            </button>
          </div>
          {templates.data ? (
            <div className="field">
              <span className="field__label">Or apply a template</span>
              <div className="chips">
                {templates.data.items.map((t) => (
                  <button key={t.id} type="button" className="btn btn--secondary btn--sm" disabled={action.busy} onClick={() => void applyTemplate(t.id)}>
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <ActionStatus state={action.state} />
        </form>
      )}
    </Card>
  );
}

const ALL_SCOPES: ApiScope[] = ["pay", "models", "x402", "call", "sell", "read", "treasury", "recurring", "invoices"];

function KeysCard({ a, owner, done }: CardProps) {
  const [token, setToken] = useState<string | null>(null);
  const [items, setItems] = useState<ApiKey[] | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [scopes, setScopes] = useState<ApiScope[]>(ALL_SCOPES);
  const action = useAction();
  const refresh = async (tk: string) => setItems((await api<Page<ApiKey>>(`/v1/accounts/${a.safe}/keys`, { token: tk })).items);
  const view = () =>
    action.run(async () => {
      const t = await withOwner(owner.signer, async (tk) => {
        await refresh(tk);
        return tk;
      });
      setToken(t);
      return "These are the keys of this agent. Secrets are never shown again.";
    }, "Sign in with your wallet to see the keys...");

  const create = () =>
    action.run(async (status) => {
      const created = await withOwner(owner.signer, (tk) => api<{ key: ApiKey; secret: string }>(`/v1/accounts/${a.safe}/keys`, { token: tk, body: { name: `${a.name} key`, scopes, managed: true } }));
      setSecret(created.secret);
      setCopied(false);
      if (created.key.sessionAddress && !sameAddress(created.key.sessionAddress, a.config.agent)) {
        status("Make this key the agent. Confirm in your wallet...");
        const tx = await api<PreparedSafeTx>(`/v1/accounts/${a.safe}/rules/prepare`, { body: { config: { ...a.config, agent: created.key.sessionAddress } } });
        await owner.signer.execSafeTx(tx);
      }
      const tk = await owner.signer.session();
      setToken(tk);
      await refresh(tk);
      done();
      return "New key created and set as the agent. Copy it now: it is shown only once.";
    }, "Creating the key...");

  const revoke = (id: string) =>
    action.run(async () => {
      await withOwner(owner.signer, (tk) => api(`/v1/accounts/${a.safe}/keys/${id}`, { method: "DELETE", token: tk }));
      if (token) await refresh(token);
      return "Key revoked. It stopped working at once.";
    });

  return (
    <Card title="Agent key" action={<IconKey size={16} />}>
      <div className="form">
        <p className="small muted">
          The agent uses one key for models, x402 services and on-chain apps. Current agent address <span className="mono">{shortAddress(a.config.agent)}</span>.
        </p>
        {secret ? (
          <div className="secret">
            <code>{secret}</code>
            <button type="button" className="icon-btn" aria-label="Copy the key" onClick={() => void navigator.clipboard?.writeText(secret).then(() => setCopied(true))}>
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </button>
          </div>
        ) : null}
        {items && items.length > 0 ? (
          <div className="rows card" style={{ padding: 0 }}>
            {items.map((k) => (
              <div className="rowi" key={k.id}>
                <span className={"rowi__icon" + (k.revokedAt ? "" : " rowi__icon--ok")}>
                  <IconKey size={14} />
                </span>
                <div className="rowi__main">
                  <span className="rowi__title mono">{k.prefix}...</span>
                  <span className="rowi__meta">
                    {k.revokedAt ? "Revoked" : k.sessionAddress && sameAddress(k.sessionAddress, a.config.agent) ? "The agent's key" : "Not the agent"}
                    {k.lastUsedAt ? `, used ${formatTime(k.lastUsedAt)}` : ", never used"}
                  </span>
                </div>
                {!k.revokedAt ? (
                  <button type="button" className="icon-btn" aria-label="Revoke key" disabled={action.busy} onClick={() => void revoke(k.id)}>
                    <IconTrash size={16} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <details>
          <summary className="small link" style={{ cursor: "pointer" }}>
            Scopes ({scopes.length} of {ALL_SCOPES.length})
          </summary>
          <div className="chips" style={{ marginTop: 10 }}>
            {ALL_SCOPES.map((s) => (
              <label key={s} className="check">
                <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))} />
                <span>{s}</span>
              </label>
            ))}
          </div>
        </details>
        <div className="row">
          <button type="button" className="btn btn--primary" disabled={action.busy || scopes.length === 0} onClick={() => void create()}>
            <IconPlus size={15} />
            New agent key
          </button>
          {!token ? (
            <button type="button" className="btn btn--secondary" disabled={action.busy} onClick={() => void view()}>
              Show keys
            </button>
          ) : null}
        </div>
        <ActionStatus state={action.state} />
      </div>
    </Card>
  );
}

function AllowlistCard({ a, owner, done }: CardProps) {
  const [address, setAddress] = useState("");
  const action = useAction();
  const change = (body: { allow?: string[]; disallow?: string[] }, message: string) =>
    action.run(async () => {
      const tx = await api<PreparedSafeTx>(`/v1/accounts/${a.safe}/rules/prepare`, { body });
      await owner.signer.execSafeTx(tx);
      done();
      setAddress("");
      return message;
    });
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim());
  return (
    <Card title="Allowlist">
      <div className="form">
        <p className="small muted">{a.config.payeeAllowlist ? "The agent may pay only these addresses." : "Contracts the agent may call. Turn on “only pay addresses on the allowlist” in the rules to limit payees too."}</p>
        {a.allowlist.length === 0 ? (
          <EmptyState size="sm" title="Nothing on the allowlist" text="Add the payees and contracts this agent may use." />
        ) : (
          <div className="rows card" style={{ padding: 0 }}>
            {a.allowlist.map((addr) => (
              <div className="rowi" key={addr}>
                <span className="rowi__icon">
                  <IconCheck size={14} />
                </span>
                <div className="rowi__main">
                  <span className="rowi__title mono">{shortAddress(addr)}</span>
                  <span className="rowi__meta">{owner.names[addr.toLowerCase()] ?? (sameAddress(addr, owner.engine.contracts.escrow) ? "Purser escrow" : "Address")}</span>
                </div>
                <button type="button" className="icon-btn" aria-label="Remove from the allowlist" disabled={action.busy} onClick={() => void change({ disallow: [addr] }, "Removed from the allowlist.")}>
                  <IconTrash size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
        <form
          className="row"
          style={{ flexWrap: "nowrap" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void change({ allow: [address.trim()] }, "Added to the allowlist.");
          }}
        >
          <input className="input input--mono" aria-label="Address to allow" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x..." />
          <button type="submit" className="btn btn--secondary" disabled={!valid || action.busy}>
            Allow
          </button>
        </form>
        <ActionStatus state={action.state} />
      </div>
    </Card>
  );
}

function PasskeyCard({ a, owner, done }: CardProps) {
  const action = useAction();
  const usesPasskey = a.approver !== null && sameAddress(a.approver, owner.engine.contracts.passkey);
  const rule = dollarRule(a.rules);
  const register = () =>
    action.run(async (status) => {
      status("Create a passkey on this device...");
      const { x, y } = await createPasskey(a.safe, a.name);
      status("Put the passkey on chain. Confirm in your wallet...");
      const tx = await api<PreparedSafeTx>(`/v1/accounts/${a.safe}/passkey/prepare`, { body: { x, y } });
      await owner.signer.execSafeTx(tx);
      done();
      return "Passkey added. Approve payments with it from this device.";
    }, "Starting...");
  return (
    <Card title="Approvals" action={<IconFingerprint size={16} />}>
      <div className="form">
        <p className="small muted">
          Payments above {rule?.approvalAbove ? formatMoney(rule.approvalAbove, rule.token) : "the approval amount"} wait for you. Approve them with this wallet, or with a passkey on your phone or laptop, checked on chain.
        </p>
        <dl className="kv">
          <div className="kv__row">
            <dt>Approve with</dt>
            <dd>{usesPasskey ? "Passkey or owner wallet" : "Owner wallet"}</dd>
          </div>
          <div className="kv__row">
            <dt>Second signer</dt>
            <dd>{a.config.cosigner ? shortAddress(a.config.cosigner) : "None"}</dd>
          </div>
        </dl>
        <div className="row">
          {passkeySupported() ? (
            <button type="button" className="btn btn--secondary" disabled={action.busy} onClick={() => void register()}>
              <IconFingerprint size={15} />
              {usesPasskey ? "Replace the passkey" : "Add a passkey"}
            </button>
          ) : (
            <span className="field__hint">This browser has no passkeys. Approvals use your wallet.</span>
          )}
          <Link href="/app/approvals" className="btn btn--ghost">
            Open approvals
          </Link>
        </div>
        <ActionStatus state={action.state} />
      </div>
    </Card>
  );
}

function RecoveryCard({ a, owner, done }: CardProps) {
  const [guardian, setGuardian] = useState(a.guardian?.address ?? "");
  const [days, setDays] = useState(a.guardian ? String(Math.round(a.guardian.delaySeconds / 86400)) : "3");
  const action = useAction();
  const valid = /^0x[0-9a-fA-F]{40}$/.test(guardian.trim()) && Number(days) >= 1;
  const save = (remove = false) =>
    action.run(async () => {
      const body = { guardian: remove ? null : { address: guardian.trim(), delaySeconds: Math.round(Number(days)) * 86400 } };
      const tx = await api<PreparedSafeTx>(`/v1/accounts/${a.safe}/rules/prepare`, { body });
      await owner.signer.execSafeTx(tx);
      done();
      return remove ? "Recovery switched off." : "Recovery is set.";
    });
  const cancel = () =>
    action.run(async () => {
      const tx = await api<PreparedTx>(`/v1/accounts/${a.safe}/recovery/cancel/prepare`, { body: {} });
      await owner.signer.sendTx(tx);
      done();
      return "The recovery was cancelled.";
    });
  const now = useNow();
  return (
    <Card title="Recovery">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save();
        }}
      >
        <p className="small muted">A guardian can propose new owners if you lose your wallet. It only takes effect after the waiting period, and any owner can cancel it until then.</p>
        {a.recovery ? (
          <div className="action-status action-status--error">
            <IconLock size={15} />
            <span>
              A recovery is pending. It can be executed {relativeTime(a.recovery.executeAfter, now)}.{" "}
              <button type="button" className="link" onClick={() => void cancel()} disabled={action.busy}>
                Cancel it
              </button>
            </span>
          </div>
        ) : null}
        <div className="form__row">
          <label className="field">
            <span className="field__label">Guardian</span>
            <input className="input input--mono" value={guardian} onChange={(e) => setGuardian(e.target.value)} placeholder="0x... a wallet you trust" />
          </label>
          <label className="field">
            <span className="field__label">Waiting period</span>
            <span className="input-affix">
              <input className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ""))} />
              <span className="input-affix__unit">days</span>
            </span>
          </label>
        </div>
        {a.guardian ? <span className="field__hint">Now: {shortAddress(a.guardian.address)}, waiting period {formatDuration(a.guardian.delaySeconds)}.</span> : null}
        <div className="row">
          <button type="submit" className="btn btn--secondary" disabled={!valid || action.busy}>
            {a.guardian ? "Change the guardian" : "Set a guardian"}
          </button>
          {a.guardian ? (
            <button type="button" className="btn btn--ghost" disabled={action.busy} onClick={() => void save(true)}>
              Remove
            </button>
          ) : null}
        </div>
        <ActionStatus state={action.state} />
      </form>
    </Card>
  );
}

export { initials };
