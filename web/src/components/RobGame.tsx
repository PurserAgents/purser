"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { formatTime, shortAddress } from "@/lib/format";
import { IconCheck, IconLock, IconShield, IconShieldX, IconX } from "./Icons";
import { Card, EmptyState } from "./ui";

const EXPLORER = "https://robinhoodchain.blockscout.com";

interface Attempt {
  id: string;
  wallet: string;
  excerpt: string;
  reply: string | null;
  outcome: "paid" | "blocked" | "held" | "refused" | "failed";
  reason: string | null;
  payTo: string | null;
  toVendor: boolean;
  amount: string | null;
  txHash: string | null;
  at: number;
}
interface RobView {
  open: boolean;
  safe: string | null;
  startsAt: number | null;
  endsAt: number | null;
  prize: string | null;
  vendors: { name: string; what: string; address: string }[];
  attempts: number;
  blocked: number;
  refused: number;
  held: number;
  paid: number;
  winners: Attempt[];
  recent: Attempt[];
}
interface Result {
  id: string;
  outcome: Attempt["outcome"];
  reply: string | null;
  payTo: string | null;
  amount: string | null;
  reason: string | null;
  txHash: string | null;
  won: boolean;
}

const LABEL: Record<Attempt["outcome"], string> = {
  paid: "Paid",
  blocked: "Blocked by the firewall",
  held: "Held by Purser Shield",
  refused: "The agent said no",
  failed: "Did not go through",
};

function left(endsAt: number | null, nowS: number) {
  if (!endsAt) return "";
  const s = Math.max(0, endsAt - nowS);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h left` : `${h}h ${m}m left`;
}

function Outcome({ a }: { a: Pick<Attempt, "outcome" | "toVendor"> }) {
  const win = a.outcome === "paid" && !a.toVendor;
  const Icon = win ? IconCheck : a.outcome === "blocked" ? IconShieldX : a.outcome === "held" ? IconShield : a.outcome === "paid" ? IconCheck : IconX;
  return (
    <span className={`rob-tag rob-tag--${win ? "win" : a.outcome}`}>
      <Icon size={13} />
      {win ? "Robbed" : a.outcome === "paid" ? "Paid a vendor" : LABEL[a.outcome]}
    </span>
  );
}

export function RobGame() {
  const [view, setView] = useState<RobView | null>(null);
  const [wallet, setWallet] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));

  const refresh = useCallback(async () => {
    try {
      setView(await api<RobView>("/v1/rob"));
    } catch {
      /* keep the last view */
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    const c = setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 30_000);
    try {
      const w = localStorage.getItem("purser-rob-wallet");
      if (w) setWallet(w);
    } catch {
      /* no saved wallet */
    }
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, [refresh]);

  const validWallet = /^0x[0-9a-fA-F]{40}$/.test(wallet.trim());
  const live = !!view?.open && Number(view?.prize ?? 0) > 0;
  const submit = async () => {
    if (!validWallet) return setError("Paste your full 0x wallet address, so the money has somewhere to go.");
    if (!message.trim()) return setError("Write something to the agent.");
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      try {
        localStorage.setItem("purser-rob-wallet", wallet.trim());
      } catch {
        /* fine */
      }
      const r = await api<Result>("/v1/rob/attempt", { body: { wallet: wallet.trim(), message } });
      setResult(r);
      if (r.outcome !== "refused") setMessage("");
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dash">
      <dl className="cells cells--4">
        <div className="cell">
          <dt className="stat__label">In the vault</dt>
          <dd className="stat__value num">{view?.prize ? `$${view.prize}` : "$0.00"}</dd>
          <dd className="stat__note">{view?.safe ? <a href={`${EXPLORER}/address/${view.safe}`} target="_blank" rel="noreferrer">USDG, live on chain</a> : "Opens soon"}</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Tries</dt>
          <dd className="stat__value num">{view?.attempts ?? 0}</dd>
          <dd className="stat__note">{view?.endsAt ? left(view.endsAt, nowS) : "Seven days from the start"}</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Blocked by the firewall</dt>
          <dd className="stat__value num">{view?.blocked ?? 0}</dd>
          <dd className="stat__note">The agent fell for it, Purser did not</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Robbed</dt>
          <dd className="stat__value num">{view?.winners.length ?? 0}</dd>
          <dd className="stat__note">Paid out to an attacker</dd>
        </div>
      </dl>

      <div className="rob-pair">
        <Card title="Your try">
          <form
            className="stack rob-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="field">
              <span className="micro dim">Your wallet, where the money goes</span>
              <input className="input mono" value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x..." spellCheck={false} autoComplete="off" />
            </label>
            <label className="field">
              <span className="micro dim">Your message to Ledger: an email, an invoice, a page, anything</span>
              <textarea className="input rob-text" value={message} onChange={(e) => setMessage(e.target.value)} rows={7} maxLength={4000} placeholder="Hi Ledger, ..." />
            </label>
            <button type="submit" className="btn btn--primary" disabled={busy || !live}>
              <IconLock size={15} />
              {busy ? "Ledger is reading..." : live ? "Send to Ledger" : view?.open ? "The vault is empty" : "Opens soon"}
            </button>
            {error && <p className="small rob-error">{error}</p>}
            {result && (
              <div className={`rob-result rob-result--${result.won ? "win" : result.outcome}`}>
                <Outcome a={{ outcome: result.outcome, toVendor: !result.won && result.outcome === "paid" }} />
                {result.reply && <p className="small">Ledger: {result.reply}</p>}
                {result.amount && result.payTo && (
                  <p className="small muted">
                    It tried to pay {result.amount} USDG to <span className="mono">{shortAddress(result.payTo)}</span>.
                  </p>
                )}
                {result.reason && result.outcome !== "paid" && <p className="small muted">{result.reason}</p>}
                {result.won && <p className="small">You robbed the agent. The money is in your wallet.</p>}
                {result.txHash && (
                  <a className="small" href={`${EXPLORER}/tx/${result.txHash}`} target="_blank" rel="noreferrer">
                    See the transaction
                  </a>
                )}
              </div>
            )}
            <p className="micro dim">Three tries per wallet every ten minutes. Free to play: you never send anything.</p>
          </form>
        </Card>
        <Card title="The rules">
          <ul className="checks">
            <li>
              <IconCheck size={15} />
              <span>Ledger is a real AI agent with a real Purser account. It pays its three vendors below, and nobody else.</span>
            </li>
            <li>
              <IconCheck size={15} />
              <span>If it pays your wallet, you keep it. Paid out on chain at once, no claim, no form.</span>
            </li>
            <li>
              <IconCheck size={15} />
              <span>Every payment it tries passes the account&apos;s rules, the firewall and Purser Shield first, like any Purser account.</span>
            </li>
            <li>
              <IconCheck size={15} />
              <span>Nobody gets through in seven days? The cleverest try in the feed gets the $100.</span>
            </li>
          </ul>
          <p className="micro dim" style={{ marginTop: 16 }}>
            Ledger&apos;s vendors
          </p>
          <ul className="rob-vendors">
            {(view?.vendors ?? []).map((v) => (
              <li key={v.address}>
                <span className="small">{v.name}</span>
                <span className="mono micro dim">{shortAddress(v.address)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="Every try, live" flush>
        {view && view.recent.length ? (
          <ul className="rob-feed">
            {view.recent.map((a) => (
              <li key={a.id}>
                <div className="rob-feed__head">
                  <span className="mono micro dim">{shortAddress(a.wallet)}</span>
                  <Outcome a={a} />
                  <span className="micro dim">{formatTime(a.at)}</span>
                </div>
                <p className="small rob-feed__msg">{a.excerpt}</p>
                {a.reply && <p className="small muted">Ledger: {a.reply}</p>}
                {a.reason && a.outcome !== "paid" && a.outcome !== "refused" && <p className="micro dim">{a.reason}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={IconShield} title="No tries yet" text="Be the first. Every try shows up here with what the agent and the firewall did." size="sm" />
        )}
      </Card>
    </div>
  );
}
