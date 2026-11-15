"use client";

import { useCallback, useEffect, useState } from "react";
import { EngineError, api } from "@/lib/client";
import { formatDate } from "@/lib/format";
import { cachedSession, withOwner } from "@/lib/owner";
import { ago, type PocketDevice } from "@/lib/pocket";
import type { PreparedSafeTx } from "@/lib/types";
import { IconBell, IconCheck, IconFingerprint, IconTrash } from "../Icons";
import { useNow } from "../Live";
import { Card } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { useOwner } from "./Frame";

/** A pairing code lives ten minutes. Counted from when this computer got it, so a clock that is off cannot skew it. */
const CODE_TTL = 600;

interface PairState {
  code: string;
  /** when the code runs out, on this computer's clock (seconds) */
  until: number;
  device: PocketDevice | null;
  passkey: { x: string; y: string } | null;
}

const IconPhone = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.6" />
    <path d="M10.5 18.5h3" />
  </svg>
);

/**
 * Purser on your phone, the computer side: make a pairing code, see the phone arrive, put its Face ID key on chain
 * for every agent, and the list of paired phones. The wallet is asked to sign only when a button is pressed.
 */
export function PhoneCard() {
  const owner = useOwner();
  const now = useNow(1000);
  const action = useAction();
  const resetStatus = action.reset;
  const [token, setToken] = useState<string | null>(() => cachedSession(owner.address));
  const [devices, setDevices] = useState<PocketDevice[] | null>(null);
  const [pair, setPair] = useState<PairState | null>(null);
  const [faceId, setFaceId] = useState<{ done: number; total: number; finished: boolean } | null>(null);

  const load = useCallback(async (tk: string) => setDevices((await api<{ items: PocketDevice[] }>("/v1/pocket/devices", { token: tk })).items), []);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    api<{ items: PocketDevice[] }>("/v1/pocket/devices", { token })
      .then((p) => alive && setDevices(p.items))
      .catch((e) => alive && e instanceof EngineError && e.status === 401 && setToken(null));
    return () => {
      alive = false;
    };
  }, [token]);

  // While a code waits: ask the engine every two seconds whether a phone used it.
  const waitingCode = pair && !pair.device ? pair.code : null;
  useEffect(() => {
    if (!waitingCode || !token) return;
    let alive = true;
    const t = setInterval(() => {
      api<{ claimed: boolean; device: PocketDevice | null; passkey: { x: string; y: string } | null }>(`/v1/pocket/pair/${waitingCode}`, { token })
        .then((r) => {
          if (!alive || !r.claimed) return;
          setPair((p) => (p && p.code === waitingCode ? { ...p, device: r.device, passkey: r.passkey } : p));
          resetStatus();
          void load(token).catch(() => undefined);
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [waitingCode, token, load, resetStatus]);

  const start = () =>
    action.run(async () => {
      const r = await withOwner(owner.signer, (tk) => api<{ code: string; expires: number }>("/v1/pocket/pair", { token: tk, body: {} }));
      const tk = await owner.signer.session();
      setToken(tk);
      setFaceId(null);
      setPair({ code: r.code, until: Math.floor(Date.now() / 1000) + CODE_TTL, device: null, passkey: null });
      await load(tk).catch(() => undefined);
      return "The code is ready.";
    }, "Sign in with your wallet...");

  const signIn = () =>
    action.run(async () => {
      setToken(await owner.signer.session());
      return "Signed in.";
    }, "Sign in with your wallet...");

  const turnOnFaceId = () =>
    action.run(async (step) => {
      if (!pair?.passkey) return;
      const total = owner.accounts.length;
      const from = faceId && !faceId.finished ? faceId.done : 0;
      setFaceId({ done: from, total, finished: false });
      for (let i = from; i < total; i++) {
        const a = owner.accounts[i];
        step(`${a.name} (${i + 1} of ${total}): confirm in your wallet...`);
        const tx = await api<PreparedSafeTx>(`/v1/accounts/${a.safe}/passkey/prepare`, { body: { x: pair.passkey.x, y: pair.passkey.y } });
        await owner.signer.execSafeTx(tx);
        setFaceId({ done: i + 1, total, finished: false });
      }
      setFaceId({ done: total, total, finished: true });
      return `Face ID approvals are on for ${total === 1 ? "your agent" : `all ${total} agents`}.`;
    }, "Starting...");

  const unpair = (d: PocketDevice) =>
    action.run(async () => {
      await withOwner(owner.signer, (tk) => api(`/v1/pocket/devices/${d.id}`, { method: "DELETE", token: tk }));
      const tk = await owner.signer.session();
      setToken(tk);
      await load(tk);
      if (pair?.device?.id === d.id) setPair(null);
      return `${d.name} is unpaired. It can no longer see your agents.`;
    }, "Sign in with your wallet...");

  const left = pair ? Math.min(CODE_TTL, Math.max(0, pair.until - now)) : 0;
  const expired = !!pair && !pair.device && left === 0;
  const n = owner.accounts.length;

  return (
    <Card title="Purser on your phone" action={<IconPhone size={16} />} id="phone">
      <div className="phone-card">
        <div className="phone-card__pair">
          {!pair || expired ? (
            <>
              <p className="small muted">
                Approve with Face ID, watch every payment as it happens and freeze any agent with one tap. The phone can never move money on its own, and only your wallet unfreezes.
              </p>
              {expired ? <p className="small">That code ran out. Make a new one.</p> : null}
              <div className="row">
                <button type="button" className="btn btn--primary" disabled={action.busy} onClick={() => void start()}>
                  <IconPhone size={15} />
                  Pair a phone
                </button>
              </div>
            </>
          ) : !pair.device ? (
            <>
              <span className="field__label">Pairing code</span>
              <div className="phone-code" aria-live="polite">
                {pair.code}
              </div>
              <p className="small">
                On your phone, open <b>purseragents.fun/pocket</b> and type this code.
              </p>
              <p className="small muted phone-card__wait">
                <span className="spinner" aria-hidden="true" />
                Waiting for your phone. The code works once and runs out in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.
              </p>
              <div className="row">
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPair(null)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="phone-paired">
                <span className="rowi__icon rowi__icon--ok">
                  <IconCheck size={14} />
                </span>
                <div>
                  <b>{pair.device.name} is paired.</b>
                  <span className="small muted">It shows your agents now. Turn on notifications on the phone to hear about payments that wait for you.</span>
                </div>
              </div>
              {pair.passkey && n > 0 ? (
                faceId?.finished ? (
                  <p className="small">
                    Face ID approvals are on for {n === 1 ? "your agent" : `all ${n} agents`}. A payment above your approval amount can now be approved or rejected on the phone.
                  </p>
                ) : (
                  <>
                    <p className="small muted">
                      The phone made its own Face ID key. Put it on chain so the phone can approve or reject payments above your approval amount: one confirmation per agent. Each agent keeps one Face ID key, so this replaces an earlier one.
                    </p>
                    {faceId ? (
                      <ul className="phone-steps">
                        {owner.accounts.map((a, i) => (
                          <li key={a.safe} className={i < faceId.done ? "is-done" : i === faceId.done ? "is-now" : ""}>
                            {i < faceId.done ? <IconCheck size={13} /> : <span className="phone-steps__dot" />}
                            {a.name}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="row">
                      <button type="button" className="btn btn--primary" disabled={action.busy} onClick={() => void turnOnFaceId()}>
                        <IconFingerprint size={15} />
                        {faceId && faceId.done > 0 ? "Continue" : `Turn on Face ID approvals for ${n === 1 ? "1 agent" : `${n} agents`}`}
                      </button>
                      <button type="button" className="btn btn--ghost" disabled={action.busy} onClick={() => setPair(null)}>
                        Not now
                      </button>
                    </div>
                  </>
                )
              ) : (
                <p className="small muted">This phone was paired without a Face ID key. It can watch and freeze; approvals stay with your wallet.</p>
              )}
              {faceId?.finished || !pair.passkey ? (
                <div className="row">
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => setPair(null)}>
                    Done
                  </button>
                </div>
              ) : null}
            </>
          )}
          <ActionStatus state={action.state} />
        </div>

        <div className="phone-card__list">
          <span className="field__label">Paired phones</span>
          {!token ? (
            <div className="phone-empty">
              <p className="small muted">The list belongs to your wallet. Signing a message proves it is yours; it costs nothing.</p>
              <button type="button" className="btn btn--secondary btn--sm" disabled={action.busy} onClick={() => void signIn()}>
                Sign in with your wallet
              </button>
            </div>
          ) : !devices ? (
            <div className="empty empty--sm" aria-busy="true" />
          ) : devices.length === 0 ? (
            <div className="phone-empty">
              <p className="small muted">No phone is paired yet. Press Pair a phone and open purseragents.fun/pocket on your phone.</p>
            </div>
          ) : (
            <div className="rows card" style={{ padding: 0 }}>
              {devices.map((d) => (
                <div className="rowi" key={d.id}>
                  <span className="rowi__icon rowi__icon--ok">
                    <IconPhone size={14} />
                  </span>
                  <div className="rowi__main">
                    <span className="rowi__title">{d.name}</span>
                    <span className="rowi__meta">
                      Paired {formatDate(d.createdAt)}, last seen {ago(d.lastSeen, now)}
                    </span>
                  </div>
                  <div className="row" style={{ flexWrap: "nowrap" }}>
                    <span className={"badge " + (d.push ? "badge--ok" : "")}>
                      <IconBell size={12} />
                      {d.push ? "Notifications on" : "Notifications off"}
                    </span>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={action.busy} onClick={() => void unpair(d)} aria-label={`Unpair ${d.name}`}>
                      <IconTrash size={14} />
                      Unpair
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
