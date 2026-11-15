"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { EngineError, api, errorMessage } from "@/lib/client";
import { sameAddress, shortAddress } from "@/lib/format";
import { categoryLabel } from "@/lib/labels";
import { createDevicePasskey, passkeySupported, signWithCredential } from "@/lib/passkey";
import {
  ago,
  deviceLabel,
  dollars,
  faceIdFor,
  isDesktop,
  isIOS,
  isStandalone,
  lockWanted,
  pocketApi,
  pushSupported,
  readPocket,
  rememberLock,
  setIconBadge,
  turnOnPush,
  writePocket,
  type FeedItem,
  type HeldPayment,
  type PocketAuth,
  type PocketMe,
  type Statement,
} from "@/lib/pocket";
import type { Account, EngineConfig, Page, PayResult, PendingApproval, PreparedSafeTx } from "@/lib/types";
import { IconArrowRight, IconBell, IconCheck, IconFingerprint, IconLock, IconShield, IconSliders, IconSnow } from "../Icons";
import { initials } from "../ui";
import { AgentSheet, FeedIcon, FreezeSheet, ReceiptSheet, SettingsSheet } from "./PocketSheets";
import { usePocketData } from "./data";
import "./pocket.css";

type View = "home" | "statement";

const LOCK_AFTER_MS = 5 * 60_000;
const UNPAIRED = "This phone was unpaired. Pair it again from your computer.";

function amountOf(m: { usd: string | null; display: string } | null | undefined): string {
  if (!m) return "";
  return m.usd !== null ? dollars(m.usd) : m.display;
}

/** What became of a payment after the owner said yes: it is only "paid" when the engine says it executed. */
function outcome(word: "Approved" | "Released", amount: string, result: PayResult | null | undefined): string {
  const status = result?.intent.status;
  if (status === "executed") return `${word}. ${amount} was paid.`;
  if (status === "queued") return `${word}. It is above your approval amount, so it now waits for your approval.`;
  if (status === "needs_cosign") return `${word}. It still needs its second signature before it is paid.`;
  if (status === "blocked" || status === "failed") {
    const why = (result?.verdict?.decision === "block" ? result.verdict.summary : null) ?? result?.intent.error ?? "the rules or the firewall refused it";
    return `${word}, but it was not paid: ${why.replace(/\.$/, "")}. Nothing left the account.`;
  }
  return `${word}. ${amount} is being sent.`;
}

const faceIdError = (e: unknown) => {
  const m = errorMessage(e);
  return /NotAllowed|timed out|not allowed|abort/i.test(m) ? "Face ID was cancelled. Nothing changed." : m;
};

/** Purser in your pocket: the whole phone app. */
export function Pocket({ view = "home" }: { view?: View }) {
  const [auth, setAuth] = useState<PocketAuth | null>(null);
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [desk, setDesk] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    // Read once on the phone; the server render shows the opening screen only.
    const stored = readPocket();
    const wide = isDesktop();
    queueMicrotask(() => {
      setAuth(stored);
      setLocked(!!stored?.credentialId && lockWanted());
      setDesk(wide);
      setReady(true);
    });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type === "open" && d.url) router.push(new URL(d.url).pathname + new URL(d.url).search);
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [router]);

  // Lock with Face ID: back after five minutes away, the app asks again.
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt !== null) {
        if (Date.now() - hiddenAt > LOCK_AFTER_MS && lockWanted() && readPocket()?.credentialId) setLocked(true);
        hiddenAt = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const unpaired = useCallback((message: string | null) => {
    writePocket(null);
    setIconBadge(0);
    setAuth(null);
    setLocked(false);
    setNotice(message);
  }, []);

  let body: ReactNode;
  if (!ready) body = <div className="pk-splash" aria-busy="true" />;
  else if (!auth)
    body = (
      <Onboard
        notice={notice}
        desk={desk}
        onPaired={(a) => {
          writePocket(a);
          setNotice(null);
          setAuth(a);
        }}
      />
    );
  else if (locked) body = <LockScreen auth={auth} onUnlock={() => setLocked(false)} onUnpaired={() => unpaired(UNPAIRED)} />;
  else if (view === "statement") body = <StatementView auth={auth} onUnpaired={() => unpaired(UNPAIRED)} />;
  else body = <Home auth={auth} onUnpaired={(m) => unpaired(m)} />;

  return <div className="pocket">{body}</div>;
}

// ------------------------------------------------------------------------------------------------ pairing

function Onboard({ notice, desk, onPaired }: { notice: string | null; desk: boolean; onPaired(a: PocketAuth): void }) {
  const [skipInstall, setSkipInstall] = useState(false);
  const [here, setHere] = useState(false);
  const [env, setEnv] = useState<{ ios: boolean; standalone: boolean; passkeys: boolean; push: boolean } | null>(null);
  const [config, setConfig] = useState<EngineConfig | null>(null);
  useEffect(() => {
    const e = { ios: isIOS(), standalone: isStandalone(), passkeys: passkeySupported(), push: pushSupported() };
    queueMicrotask(() => setEnv(e));
    api<EngineConfig>("/v1/config")
      .then(setConfig)
      .catch(() => undefined);
  }, []);
  if (!env) return <div className="pk-splash" aria-busy="true" />;
  if (desk && !here) return <OnComputer onHere={() => setHere(true)} />;
  if (env.ios && !env.standalone && !skipInstall) return <Install onSkip={() => setSkipInstall(true)} />;
  return <Pair notice={notice} passkeys={env.passkeys} testMode={!!config?.testMode} config={config} onPaired={onPaired} />;
}

function Brand({ right, back }: { right?: ReactNode; back?: boolean }) {
  // Opened in the browser (not from the Home Screen): a way back to the site, since there is no site header here.
  const showBack = back && !right && !isStandalone();
  return (
    <header className="pk-top">
      <span className="pk-brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pocket/icon-192.png" alt="" width={28} height={28} />
        Purser
      </span>
      {right}
      {showBack && (
        <Link href="/" className="pk-back" aria-label="Back to purseragents.fun">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to site
        </Link>
      )}
    </header>
  );
}

/** Opened on a computer: the app is for the phone, pairing starts on the dashboard. */
function OnComputer({ onHere }: { onHere(): void }) {
  return (
    <div className="pk-desk">
      <p className="pk-eyebrow">Purser in your pocket</p>
      <h1 className="pk-h1">
        Purser on your <em>phone.</em>
      </h1>
      <p className="pk-lead">Approve with Face ID, watch every payment as it happens and freeze any agent with one tap. This page is the app. Open it on your phone.</p>
      <ol className="pk-steps">
        <li>
          <span className="pk-step-n">1</span>
          <span>
            On this computer, open <b>Alerts</b> in your dashboard and press <b>Pair a phone</b>
          </span>
        </li>
        <li>
          <span className="pk-step-n">2</span>
          <span>
            On your phone, open <b>purseragents.fun/pocket</b>
          </span>
        </li>
        <li>
          <span className="pk-step-n">3</span>
          <span>Type the code from your computer into your phone</span>
        </li>
      </ol>
      <div className="pk-desk-actions">
        <Link href="/app/alerts" className="pk-btn pk-btn--primary">
          Pair from the dashboard
        </Link>
        <Link href="/docs#pocket" className="pk-btn">
          Read how it works
        </Link>
      </div>
      <button type="button" className="pk-link" onClick={onHere}>
        Use it on this computer
      </button>
    </div>
  );
}

function Install({ onSkip }: { onSkip(): void }) {
  return (
    <div className="pk-screen pk-screen--center">
      <Brand back />
      <div className="pk-hero">
        <p className="pk-eyebrow">Purser in your pocket</p>
        <h1 className="pk-h1">
          Add Purser to your <em>Home Screen.</em>
        </h1>
        <p className="pk-lead">It opens like any other app, full screen, and it is how your iPhone lets Purser send you notifications.</p>
      </div>
      <ol className="pk-steps">
        <li>
          <span className="pk-step-n">1</span>
          <span>
            Tap <b>Share</b>
            <svg className="pk-inline-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="the share button">
              <path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
            </svg>
            at the bottom of Safari
          </span>
        </li>
        <li>
          <span className="pk-step-n">2</span>
          <span>
            Choose <b>Add to Home Screen</b>
          </span>
        </li>
        <li>
          <span className="pk-step-n">3</span>
          <span>
            Open <b>Purser</b> from your Home Screen and pair it
          </span>
        </li>
      </ol>
      <button type="button" className="pk-link" onClick={onSkip}>
        Continue in Safari without notifications
      </button>
    </div>
  );
}

function formatCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

function Pair({ notice, passkeys, testMode, config, onPaired }: { notice: string | null; passkeys: boolean; testMode: boolean; config: EngineConfig | null; onPaired(a: PocketAuth): void }) {
  const [code, setCode] = useState("");
  const [faceId, setFaceId] = useState(passkeys);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(notice);

  async function claim(c: string, withFaceId: boolean, afterClaim?: (a: PocketAuth, key: { x: string; y: string } | null) => Promise<void>) {
    let key: { x: string; y: string; credentialId: string } | null = null;
    if (withFaceId) {
      setBusy("Use Face ID to make this phone's key...");
      key = await createDevicePasskey(deviceLabel());
    }
    setBusy("Pairing...");
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const r = await api<{ token: string; deviceId: string; owner: string }>("/v1/pocket/claim", { body: { code: c, name: deviceLabel(), tz, passkey: key } });
    const a: PocketAuth = { token: r.token, deviceId: r.deviceId, owner: r.owner, credentialId: key?.credentialId ?? null };
    if (afterClaim) await afterClaim(a, key);
    onPaired(a);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await claim(code, faceId);
    } catch (err) {
      setError(faceIdError(err).replace("Nothing changed.", "The phone is not paired yet."));
      setBusy(null);
    }
  }

  // Test mode only: the engine's test wallet plays the computer, so the whole flow runs on one screen.
  async function testWallet() {
    setError(null);
    try {
      setBusy("Signing in with the test wallet...");
      const s = await api<{ token: string }>("/v1/testmode/session", { body: {} });
      const p = await api<{ code: string }>("/v1/pocket/pair", { body: {}, token: s.token });
      await claim(p.code, faceId, async (a, key) => {
        if (!key || !config?.contracts.passkey) return;
        setBusy("Putting this phone's key on chain for every agent...");
        const me = await pocketApi<PocketMe>(a, "/v1/pocket/me");
        for (const acct of me.accounts) {
          const tx = await api<PreparedSafeTx>(`/v1/accounts/${acct.safe}/passkey/prepare`, { body: { x: key.x, y: key.y } });
          await api("/v1/testmode/safe-tx", { body: tx });
        }
      });
    } catch (err) {
      setError(faceIdError(err).replace("Nothing changed.", "The phone is not paired yet."));
      setBusy(null);
    }
  }

  return (
    <div className="pk-screen pk-screen--center">
      <Brand back />
      <div className="pk-hero">
        <p className="pk-eyebrow">Purser in your pocket</p>
        <h1 className="pk-h1">
          Pair this <em>phone.</em>
        </h1>
        <p className="pk-lead">
          On your computer, open <b>Alerts</b> in your dashboard at purseragents.fun, press <b>Pair a phone</b> and type the code here.
        </p>
      </div>
      <form className="pk-pair" onSubmit={submit}>
        <label className="pk-label" htmlFor="pk-code">
          Pairing code
        </label>
        <input
          id="pk-code"
          className="pk-code"
          value={code}
          onChange={(e) => setCode(formatCode(e.target.value))}
          placeholder="ABCD-EFGH"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          maxLength={9}
        />
        {passkeys ? (
          <label className="pk-check">
            <input type="checkbox" checked={faceId} onChange={(e) => setFaceId(e.target.checked)} />
            <span>
              <b>Approve payments with Face ID</b>
              <small>This phone makes its own key. Your computer puts it on chain with one confirmation per agent.</small>
            </span>
          </label>
        ) : null}
        <button type="submit" className="pk-btn pk-btn--primary" disabled={!!busy || code.replace("-", "").length !== 8}>
          {busy ?? "Pair"}
        </button>
        {testMode ? (
          <button type="button" className="pk-btn" disabled={!!busy} onClick={() => void testWallet()}>
            Use the test wallet
          </button>
        ) : null}
        {error ? (
          <p className="pk-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
      <p className="pk-fine">The phone can see your agents, approve with your passkey and freeze. It can never move money on its own, and only your wallet can unfreeze.</p>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ lock

function LockScreen({ auth, onUnlock, onUnpaired }: { auth: PocketAuth; onUnlock(): void; onUnpaired(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      const assertion = await faceIdFor(auth, "unlock");
      await pocketApi(auth, "/v1/pocket/unlock", { body: { assertion } });
      onUnlock();
    } catch (e) {
      if (e instanceof EngineError && e.status === 401 && e.code === "unauthorized") return onUnpaired();
      setError(e instanceof EngineError && e.code === "offline" ? "Unlocking needs a connection. Try again when you are online." : faceIdError(e).replace(" Nothing changed.", ""));
      setBusy(false);
    }
  }
  return (
    <div className="pk-screen pk-screen--center pk-screen--lock">
      <Brand />
      <div className="pk-lock">
        <span className="pk-lock-icon">
          <IconLock size={30} />
        </span>
        <h1 className="pk-h1 pk-h1--sm">Purser is locked</h1>
        <p className="pk-lead">Use Face ID to open it.</p>
        <button type="button" className="pk-btn pk-btn--primary pk-btn--block" disabled={busy} onClick={() => void unlock()}>
          <IconFingerprint size={18} />
          {busy ? "Checking..." : "Unlock with Face ID"}
        </button>
        {error ? (
          <p className="pk-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ home

type SheetState = null | { type: "settings" } | { type: "freeze" } | { type: "agent"; safe: string; name: string } | { type: "item"; id: string };

function Home({ auth, onUnpaired }: { auth: PocketAuth; onUnpaired(message: string | null): void }) {
  const gone = useCallback(() => onUnpaired(UNPAIRED), [onUnpaired]);
  const me = usePocketData<PocketMe>(auth, "/v1/pocket/me", ["account"], gone, "me");
  const feed = usePocketData<{ items: FeedItem[] }>(auth, "/v1/pocket/feed?limit=30", ["receipt", "intent", "watchdog"], gone, "feed");
  const today = usePocketData<{ statement: Statement }>(auth, "/v1/pocket/statement?day=today", ["receipt", "intent"], gone, "today");
  const approvals = usePocketData<Page<PendingApproval>>(auth, "/v1/approvals", ["approval", "intent"], gone);
  const held = usePocketData<Page<HeldPayment>>(auth, "/v1/pocket/held", ["intent"], gone);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Account>>({});
  const params = useSearchParams();
  const focus = params.get("approve") ?? params.get("held");

  const accounts = useMemo(() => me.data?.accounts ?? [], [me.data]);
  const mineSet = useMemo(() => new Set(accounts.map((a) => a.safe.toLowerCase())), [accounts]);
  const offline = me.offline || feed.offline || today.offline;
  const waiting = offline ? [] : (approvals.data?.items ?? []).filter((a) => a.status === "queued" && mineSet.has(a.safe.toLowerCase()));
  const holding = offline ? [] : (held.data?.items ?? []);
  const waitingKey = waiting.map((w) => w.safe).join(",");

  // The approver of each agent with a waiting payment: Face ID works where it is the passkey contract. Looked at
  // again every few seconds while a payment waits, so the buttons appear when the computer puts the key on chain.
  useEffect(() => {
    const safes = [...new Set(waitingKey.split(",").filter(Boolean))];
    if (!safes.length) return;
    let alive = true;
    const look = () =>
      Promise.all(safes.map((s) => api<Account>(`/v1/accounts/${s}`).then((a) => [s, a] as const).catch(() => null))).then((pairs) => {
        if (!alive) return;
        const next: Record<string, Account> = {};
        for (const p of pairs) if (p) next[p[0]] = p[1];
        setDetails((d) => ({ ...d, ...next }));
      });
    void look();
    const t = setInterval(look, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [waitingKey]);
  const [config, setConfig] = useState<EngineConfig | null>(null);
  useEffect(() => {
    api<EngineConfig>("/v1/config")
      .then(setConfig)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  // The number on the app icon, and the lock setting kept in step with the engine.
  const loaded = !!approvals.data && !!held.data;
  const count = waiting.length + holding.length;
  useEffect(() => {
    if (loaded && !offline) setIconBadge(count);
  }, [loaded, offline, count]);
  const lockPref = me.data?.device.prefs.lock;
  useEffect(() => {
    if (lockPref !== undefined && !me.offline) rememberLock(lockPref && !!auth.credentialId);
  }, [lockPref, me.offline, auth.credentialId]);

  const frozen = accounts.filter((a) => a.frozen).length;
  const reloadAll = () => {
    me.reload();
    feed.reload();
    today.reload();
    approvals.reload();
    held.reload();
  };
  const done = (m: string) => {
    setToast(m);
    reloadAll();
  };

  if (!me.data) {
    return (
      <div className="pk-screen">
        <Brand />
        {me.error ? <p className="pk-empty">{me.offline ? "Purser cannot be reached right now. It will fill in as soon as the connection is back." : me.error}</p> : <div className="pk-splash pk-splash--inline" aria-busy="true" />}
      </div>
    );
  }

  const s = today.data?.statement;
  const since = me.at ? new Date(me.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="pk-screen pk-screen--home">
      <Brand
        right={
          <span className="pk-top-right">
            <span className={"pk-status" + (frozen ? " pk-status--frozen" : "")}>
              <span className="pk-dot" />
              {accounts.length} {accounts.length === 1 ? "agent" : "agents"}
              {frozen ? ` · ${frozen} frozen` : " · active"}
            </span>
            <button type="button" className="pk-icon-btn" aria-label="Settings" onClick={() => setSheet({ type: "settings" })}>
              <IconSliders size={18} />
            </button>
          </span>
        }
      />

      {offline ? (
        <div className="pk-offline" role="status">
          <span className="pk-offline-dot" aria-hidden="true" />
          Offline, last update {since ?? "unknown"}
        </div>
      ) : (
        <PushBanner auth={auth} me={me.data} onChange={me.reload} />
      )}

      {waiting.length + holding.length > 0 ? (
        <section className="pk-section" aria-label="Waiting for you">
          {waiting.map((w) => (
            <ApprovalCard
              key={w.id}
              item={w}
              name={accounts.find((a) => sameAddress(a.safe, w.safe))?.name ?? "Agent"}
              account={details[w.safe]}
              passkeyContract={config?.contracts.passkey ?? null}
              credentialId={auth.credentialId}
              focused={focus === w.id}
              onDone={done}
            />
          ))}
          {holding.map((h) => (
            <HeldCard key={h.id} auth={auth} item={h} focused={focus === h.id} onDone={done} />
          ))}
        </section>
      ) : null}

      <section className="pk-today" aria-label="Today">
        <div>
          <span className="pk-k">Spent today</span>
          <span className="pk-v">{s ? dollars(s.spentUsd) : "..."}</span>
        </div>
        <div>
          <span className="pk-k">Earned</span>
          <span className="pk-v">{s ? dollars(s.earnedUsd) : "..."}</span>
        </div>
        <div>
          <span className="pk-k">Blocked</span>
          <span className="pk-v">{s ? s.blocked : "..."}</span>
        </div>
      </section>

      <section className="pk-section">
        <h2 className="pk-h2">Agents</h2>
        <div className="pk-list">
          {accounts.length === 0 ? <p className="pk-empty">No agents yet. Open an account on your computer and it shows here.</p> : null}
          {accounts.map((a) => (
            <AgentRow key={a.safe} auth={auth} account={a} canFreeze={!offline && !!me.data?.canFreeze[a.safe]} onOpen={() => setSheet({ type: "agent", safe: a.safe, name: a.name })} onDone={done} />
          ))}
        </div>
      </section>

      <section className="pk-section">
        <h2 className="pk-h2">
          Live
          {offline ? null : <span className="pk-live-dot" aria-hidden="true" />}
        </h2>
        <Feed items={feed.data?.items ?? null} onOpen={(id) => setSheet({ type: "item", id })} />
      </section>

      <Link href="/pocket/statement" className="pk-statement-link">
        <span>
          <b>Statements</b>
          <small>Every morning at 08:00, and the week on Monday: what each agent spent, earned and was stopped from doing.</small>
        </span>
        <IconArrowRight size={18} />
      </Link>

      <div className="pk-bottom">
        <button type="button" className="pk-btn pk-btn--freeze" disabled={offline || accounts.length === 0 || frozen === accounts.length} onClick={() => setSheet({ type: "freeze" })}>
          <IconSnow size={18} />
          {frozen === accounts.length && accounts.length > 0 ? "Every agent is frozen" : accounts.length === 1 ? "Freeze your agent" : "Freeze all agents"}
        </button>
      </div>

      {toast ? (
        <div className="pk-toast" role="status">
          {toast}
        </div>
      ) : null}

      {sheet?.type === "freeze" ? (
        <FreezeSheet
          auth={auth}
          me={me.data}
          onClose={() => setSheet(null)}
          onDone={(m) => {
            setSheet(null);
            done(m);
          }}
        />
      ) : null}
      {sheet?.type === "settings" ? <SettingsSheet auth={auth} me={me.data} onClose={() => setSheet(null)} onChange={me.reload} onUnpaired={() => onUnpaired(null)} /> : null}
      {sheet?.type === "agent" ? (
        <AgentSheet
          auth={auth}
          safe={sheet.safe}
          name={sheet.name}
          onGone={gone}
          onClose={() => setSheet(null)}
          onDone={(m) => {
            setSheet(null);
            done(m);
          }}
        />
      ) : null}
      {sheet?.type === "item" ? <ReceiptSheet auth={auth} id={sheet.id} testMode={!!config?.testMode} onGone={gone} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}

function PushBanner({ auth, me, onChange }: { auth: PocketAuth; me: PocketMe; onChange(): void }) {
  const [state, setState] = useState<"idle" | "busy" | "denied" | "error">("idle");
  const [env, setEnv] = useState<{ push: boolean; ios: boolean; standalone: boolean; permission: string } | null>(null);
  useEffect(() => {
    const e = { push: pushSupported(), ios: isIOS(), standalone: isStandalone(), permission: typeof Notification !== "undefined" ? Notification.permission : "default" };
    queueMicrotask(() => setEnv(e));
  }, []);
  if (!env || me.device.push) return null;
  if (env.ios && !env.standalone) {
    return (
      <div className="pk-banner">
        <IconBell size={18} />
        <span>Add Purser to your Home Screen to get notifications on your iPhone.</span>
      </div>
    );
  }
  if (!env.push) return null;
  return (
    <div className="pk-banner">
      <IconBell size={18} />
      <span>{state === "denied" || env.permission === "denied" ? "Notifications are blocked for Purser. Allow them in your phone's settings." : state === "error" ? "Notifications could not be turned on. Try again." : "Get a notification when a payment waits for you or an attack is blocked."}</span>
      {state === "denied" || env.permission === "denied" ? null : (
        <button
          type="button"
          className="pk-btn pk-btn--small pk-btn--primary"
          disabled={state === "busy"}
          onClick={async () => {
            setState("busy");
            try {
              const r = await turnOnPush(auth, me.vapidKey);
              setState(r === "on" ? "idle" : "denied");
              onChange();
            } catch {
              setState("error");
            }
          }}
        >
          {state === "busy" ? "..." : state === "error" ? "Retry" : "Turn on"}
        </button>
      )}
    </div>
  );
}

function ApprovalCard({
  item,
  name,
  account,
  passkeyContract,
  credentialId,
  focused,
  onDone,
}: {
  item: PendingApproval;
  name: string;
  account: Account | undefined;
  passkeyContract: string | null;
  credentialId: string | null;
  focused: boolean;
  onDone(message: string): void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  const faceId = !!credentialId && !!account && !!passkeyContract && !!account.approver && sameAddress(account.approver, passkeyContract) && passkeySupported();
  const loading = !account;

  async function decide(decision: "approve" | "reject") {
    setError(null);
    try {
      setBusy(decision === "approve" ? "Approving..." : "Rejecting...");
      const assertion = await signWithCredential(credentialId, decision === "approve" ? item.digest : item.rejectChallenge);
      setBusy("Checking on chain...");
      const r = await api<{ result: PayResult | null }>(`/v1/approvals/${item.id}/passkey`, { body: { decision, assertion } });
      onDone(decision === "approve" ? outcome("Approved", amountOf(item.money), r.result) : "Rejected. Nothing was paid.");
    } catch (e) {
      setError(faceIdError(e));
      setBusy(null);
    }
  }

  return (
    <div ref={ref} className={"pk-ask" + (focused ? " pk-ask--focus" : "")}>
      <div className="pk-ask-l">Waiting for you</div>
      <div className="pk-ask-t">{name} wants to pay</div>
      <div className="pk-ask-amt">{amountOf(item.money)}</div>
      <div className="pk-ask-why">
        {item.summary} · {ago(item.createdAt)}
      </div>
      {faceId ? (
        <div className="pk-ask-btns">
          <button type="button" className="pk-btn" disabled={!!busy} onClick={() => void decide("reject")}>
            Reject
          </button>
          <button type="button" className="pk-btn pk-btn--primary" disabled={!!busy} onClick={() => void decide("approve")}>
            <IconFingerprint size={17} />
            {busy ?? "Approve"}
          </button>
        </div>
      ) : loading ? null : (
        <p className="pk-ask-note">Face ID approvals are not on for {name} yet. Approve it on your computer, or turn on Face ID there under Purser on your phone.</p>
      )}
      {error ? <p className="pk-error">{error}</p> : null}
    </div>
  );
}

/** A payment Purser Shield holds: released or rejected with Face ID, checked by the engine. */
function HeldCard({ auth, item, focused, onDone }: { auth: PocketAuth; item: HeldPayment; focused: boolean; onDone(message: string): void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);

  async function decide(decision: "release" | "reject") {
    setError(null);
    try {
      setBusy(decision === "release" ? "Releasing..." : "Rejecting...");
      const assertion = await faceIdFor(auth, decision, item.id);
      setBusy("Checking...");
      const r = await pocketApi<{ result: PayResult | null }>(auth, `/v1/pocket/held/${item.id}`, { body: { decision, assertion } });
      onDone(decision === "release" ? outcome("Released", amountOf(item.money), r.result) : "Rejected. Nothing was paid.");
    } catch (e) {
      setError(faceIdError(e));
      setBusy(null);
    }
  }

  return (
    <div ref={ref} className={"pk-ask pk-ask--held" + (focused ? " pk-ask--focus" : "")}>
      <div className="pk-ask-l pk-ask-l--held">
        <IconShield size={13} />
        Held by Purser Shield
      </div>
      <div className="pk-ask-t">{item.name} wants to pay</div>
      <div className="pk-ask-amt">{amountOf(item.money)}</div>
      <div className="pk-ask-why">
        {item.to ? `To ${shortAddress(item.to)}, an address on the Purser Shield list.` : "The payee is on the Purser Shield list."} Nothing moved. · {ago(item.createdAt)}
      </div>
      {auth.credentialId ? (
        <div className="pk-ask-btns">
          <button type="button" className="pk-btn" disabled={!!busy} onClick={() => void decide("reject")}>
            Reject
          </button>
          <button type="button" className="pk-btn pk-btn--primary" disabled={!!busy} onClick={() => void decide("release")}>
            <IconFingerprint size={17} />
            {busy ?? "Release"}
          </button>
        </div>
      ) : (
        <p className="pk-ask-note">This phone has no Face ID key. Release or reject it on your computer.</p>
      )}
      {error ? <p className="pk-error">{error}</p> : null}
    </div>
  );
}

function AgentRow({ auth, account, canFreeze, onOpen, onDone }: { auth: PocketAuth; account: PocketMe["accounts"][number]; canFreeze: boolean; onOpen(): void; onDone(m: string): void }) {
  const [busy, setBusy] = useState(false);
  async function freeze() {
    setBusy(true);
    try {
      const r = await pocketApi<{ results: { frozen: boolean; message: string; name: string }[] }>(auth, "/v1/pocket/freeze", { body: { safes: [account.safe] } });
      const x = r.results[0];
      onDone(x.frozen ? `${x.name} is frozen. No payment can leave.` : x.message);
    } catch (e) {
      onDone(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={"pk-agent" + (account.frozen ? " pk-agent--frozen" : "")}>
      <button type="button" className="pk-agent-open" onClick={onOpen} aria-label={`Open ${account.name}`}>
        <span className="pk-avatar" aria-hidden="true">
          {initials(account.name)}
        </span>
        <span className="pk-agent-main">
          <span className="pk-agent-name">{account.name}</span>
          <span className="pk-agent-sub">{account.frozen ? "Only your wallet unfreezes it" : `${dollars(account.spentTodayUsd)} spent today`}</span>
        </span>
      </button>
      {account.frozen ? (
        <span className="pk-pill">
          <IconSnow size={12} />
          Frozen
        </span>
      ) : canFreeze ? (
        <button type="button" className="pk-btn pk-btn--small" disabled={busy} onClick={() => void freeze()} aria-label={`Freeze ${account.name}`}>
          <IconSnow size={14} />
          {busy ? "..." : "Freeze"}
        </button>
      ) : (
        <span className="pk-pill pk-pill--ok">
          <span className="pk-dot" />
          Active
        </span>
      )}
    </div>
  );
}

function Feed({ items, onOpen }: { items: FeedItem[] | null; onOpen(id: string): void }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 20_000);
    return () => clearInterval(t);
  }, []);
  // Rows that arrived after the first load slide in.
  const [, setSeen] = useState<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!items) return;
    queueMicrotask(() => {
      setSeen((prev) => {
        if (prev) {
          const added = items.filter((i) => !prev.has(i.id)).map((i) => i.id);
          if (added.length) setFresh(new Set(added));
        }
        return new Set(items.map((i) => i.id));
      });
    });
  }, [items]);
  if (!items) return <div className="pk-splash pk-splash--inline" aria-busy="true" />;
  if (!items.length) return <p className="pk-empty">Every payment, every earning and every blocked attempt shows here the moment it happens.</p>;
  return (
    <div className="pk-feed">
      {items.map((i) => (
        <button type="button" key={i.id} className={"pk-row" + (fresh.has(i.id) ? " pk-row--new" : "")} onClick={() => onOpen(i.id)}>
          <FeedIcon kind={i.kind} />
          <span className="pk-row-main">
            <span className="pk-row-name">{i.name}</span>
            <span className="pk-row-sub">
              {i.kind === "blocked" || i.kind === "held" || i.kind === "watchdog" ? i.text : i.text || (i.category ? ((categoryLabel as Record<string, string>)[i.category] ?? i.category) : i.kind === "earned" ? "Earned" : "Payment")} · {ago(i.createdAt, now)}
            </span>
          </span>
          {i.kind === "blocked" ? (
            <span className="pk-tag">Blocked</span>
          ) : i.kind === "held" ? (
            <span className="pk-tag pk-tag--wait">Held</span>
          ) : i.kind === "watchdog" ? (
            <span className="pk-tag">Watchdog</span>
          ) : (
            <b className={"pk-amt" + (i.kind === "earned" ? " pk-amt--in" : "")}>
              {i.kind === "earned" ? "+" : ""}
              {i.usd ? dollars(i.usd) : i.display}
            </b>
          )}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ statement

function StatementView({ auth, onUnpaired }: { auth: PocketAuth; onUnpaired(): void }) {
  const params = useSearchParams();
  const asked = params.get("day");
  const days = usePocketData<{ days: string[]; weeks: string[] }>(auth, "/v1/pocket/statements", [], onUnpaired);
  const [day, setDay] = useState<string>(asked ?? "today");
  const st = usePocketData<{ statement: Statement; sentence: string; today: boolean; week?: boolean }>(auth, `/v1/pocket/statement?day=${encodeURIComponent(day)}`, day === "today" ? ["receipt", "intent"] : [], onUnpaired);
  const options = ["today", "yesterday", "week", ...(days.data?.weeks ?? []), ...(days.data?.days ?? [])];
  if (asked && !options.includes(asked)) options.splice(3, 0, asked);
  const s = st.data?.statement;
  const dayName = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const label = (d: string) => (d === "today" ? "Today so far" : d === "yesterday" ? "Yesterday" : d === "week" ? "Last 7 days" : d.startsWith("week-") ? `Week to ${dayName(d.slice(5)).replace(/^\w+ /, "")}` : dayName(d));
  const isWeek = day === "week" || day.startsWith("week-");
  return (
    <div className="pk-screen">
      <Brand
        right={
          <Link href="/pocket" className="pk-btn pk-btn--small">
            Done
          </Link>
        }
      />
      <div className="pk-hero pk-hero--left">
        <p className="pk-eyebrow">{isWeek ? "Weekly report" : "Daily statement"}</p>
        <h1 className="pk-h1 pk-h1--sm">{label(st.data?.today ? "today" : day === "yesterday" || isWeek ? day : (s?.day ?? day))}</h1>
        {st.data ? <p className="pk-lead">{st.data.sentence}</p> : null}
      </div>
      <div className="pk-chips" role="tablist">
        {[...new Set(options)].slice(0, 10).map((d) => (
          <button key={d} type="button" role="tab" aria-selected={day === d} className={"pk-chip" + (day === d ? " pk-chip--on" : "")} onClick={() => setDay(d)}>
            {label(d)}
          </button>
        ))}
      </div>
      {s ? (
        <>
          <section className="pk-today">
            <div>
              <span className="pk-k">Spent</span>
              <span className="pk-v">{dollars(s.spentUsd)}</span>
            </div>
            <div>
              <span className="pk-k">Earned</span>
              <span className="pk-v">{dollars(s.earnedUsd)}</span>
            </div>
            <div>
              <span className="pk-k">Blocked</span>
              <span className="pk-v">{s.blocked}</span>
            </div>
          </section>
          {isWeek && s.busiest ? (
            <div className="pk-banner">
              <span className="pk-avatar" aria-hidden="true">
                {initials(s.busiest.name)}
              </span>
              <span>
                <b>{s.busiest.name}</b> was the busiest: {s.busiest.payments} {s.busiest.payments === 1 ? "payment" : "payments"}, {dollars(s.busiest.spentUsd)} spent.
              </span>
            </div>
          ) : null}
          <section className="pk-section">
            <h2 className="pk-h2">Per agent</h2>
            <div className="pk-list">
              {s.agents.length === 0 ? <p className="pk-empty">No agents yet.</p> : null}
              {s.agents.map((a) => (
                <div key={a.safe} className="pk-agent">
                  <span className="pk-avatar" aria-hidden="true">
                    {initials(a.name)}
                  </span>
                  <span className="pk-agent-main">
                    <span className="pk-agent-name">{a.name}</span>
                    <span className="pk-agent-sub">
                      {a.payments} {a.payments === 1 ? "payment" : "payments"}
                      {a.blocked ? ` · ${a.blocked} blocked` : ""}
                    </span>
                  </span>
                  <span className="pk-st-nums">
                    <b>{dollars(a.spentUsd)}</b>
                    <small className="pk-amt--in">+{dollars(a.earnedUsd)}</small>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : st.error ? (
        <p className="pk-empty">{st.offline ? "Statements need a connection. They load as soon as Purser can be reached." : st.error}</p>
      ) : (
        <div className="pk-splash pk-splash--inline" aria-busy="true" />
      )}
      <p className="pk-fine">
        <IconCheck size={13} /> Counted from your agents&apos; receipts.
      </p>
    </div>
  );
}
