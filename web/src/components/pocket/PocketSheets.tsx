"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { errorMessage } from "@/lib/client";
import { formatMoney, money as tokenMoney, percentOf, shortAddress } from "@/lib/format";
import { categoryLabel } from "@/lib/labels";
import {
  ago,
  clockMinutes,
  clockText,
  dollars,
  pocketApi,
  rememberLock,
  turnOffPush,
  type AgentDetail,
  type FeedDetail,
  type FeedItem,
  type PocketAuth,
  type PocketMe,
  type PocketPrefs,
} from "@/lib/pocket";
import { IconAlert, IconArrowIn, IconArrowOut, IconLock, IconShieldX, IconSnow, IconX } from "../Icons";
import { initials } from "../ui";
import { usePocketData } from "./data";

const EXPLORER = "https://robinhoodchain.blockscout.com";

export function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="pk-sheet-wrap" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="pk-sheet-scrim" aria-label="Close" onClick={onClose} />
      <div className="pk-sheet">
        <div className="pk-sheet-grab" aria-hidden="true" />
        <div className="pk-sheet-head">
          <h2 className="pk-h2">{title}</h2>
          <button type="button" className="pk-icon-btn" aria-label="Close" onClick={onClose}>
            <IconX size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function FeedIcon({ kind }: { kind: FeedItem["kind"] }) {
  return (
    <span className={`pk-row-icon pk-row-icon--${kind}`}>
      {kind === "paid" ? <IconArrowOut size={15} /> : kind === "earned" ? <IconArrowIn size={15} /> : kind === "watchdog" ? <IconAlert size={15} /> : <IconShieldX size={15} />}
    </span>
  );
}

// ------------------------------------------------------------------------------------------------ freeze

export function FreezeSheet({ auth, me, onClose, onDone }: { auth: PocketAuth; me: PocketMe; onClose(): void; onDone(m: string): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = me.accounts.filter((a) => !a.frozen);
  const able = live.filter((a) => me.canFreeze[a.safe]);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await pocketApi<{ results: { frozen: boolean; name: string; message: string; txHash: string | null }[] }>(auth, "/v1/pocket/freeze", { body: { safes: "all" } });
      const done = r.results.filter((x) => x.frozen).length;
      const failed = r.results.filter((x) => !x.frozen);
      onDone(failed.length ? `${done} frozen. ${failed.map((f) => `${f.name}: ${f.message}`).join(" ")}` : done === 1 ? "Your agent is frozen. No payment can leave." : `All ${done} agents are frozen. No payment can leave.`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Sheet title={live.length === 1 ? "Freeze your agent?" : "Freeze all agents?"} onClose={onClose}>
      <p className="pk-sheet-text">
        No payment can leave {live.length === 1 ? "this agent" : `these ${live.length} agents`} until you unfreeze {live.length === 1 ? "it" : "them"} with your wallet on your computer.
      </p>
      <div className="pk-list pk-list--flat">
        {live.map((a) => (
          <div key={a.safe} className="pk-agent">
            <span className="pk-avatar" aria-hidden="true">
              {initials(a.name)}
            </span>
            <span className="pk-agent-main">
              <span className="pk-agent-name">{a.name}</span>
              <span className="pk-agent-sub">{me.canFreeze[a.safe] ? `${dollars(a.spentTodayUsd)} spent today` : "Freeze this one from your computer"}</span>
            </span>
          </div>
        ))}
      </div>
      {able.length < live.length ? <p className="pk-sheet-text pk-muted">{live.length - able.length === 1 ? "One agent" : `${live.length - able.length} agents`} can only be frozen from your computer, because the watchdog is off there.</p> : null}
      <button type="button" className="pk-btn pk-btn--freeze pk-btn--block" disabled={busy || able.length === 0} onClick={() => void go()}>
        <IconSnow size={18} />
        {busy ? "Freezing..." : able.length === live.length ? (live.length === 1 ? "Freeze it" : `Freeze all ${live.length}`) : `Freeze ${able.length}`}
      </button>
      {error ? <p className="pk-error">{error}</p> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------ settings

const PREF_ROWS: { key: "blocked" | "watchdog" | "budget" | "statement" | "weekly"; label: string; text: string }[] = [
  { key: "blocked", label: "Blocked payments", text: "The firewall, the rules or Purser Shield stopped a payment" },
  { key: "watchdog", label: "Watchdog", text: "Something unusual, or an agent was frozen" },
  { key: "budget", label: "Budgets", text: "A spending alert was passed or a balance ran low" },
  { key: "statement", label: "Daily statement", text: "Every morning at 08:00" },
  { key: "weekly", label: "Weekly report", text: "Monday at 08:00, the last seven days" },
];

export function SettingsSheet({ auth, me, onClose, onChange, onUnpaired }: { auth: PocketAuth; me: PocketMe; onClose(): void; onChange(): void; onUnpaired(): void }) {
  const [prefs, setPrefs] = useState<PocketPrefs>(me.device.prefs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasKey = !!auth.credentialId && me.device.passkey;

  // Each switch saves on its own; quick taps on several switches never undo each other.
  async function save(patch: Partial<PocketPrefs>) {
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, prefs[k as keyof PocketPrefs]])) as Partial<PocketPrefs>;
    setPrefs((p) => ({ ...p, ...patch }));
    setError(null);
    try {
      await pocketApi<{ prefs: PocketPrefs }>(auth, "/v1/pocket/prefs", { method: "PATCH", body: patch });
      if (patch.lock !== undefined) rememberLock(patch.lock);
      onChange();
    } catch (e) {
      setPrefs((p) => ({ ...p, ...before }));
      setError(errorMessage(e));
    }
  }

  return (
    <Sheet title="Settings" onClose={onClose}>
      <h3 className="pk-set-title">Notifications</h3>
      <div className="pk-set-group">
        <div className="pk-set-row">
          <span>
            <b>Notifications</b>
            <small>{me.device.push ? "On for this phone" : "Off. Turn them on from the home screen."}</small>
          </span>
          {me.device.push ? (
            <button
              type="button"
              className="pk-btn pk-btn--small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await turnOffPush(auth).catch(() => undefined);
                setBusy(false);
                onChange();
              }}
            >
              Turn off
            </button>
          ) : null}
        </div>
        <div className="pk-set-row">
          <span>
            <b>Payments waiting for you</b>
            <small>Always on</small>
          </span>
          <span className="pk-switch pk-switch--on pk-switch--locked" aria-hidden="true" />
        </div>
        {PREF_ROWS.map((r) => (
          <label key={r.key} className="pk-set-row">
            <span>
              <b>{r.label}</b>
              <small>{r.text}</small>
            </span>
            <input type="checkbox" className="pk-switch-input" checked={prefs[r.key]} onChange={() => void save({ [r.key]: !prefs[r.key] })} />
            <span className={"pk-switch" + (prefs[r.key] ? " pk-switch--on" : "")} aria-hidden="true" />
          </label>
        ))}
      </div>

      <h3 className="pk-set-title">Quiet hours</h3>
      <div className="pk-set-group">
        <label className="pk-set-row">
          <span>
            <b>Quiet hours</b>
            <small>Only payments waiting for you and watchdog freezes get through. The rest still shows in the feed.</small>
          </span>
          <input type="checkbox" className="pk-switch-input" checked={prefs.quiet} onChange={() => void save({ quiet: !prefs.quiet })} />
          <span className={"pk-switch" + (prefs.quiet ? " pk-switch--on" : "")} aria-hidden="true" />
        </label>
        {prefs.quiet ? (
          <div className="pk-set-row pk-set-row--times">
            <label>
              <small>From</small>
              <input type="time" className="pk-time" aria-label="Quiet hours start" value={clockText(prefs.quietFrom)} onChange={(e) => e.target.value && void save({ quietFrom: clockMinutes(e.target.value) })} />
            </label>
            <label>
              <small>To</small>
              <input type="time" className="pk-time" aria-label="Quiet hours end" value={clockText(prefs.quietTo)} onChange={(e) => e.target.value && void save({ quietTo: clockMinutes(e.target.value) })} />
            </label>
          </div>
        ) : null}
      </div>

      <h3 className="pk-set-title">This phone</h3>
      <div className="pk-set-group">
        {hasKey ? (
          <label className="pk-set-row">
            <span>
              <b>Lock with Face ID</b>
              <small>A lock for the app: it asks for Face ID when you open it, and after five minutes away.</small>
            </span>
            <input type="checkbox" className="pk-switch-input" checked={prefs.lock} onChange={() => void save({ lock: !prefs.lock })} />
            <span className={"pk-switch" + (prefs.lock ? " pk-switch--on" : "")} aria-hidden="true" />
          </label>
        ) : (
          <div className="pk-set-row">
            <span>
              <b>Lock with Face ID</b>
              <small>Needs this phone&apos;s Face ID key. Pair the phone again with Face ID switched on.</small>
            </span>
            <IconLock size={18} />
          </div>
        )}
        <div className="pk-set-row">
          <span>
            <b>{me.device.name}</b>
            <small>
              Wallet {shortAddress(me.owner)}. {hasKey ? "Face ID uses this phone's own key." : "No Face ID key on this phone."}
            </small>
          </span>
        </div>
      </div>
      {error ? <p className="pk-error">{error}</p> : null}
      <button
        type="button"
        className="pk-btn pk-btn--block"
        onClick={async () => {
          await turnOffPush(auth).catch(() => undefined);
          await pocketApi(auth, "/v1/pocket/me", { method: "DELETE" }).catch(() => undefined);
          onUnpaired();
        }}
      >
        Unpair this phone
      </button>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------ one agent

function ruleLines(d: AgentDetail): { k: string; v: string }[] {
  const rule = d.account.rules.find((r) => r.enabled && r.token.symbol.toUpperCase() === "USDG") ?? d.account.rules.find((r) => r.enabled);
  if (!rule) return [];
  const m = (v: string | null, none: string) => (v === null ? none : formatMoney(v, rule.token));
  return [
    { k: "Largest single payment", v: m(rule.maxSingle, "No limit") },
    { k: "Daily budget", v: m(rule.daily, "No limit") },
    { k: "Weekly budget", v: m(rule.weekly, "No limit") },
    { k: "Asks you above", v: m(rule.approvalAbove, "Never asks") },
  ];
}

export function AgentSheet({ auth, safe, name, onGone, onClose, onDone }: { auth: PocketAuth; safe: string; name: string; onGone(): void; onClose(): void; onDone(m: string): void }) {
  const d = usePocketData<AgentDetail>(auth, `/v1/pocket/agents/${safe}`, ["receipt", "account", "intent"], onGone);
  const [busy, setBusy] = useState(false);
  const data = d.data;
  const rule = data?.account.rules.find((r) => r.enabled && r.token.symbol.toUpperCase() === "USDG") ?? data?.account.rules.find((r) => r.enabled);
  const spent = rule ? data?.account.spentToday.find((s) => s.token.address.toLowerCase() === rule.token.address.toLowerCase()) : undefined;
  const percent = rule?.daily && spent ? percentOf(spent.spent, rule.daily) : 0;

  async function freeze() {
    setBusy(true);
    try {
      const r = await pocketApi<{ results: { frozen: boolean; message: string; name: string }[] }>(auth, "/v1/pocket/freeze", { body: { safes: [safe] } });
      const x = r.results[0];
      onDone(x.frozen ? `${x.name} is frozen. No payment can leave.` : x.message);
    } catch (e) {
      onDone(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={name} onClose={onClose}>
      {!data ? (
        d.error ? (
          <p className="pk-empty">{d.error}</p>
        ) : (
          <div className="pk-splash pk-splash--inline" aria-busy="true" />
        )
      ) : (
        <>
          <div className="pk-detail-top">
            <div>
              <span className="pk-k">Balance</span>
              <span className="pk-detail-amt">{dollars(data.account.balanceUsd)}</span>
            </div>
            {data.account.frozen ? (
              <span className="pk-pill">
                <IconSnow size={12} />
                Frozen
              </span>
            ) : (
              <span className="pk-pill pk-pill--ok">
                <span className="pk-dot" />
                Active
              </span>
            )}
          </div>

          {rule && spent ? (
            <div className="pk-budget">
              <div className="pk-budget-head">
                <span>
                  <b>{formatMoney(spent.spent, rule.token)}</b> spent today
                </span>
                <span>{rule.daily ? `of ${formatMoney(rule.daily, rule.token)}` : "No daily limit"}</span>
              </div>
              <div className={"pk-meter" + (percent >= 100 ? " pk-meter--full" : "")} role="meter" aria-label="Spent today against the daily budget" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
                <span style={{ width: `${Math.max(percent, percent > 0 ? 2 : 0)}%` }} />
              </div>
              <div className="pk-budget-foot">
                <span>
                  {data.paymentsToday} {data.paymentsToday === 1 ? "payment" : "payments"} today
                </span>
                <span>{rule.daily && spent.remaining !== null ? `${formatMoney(spent.remaining, rule.token)} left` : `${dollars(data.account.earnedTodayUsd)} earned`}</span>
              </div>
            </div>
          ) : null}

          <h3 className="pk-set-title">Rules</h3>
          <div className="pk-kv">
            {ruleLines(data).map((r) => (
              <div key={r.k}>
                <span>{r.k}</span>
                <b>{r.v}</b>
              </div>
            ))}
          </div>

          <h3 className="pk-set-title">Last payments</h3>
          {data.receipts.length === 0 ? (
            <p className="pk-empty">No payments yet.</p>
          ) : (
            <div className="pk-list pk-list--flat">
              {data.receipts.slice(0, 5).map((r) => (
                <div key={r.id} className="pk-row pk-row--static">
                  <FeedIcon kind={r.direction === "in" ? "earned" : "paid"} />
                  <span className="pk-row-main">
                    <span className="pk-row-name">{r.memo || r.counterpartyName || categoryLabel[r.category] || "Payment"}</span>
                    <span className="pk-row-sub">
                      {categoryLabel[r.category] ?? r.category} · {ago(r.createdAt)}
                    </span>
                  </span>
                  <b className={"pk-amt" + (r.direction === "in" ? " pk-amt--in" : "")}>
                    {r.direction === "in" ? "+" : ""}
                    {tokenMoney(r.money)}
                  </b>
                </div>
              ))}
            </div>
          )}

          {data.account.frozen ? (
            <p className="pk-sheet-text pk-muted">Frozen. No payment can leave until you unfreeze it with your wallet on your computer.</p>
          ) : data.canFreeze ? (
            <button type="button" className="pk-btn pk-btn--freeze pk-btn--block" disabled={busy} onClick={() => void freeze()}>
              <IconSnow size={18} />
              {busy ? "Freezing..." : `Freeze ${name.split(",")[0]}`}
            </button>
          ) : (
            <p className="pk-sheet-text pk-muted">Freezing from the phone is off for this agent. Freeze it on your computer with your wallet.</p>
          )}
          <p className="pk-sheet-text pk-muted">Rules can only be changed with your wallet, on your computer.</p>
        </>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------ one line of the feed

const STATUS: Record<string, string> = { executed: "Paid", blocked: "Blocked", held: "Held by Purser Shield", rejected: "Rejected", frozen: "Frozen by the watchdog", alert: "Watchdog alert" };

export function ReceiptSheet({ auth, id, testMode, onGone, onClose }: { auth: PocketAuth; id: string; testMode: boolean; onGone(): void; onClose(): void }) {
  const d = usePocketData<FeedDetail>(auth, `/v1/pocket/feed/${id}`, [], onGone);
  const x = d.data;
  const kind = x?.item.kind;
  const title = kind === "earned" ? "Money in" : kind === "paid" ? "Payment" : kind === "blocked" ? "Blocked payment" : kind === "held" ? "Held payment" : kind === "watchdog" ? "Watchdog" : "Payment";
  const amount = x ? (x.item.usd ? dollars(x.item.usd) : x.item.display) : null;
  const when = x ? new Date(x.item.createdAt * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <Sheet title={title} onClose={onClose}>
      {!x ? (
        d.error ? (
          <p className="pk-empty">{d.error}</p>
        ) : (
          <div className="pk-splash pk-splash--inline" aria-busy="true" />
        )
      ) : (
        <>
          <div className="pk-detail-top">
            <div>
              <span className="pk-k">{kind === "earned" ? "Received" : kind === "paid" ? "Paid" : kind === "watchdog" ? "Agent" : "Tried to pay"}</span>
              <span className={"pk-detail-amt" + (kind === "earned" ? " pk-amt--in" : "")}>{kind === "watchdog" ? x.item.name : `${kind === "earned" ? "+" : ""}${amount ?? "No amount"}`}</span>
            </div>
            <FeedIcon kind={x.item.kind} />
          </div>
          <div className="pk-kv">
            {kind !== "watchdog" ? (
              <div>
                <span>Agent</span>
                <b>{x.item.name}</b>
              </div>
            ) : null}
            {x.counterparty ? (
              <div>
                <span>{kind === "earned" ? "Paid by" : kind === "paid" ? "Paid to" : "To"}</span>
                <b>{x.counterpartyName ? `${x.counterpartyName} · ${shortAddress(x.counterparty)}` : shortAddress(x.counterparty)}</b>
              </div>
            ) : null}
            {x.what ? (
              <div>
                <span>What for</span>
                <b>{x.what}</b>
              </div>
            ) : null}
            {x.item.category ? (
              <div>
                <span>Kind</span>
                <b>{(categoryLabel as Record<string, string>)[x.item.category] ?? x.item.category}</b>
              </div>
            ) : null}
            <div>
              <span>When</span>
              <b>{when}</b>
            </div>
            <div>
              <span>Status</span>
              <b>{kind === "earned" ? "Received" : (STATUS[x.status] ?? x.status)}</b>
            </div>
            {x.fee && tokenMoney(x.fee, 4) !== "$0.0000" && BigInt(x.fee.amount) > 0n ? (
              <div>
                <span>Purser fee</span>
                <b>{tokenMoney(x.fee, 4)}</b>
              </div>
            ) : null}
            {x.txHash ? (
              <div>
                <span>Transaction</span>
                {testMode ? (
                  <b className="pk-mono">{shortAddress(x.txHash)}</b>
                ) : (
                  <a className="pk-mono pk-a" href={`${EXPLORER}/tx/${x.txHash}`} target="_blank" rel="noreferrer">
                    {shortAddress(x.txHash)}
                  </a>
                )}
              </div>
            ) : null}
          </div>
          {x.reasons.length ? (
            <>
              <h3 className="pk-set-title">{kind === "watchdog" ? "What the watchdog saw" : kind === "held" ? "Why it waits" : "Why it was stopped"}</h3>
              <div className="pk-reasons">
                {x.reasons.map((r, i) => (
                  <div key={i} className="pk-reason">
                    <b>{r.title}</b>
                    {r.detail ? <p>{r.detail}</p> : null}
                  </div>
                ))}
              </div>
              {kind === "blocked" ? <p className="pk-sheet-text pk-muted">Nothing was paid.</p> : null}
            </>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
