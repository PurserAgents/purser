"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { formatTime, shortAddress, usd } from "@/lib/format";
import { withOwner } from "@/lib/owner";
import type { AccountShield, Page, Verdict, WatchdogView } from "@/lib/types";
import { IconAlert, IconCheck, IconEye, IconShield, IconShieldX, IconSnow } from "../Icons";
import { useEngine } from "../Live";
import { Card, EmptyState, Loading } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { OwnerFrame, useOwner } from "./Frame";
import { useMany } from "./hooks";

export function Safety() {
  return (
    <OwnerFrame title="What the firewall, the Shield and the watchdog saw." lead="Every payment is simulated and checked before it is signed, against your rules and against every attack other Purser accounts caught. The watchdog compares spending with each agent's normal pattern and can freeze it.">
      <Body />
    </OwnerFrame>
  );
}

function plainTrigger(text: string | null): string | null {
  if (!text) return null;
  const t = text.replace(/<!--|-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 280 ? t.slice(0, 277) + "..." : t;
}

function Body() {
  const owner = useOwner();
  const [filter, setFilter] = useState<"block" | "allow" | "all">("block");
  const verdicts = useEngine<Page<Verdict>>(`/v1/verdicts?limit=200${filter === "all" ? "" : `&decision=${filter}`}`, { refreshOn: ["verdict"] });
  const watch = useMany<WatchdogView>(owner.accounts.map((a) => a.safe), (s) => `/v1/accounts/${s}/watchdog`, ["watchdog", "account"]);
  const shield = useMany<AccountShield>(owner.accounts.map((a) => a.safe), (s) => `/v1/accounts/${s}/shield`, ["intent", "verdict"]);
  const held = Object.values(shield.data).flatMap((v) => v.held.map((h) => ({ ...h, safe: v.safe })));
  const mine = (verdicts.data?.items ?? []).filter((v) => owner.names[v.safe.toLowerCase()]);
  const events = Object.values(watch.data)
    .flatMap((w) => w.events)
    .sort((a, b) => b.createdAt - a.createdAt);
  const freezes = events.filter((e) => e.action === "freeze").length;

  return (
    <div className="dash">
      <dl className="cells cells--4">
        <div className="cell">
          <dt className="stat__label">Shown verdicts</dt>
          <dd className="stat__value num">{mine.length}</dd>
          <dd className="stat__note">{filter === "block" ? "Blocked payments" : filter === "allow" ? "Allowed payments" : "Allowed and blocked"}</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Watchdog events</dt>
          <dd className="stat__value num">{events.length}</dd>
          <dd className="stat__note">Spikes, loops, bursts, drains, new payees</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Freezes by the watchdog</dt>
          <dd className="stat__value num">{freezes}</dd>
          <dd className="stat__note">Only where you left auto-freeze on</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Agents frozen now</dt>
          <dd className="stat__value num">{owner.accounts.filter((a) => a.frozen).length}</dd>
          <dd className="stat__note">of {owner.accounts.length}</dd>
        </div>
      </dl>

      <div className="cols-main">
        <Card
          title="Firewall verdicts"
          action={
            <div className="segmented" role="group" aria-label="Show">
              {(["block", "allow", "all"] as const).map((f) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {f === "block" ? "Blocked" : f === "allow" ? "Allowed" : "All"}
                </button>
              ))}
            </div>
          }
          flush
        >
          {!verdicts.data ? (
            <Loading />
          ) : mine.length === 0 ? (
            <EmptyState icon={IconShield} title={filter === "allow" ? "No allowed payments yet" : "Nothing blocked"} text="Each payment your agents make is simulated and checked first. The verdict and its reasons show up here." />
          ) : (
            <div className="rows">
              {mine.slice(0, 40).map((v) => {
                const blocked = v.decision === "block";
                const reasons = v.reasons.filter((r) => r.severity !== "info");
                const trigger = plainTrigger(v.trigger);
                return (
                  <details className="rowi" key={v.id} style={{ display: "block" }}>
                    <summary style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr) auto", gap: 16, alignItems: "center", cursor: "pointer", listStyle: "none" }}>
                      <span className={"rowi__icon " + (blocked ? "rowi__icon--stop" : "rowi__icon--ok")}>{blocked ? <IconShieldX size={15} /> : <IconCheck size={15} />}</span>
                      <span className="rowi__main">
                        <span className="rowi__title">{blocked ? (reasons.find((r) => r.severity === "block")?.title ?? v.summary) : v.summary}</span>
                        <span className="rowi__meta">
                          {owner.names[v.safe.toLowerCase()]}, {formatTime(v.createdAt)} UTC
                        </span>
                      </span>
                      <span className={"badge " + (blocked ? "badge--stop" : "badge--ok")}>{blocked ? "Blocked" : "Allowed"}</span>
                    </summary>
                    <div className="stack" style={{ gap: 10, marginTop: 14, paddingLeft: 48 }}>
                      <p className="small">{v.summary}</p>
                      {reasons.length ? (
                        <ul className="checks">
                          {reasons.map((r, i) => (
                            <li key={r.code + i}>
                              {r.severity === "block" ? <IconShieldX size={15} /> : <IconAlert size={15} />}
                              <span>
                                <strong>{r.title}.</strong> {r.detail}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {trigger ? (
                        <p className="fw__hidden" style={{ margin: 0 }}>
                          <span className="fw__hidden-label">What the agent read</span>
                          {trigger}
                        </p>
                      ) : null}
                      {v.simulation ? <span className="micro muted">Simulated with {v.simulation.backend}{v.simulation.success ? "" : `, would revert: ${v.simulation.revertReason ?? "unknown reason"}`}</span> : null}
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </Card>
        <div className="dash">
          <Card title="Purser Shield" action={<a href="/shield" className="small link">The shared list</a>} flush>
            <div className="rows">
              {owner.accounts.map((a) => (
                <ShieldMode key={a.safe} safe={a.safe} name={a.name} view={shield.data[a.safe]} reload={shield.reload} />
              ))}
            </div>
          </Card>
          {held.length ? (
            <Card title="Held by Purser Shield" action={<span className="badge badge--wait">{held.length} to decide</span>} flush>
              <div className="rows">
                {held.map((h) => (
                  <Held key={h.id} item={h} name={owner.names[h.safe.toLowerCase()]} reload={shield.reload} />
                ))}
              </div>
            </Card>
          ) : null}
          <Card title="Watchdog" flush>
            <div className="rows">
              {owner.accounts.map((a) => (
                <AutoFreeze key={a.safe} safe={a.safe} name={a.name} view={watch.data[a.safe]} reload={watch.reload} />
              ))}
            </div>
          </Card>
        </div>
      </div>
      <Card title="Watchdog events" flush>
            {watch.loading ? (
          <Loading />
        ) : events.length === 0 ? (
              <EmptyState size="sm" icon={IconEye} title="All quiet" text="When spending looks unlike an agent's normal pattern, the event and its reason show up here." />
            ) : (
              <div className="rows">
                {events.slice(0, 8).map((e) => (
                  <div className="rowi" key={e.id}>
                    <span className={"rowi__icon " + (e.action === "freeze" ? "rowi__icon--stop" : "rowi__icon--wait")}>{e.action === "freeze" ? <IconSnow size={15} /> : <IconAlert size={15} />}</span>
                    <div className="rowi__main">
                      <span className="rowi__title">{e.title}</span>
                      <span className="rowi__meta">{e.detail}</span>
                      <span className="rowi__meta">
                        {owner.names[e.safe.toLowerCase()]}, {formatTime(e.createdAt)} UTC, {e.action === "freeze" ? "frozen" : "alert sent"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
    </div>
  );
}

function AutoFreeze({ safe, name, view, reload }: { safe: string; name: string; view: WatchdogView | undefined; reload(): void }) {
  const owner = useOwner();
  const action = useAction();
  const on = view?.baseline.autoFreeze ?? false;
  const toggle = (next: boolean) =>
    action.run(async () => {
      await withOwner(owner.signer, (token) => api(`/v1/accounts/${safe}/watchdog`, { method: "PATCH", token, body: { autoFreeze: next } }));
      reload();
      return next ? "Auto-freeze is on." : "Auto-freeze is off. You still get the alerts.";
    }, "Sign in with your wallet...");
  return (
    <div className="rowi">
      <span className="rowi__icon">
        <IconEye size={15} />
      </span>
      <div className="rowi__main">
        <span className="rowi__title">{name}</span>
        <span className="rowi__meta">{!view ? "Loading the baseline..." : view.baseline.samples === 0 ? "Still learning what normal looks like" : `Normal: about ${usd(view.baseline.hourlyMeanUsd)} an hour, ${view.baseline.knownCounterparties} known payees`}</span>
        {action.state.kind === "error" ? <ActionStatus state={action.state} /> : null}
      </div>
      <label className="switch" title="Freeze automatically on critical events">
        <input type="checkbox" aria-label={`Auto-freeze ${name}`} checked={on} disabled={!view || action.busy} onChange={(e) => void toggle(e.target.checked)} />
        <span className="small">Auto-freeze</span>
      </label>
    </div>
  );
}

function ShieldMode({ safe, name, view, reload }: { safe: string; name: string; view: AccountShield | undefined; reload(): void }) {
  const owner = useOwner();
  const action = useAction();
  const mode = view?.mode ?? "block";
  const set = (next: "block" | "warn") =>
    action.run(async () => {
      await withOwner(owner.signer, (token) => api(`/v1/accounts/${safe}/shield`, { method: "PATCH", token, body: { mode: next } }));
      reload();
      return next === "block" ? "Shield matches are blocked." : "Shield matches wait for you.";
    }, "Sign in with your wallet...");
  return (
    <div className="rowi shield-mode">
      <span className="rowi__icon">
        <IconShield size={15} />
      </span>
      <div className="rowi__main">
        <span className="rowi__title">{name}</span>
        <span className="rowi__meta">{mode === "block" ? "Anything on the shared list is refused" : "A match waits for you to release or reject it"}</span>
        {action.state.kind === "error" ? <ActionStatus state={action.state} /> : null}
      </div>
      <div className="segmented" role="group" aria-label={`Purser Shield for ${name}`}>
        <button type="button" aria-pressed={mode === "block"} disabled={!view || action.busy} onClick={() => mode !== "block" && void set("block")}>
          Block
        </button>
        <button type="button" aria-pressed={mode === "warn"} disabled={!view || action.busy} onClick={() => mode !== "warn" && void set("warn")}>
          Warn me
        </button>
      </div>
    </div>
  );
}

function Held({ item, name, reload }: { item: AccountShield["held"][number] & { safe: string }; name: string | undefined; reload(): void }) {
  const owner = useOwner();
  const action = useAction();
  const decide = (what: "release" | "reject") =>
    action.run(async () => {
      await withOwner(owner.signer, (token) => api(`/v1/intents/${item.id}/${what}`, { method: "POST", token, body: {} }));
      reload();
      return what === "release" ? "Released and sent." : "Rejected. Nothing was sent.";
    }, "Sign in with your wallet...");
  return (
    <div className="rowi" style={{ alignItems: "flex-start" }}>
      <span className="rowi__icon rowi__icon--wait">
        <IconShieldX size={15} />
      </span>
      <div className="rowi__main">
        <span className="rowi__title">{item.summary}</span>
        <span className="rowi__meta">
          {name ?? shortAddress(item.safe)}, to {shortAddress(item.to)}, held {formatTime(item.createdAt)} UTC
        </span>
        {item.why ? <span className="rowi__meta">{item.why}</span> : null}
        <ActionStatus state={action.state} />
        <div className="row" style={{ marginTop: 8 }}>
          <button type="button" className="btn btn--secondary btn--sm" disabled={action.busy} onClick={() => void decide("reject")}>
            Reject
          </button>
          <button type="button" className="btn btn--primary btn--sm" disabled={action.busy} onClick={() => void decide("release")}>
            Release and pay
          </button>
        </div>
      </div>
    </div>
  );
}
