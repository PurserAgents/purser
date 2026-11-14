"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { formatTime } from "@/lib/format";
import type { ShieldThreat } from "@/lib/types";
import { IconSearch, IconShield, IconShieldX } from "./Icons";

type Answer = { address: string; flagged: boolean; threat: ShieldThreat | null };

/** Checks one address against the Purser Shield list. */
export function ShieldLookup() {
  const [value, setValue] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(value.trim());
  const check = async () => {
    if (!valid) return setError("Paste a full 0x address.");
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api<Answer>(`/v1/shield/address/${value.trim()}`));
    } catch (e) {
      setAnswer(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shield-lookup">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <label className="sr-only" htmlFor="shield-address">
          Address to check
        </label>
        <input id="shield-address" className="input mono" placeholder="0x... an address your agent is about to pay" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoComplete="off" />
        <button type="submit" className="btn btn--primary" disabled={busy}>
          <IconSearch size={15} />
          Check
        </button>
      </form>
      {error ? <p className="small" style={{ color: "var(--stop)" }}>{error}</p> : null}
      {answer ? (
        answer.flagged && answer.threat ? (
          <div className="shield-answer shield-answer--stop">
            <IconShieldX size={18} />
            <div>
              <strong>On the list.</strong> Flagged as {answer.threat.what}, caught in {answer.threat.attacks === 1 ? "one attack" : `${answer.threat.attacks} attacks`} aimed at {answer.threat.accounts === 1 ? "one account" : `${answer.threat.accounts} accounts`}. Last seen {formatTime(answer.threat.lastSeen)} UTC. Every Purser account refuses to pay it.
            </div>
          </div>
        ) : (
          <div className="shield-answer">
            <IconShield size={18} />
            <div>
              <strong>Not on the list.</strong> No Purser account has caught this address in an attack. The firewall still checks every payment to it.
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}
