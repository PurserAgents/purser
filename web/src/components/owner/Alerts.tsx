"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { formatMoney, formatTime, parseUnits } from "@/lib/format";
import { alertLabel, webhookEventLabel } from "@/lib/labels";
import { cachedSession, withOwner } from "@/lib/owner";
import type { Alert, AlertKind, Page, Webhook, WebhookDelivery, WebhookEventType } from "@/lib/types";
import { IconBell, IconCheck, IconCopy, IconLink, IconTrash } from "../Icons";
import { useEngine } from "../Live";
import { Card, EmptyState } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { OwnerFrame, busiest, useOwner } from "./Frame";
import { AgentPicker } from "./Picker";

const KINDS = Object.keys(alertLabel) as AlertKind[];
const EVENTS = Object.keys(webhookEventLabel) as WebhookEventType[];
const USDG = { symbol: "USDG", decimals: 6 };

export function Alerts() {
  return (
    <OwnerFrame title="Know when it matters." lead="Alerts per agent, sent as signed webhooks to any URL you run. Every delivery carries a Purser-Signature you can check with the SDK.">
      <Body />
    </OwnerFrame>
  );
}

function Body() {
  return (
    <div className="cols-main">
      <Webhooks />
      <AlertSettings />
    </div>
  );
}

function AlertSettings() {
  const owner = useOwner();
  const [safe, setSafe] = useState<string>(busiest(owner.accounts) ?? "");
  const alerts = useEngine<Page<Alert>>(safe ? `/v1/accounts/${safe}/alerts` : null, { refreshOn: ["alert"] });
  return (
    <Card title="Alerts" action={<AgentPicker accounts={owner.accounts} value={safe} onChange={setSafe} />}>
      {!alerts.data ? <div className="empty empty--sm" /> : <AlertForm key={safe + alerts.data.items.map((a) => a.kind + a.threshold).join()} safe={safe} items={alerts.data.items} reload={alerts.reload} />}
    </Card>
  );
}

function AlertForm({ safe, items, reload }: { safe: string; items: Alert[]; reload(): void }) {
  const owner = useOwner();
  const action = useAction();
  const [form, setForm] = useState(() => {
    const next = {} as Record<AlertKind, { on: boolean; threshold: string }>;
    for (const k of KINDS) {
      const a = items.find((x) => x.kind === k);
      next[k] = { on: !!a, threshold: a?.threshold ? formatMoney(a.threshold, USDG).replace(/[$,]/g, "") : "" };
    }
    return next;
  });
  const save = () =>
    action.run(async () => {
      const list = KINDS.filter((k) => form[k].on).map((k) => ({ kind: k, threshold: alertLabel[k].amount && form[k].threshold ? parseUnits(form[k].threshold, 6).toString() : null }));
      await withOwner(owner.signer, (token) => api(`/v1/accounts/${safe}/alerts`, { method: "PUT", token, body: { alerts: list } }));
      reload();
      return "Alerts saved.";
    }, "Sign in with your wallet...");
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {KINDS.map((k) => (
        <div key={k} className="stack" style={{ gap: 6 }}>
          <label className="switch">
            <input type="checkbox" checked={form[k].on} onChange={(e) => setForm({ ...form, [k]: { ...form[k], on: e.target.checked } })} />
            <span>{alertLabel[k].title}</span>
          </label>
          <span className="field__hint" style={{ paddingLeft: 46 }}>
            {alertLabel[k].text}
          </span>
          {alertLabel[k].amount && form[k].on ? (
            <span className="input-affix" style={{ marginLeft: 46 }}>
              <input className="input" aria-label={`${alertLabel[k].title} amount`} inputMode="decimal" value={form[k].threshold} onChange={(e) => setForm({ ...form, [k]: { ...form[k], threshold: e.target.value.replace(/[^0-9.]/g, "") } })} />
              <span className="input-affix__unit">USDG</span>
            </span>
          ) : null}
        </div>
      ))}
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={action.busy}>
          Save alerts
        </button>
      </div>
      <ActionStatus state={action.state} />
    </form>
  );
}

function Webhooks() {
  const owner = useOwner();
  const [token, setToken] = useState<string | null>(() => cachedSession(owner.address));
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>(["intent.blocked", "intent.queued", "account.frozen", "watchdog.alert", "alert"]);
  const [agent, setAgent] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const action = useAction();

  const load = async (tk: string) => setHooks((await api<Page<Webhook>>("/v1/webhooks", { token: tk })).items);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    api<Page<Webhook>>("/v1/webhooks", { token })
      .then((p) => alive && setHooks(p.items))
      .catch(() => alive && setToken(null));
    return () => {
      alive = false;
    };
  }, [token]);

  const signIn = () =>
    action.run(async () => {
      const tk = await owner.signer.session();
      setToken(tk);
      return "Signed in.";
    }, "Sign in with your wallet...");
  const create = () =>
    action.run(async () => {
      const r = await withOwner(owner.signer, (tk) => api<{ webhook: Webhook; secret: string }>("/v1/webhooks", { token: tk, body: { url: url.trim(), events, safe: agent || null } }));
      setSecret(r.secret);
      setCopied(false);
      setUrl("");
      const tk = await owner.signer.session();
      setToken(tk);
      await load(tk);
      return "Webhook added. Keep the signing secret: it is shown once.";
    }, "Saving...");
  const remove = (id: string) =>
    action.run(async () => {
      await withOwner(owner.signer, (tk) => api(`/v1/webhooks/${id}`, { method: "DELETE", token: tk }));
      if (token) await load(token);
      return "Webhook stopped.";
    });
  const test = (id: string) =>
    action.run(async () => {
      const r = await withOwner(owner.signer, (tk) => api<{ delivered: number }>(`/v1/webhooks/${id}/test`, { token: tk, body: {} }));
      await showDeliveries(id);
      return r.delivered ? "Test delivered." : "Test sent; the URL did not accept it yet. Retries follow.";
    }, "Sending a test...");
  const showDeliveries = async (id: string) => {
    if (!token) return;
    setOpen(id);
    setDeliveries((await api<Page<WebhookDelivery>>(`/v1/webhooks/${id}/deliveries`, { token })).items);
  };

  const active = (hooks ?? []).filter((h) => h.active);
  return (
    <Card title="Webhooks" action={<IconLink size={16} />}>
      <div className="form">
        {!token ? (
          <EmptyState size="sm" icon={IconBell} title="Sign in to see your webhooks" text="Webhooks belong to your wallet. Signing a message proves it is yours; it costs nothing.">
            <button type="button" className="btn btn--secondary btn--sm" disabled={action.busy} onClick={() => void signIn()}>
              Sign in with your wallet
            </button>
          </EmptyState>
        ) : active.length === 0 ? (
          <EmptyState size="sm" icon={IconBell} title="No webhooks yet" text="Add a URL below. Purser POSTs each event to it, signed, and retries after 5 seconds, 30 seconds and 2 minutes." />
        ) : (
          <div className="rows card" style={{ padding: 0 }}>
            {active.map((h) => (
              <div key={h.id}>
                <div className="rowi">
                  <span className="rowi__icon rowi__icon--ok">
                    <IconLink size={14} />
                  </span>
                  <div className="rowi__main">
                    <span className="rowi__title mono">{h.url}</span>
                    <span className="rowi__meta">
                      {h.events.length} events, {h.safe ? owner.names[h.safe.toLowerCase()] ?? "one agent" : "all agents"}
                    </span>
                  </div>
                  <div className="row" style={{ flexWrap: "nowrap" }}>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={action.busy} onClick={() => void test(h.id)}>
                      Test
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => void (open === h.id ? setOpen(null) : showDeliveries(h.id))}>
                      Log
                    </button>
                    <button type="button" className="icon-btn" aria-label="Stop this webhook" disabled={action.busy} onClick={() => void remove(h.id)}>
                      <IconTrash size={16} />
                    </button>
                  </div>
                </div>
                {open === h.id ? (
                  <div className="card__body" style={{ paddingTop: 0 }}>
                    {deliveries.length === 0 ? (
                      <span className="small muted">No deliveries yet.</span>
                    ) : (
                      <ul className="kv">
                        {deliveries.slice(0, 8).map((d) => (
                          <li className="kv__row" key={d.id}>
                            <span>
                              {webhookEventLabel[d.event] ?? d.event} <span className="muted micro">{formatTime(d.createdAt)} UTC</span>
                            </span>
                            <span className={"badge " + (d.status === "delivered" ? "badge--ok" : d.status === "failed" ? "badge--stop" : "badge--wait")}>
                              {d.status === "delivered" ? `Delivered${d.responseCode ? ` (${d.responseCode})` : ""}` : d.status === "failed" ? `Failed after ${d.attempts}` : "Retrying"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {secret ? (
          <div className="field">
            <span className="field__label">Signing secret, shown once</span>
            <div className="secret">
              <code>{secret}</code>
              <button type="button" className="icon-btn" aria-label="Copy the secret" onClick={() => void navigator.clipboard?.writeText(secret).then(() => setCopied(true))}>
                {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
              </button>
            </div>
          </div>
        ) : null}
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^https?:\/\//.test(url.trim()) && events.length) void create();
          }}
        >
          <div className="form__row">
            <label className="field">
              <span className="field__label">URL</span>
              <input className="input input--mono" value={url} placeholder="https://your-server/purser" onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">For</span>
              <select className="select" value={agent} onChange={(e) => setAgent(e.target.value)}>
                <option value="">All my agents</option>
                {owner.accounts.map((a) => (
                  <option key={a.safe} value={a.safe}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="field" style={{ border: 0, padding: 0 }}>
            <legend className="field__label" style={{ marginBottom: 8 }}>
              Events
            </legend>
            <div className="form__row">
              {EVENTS.map((ev) => (
                <label className="check" key={ev}>
                  <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents((cur) => (e.target.checked ? [...cur, ev] : cur.filter((x) => x !== ev)))} />
                  <span>{webhookEventLabel[ev]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="row">
            <button type="submit" className="btn btn--primary" disabled={action.busy || !/^https?:\/\//.test(url.trim()) || events.length === 0}>
              Add webhook
            </button>
          </div>
        </form>
        <ActionStatus state={action.state} />
      </div>
    </Card>
  );
}
