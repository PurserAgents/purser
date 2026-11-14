"use client";

import { useEffect, useState } from "react";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const EXPLORER = "https://robinhoodchain.blockscout.com";

type State = {
  burns: number;
  tokens: number;
  eth: number;
  lastAt: number;
  nextAt: number;
  ready: boolean;
  supply: number;
  waitingEth: number;
  heldTokens: number;
  dead: number;
};

async function call(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const j = await r.json();
  if (!j.result) throw new Error("no result");
  return j.result as string;
}

const word = (hex: string, i: number): bigint => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
const units = (v: bigint): number => Number(v / 10n ** 12n) / 1e6;

function fmt(n: number, digits = 0): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** The pot's MIN_BURN: below it, a burn waits for more fees (at most a day). */
const MIN_BURN_ETH = 0.001;

function countdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function BurnStatus({ pot, token }: { pot: string; token: string }) {
  const [st, setSt] = useState<State | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [burns, tokens, eth, lastAt, preview, supply, dead] = await Promise.all([
          call(pot, "0x524773ce"),
          call(pot, "0xd157e301"),
          call(pot, "0x97e32c7a"),
          call(pot, "0xb88685fc"),
          call(pot, "0xefae2305"),
          call(token, "0x18160ddd"),
          call(token, "0x70a08231000000000000000000000000000000000000000000000000000000000000dead"),
        ]);
        if (!alive) return;
        setSt({
          burns: Number(word(burns, 0)),
          tokens: units(word(tokens, 0)),
          eth: units(word(eth, 0)),
          lastAt: Number(word(lastAt, 0)),
          waitingEth: units(word(preview, 0)),
          nextAt: Number(word(preview, 1)),
          ready: word(preview, 2) === 1n,
          heldTokens: units(word(preview, 3)),
          supply: units(word(supply, 0)),
          dead: units(word(dead, 0)),
        });
        setErr(false);
      } catch {
        if (alive) setErr(true);
      }
    };
    void load();
    const poll = setInterval(load, 20_000);
    const tick = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [pot, token]);

  const left = st && st.nextAt > 0 ? st.nextAt - now : null;
  // a small amount waits until fees reach MIN_BURN, or a day at most: say that, not a day-long countdown
  const filling = !!st && !st.ready && st.heldTokens === 0 && st.waitingEth > 0 && st.waitingEth < MIN_BURN_ETH && left !== null && left > 30 * 60;
  let next = "Reading the chain";
  let note = "At most every 30 minutes";
  if (st) {
    if (st.ready || (left !== null && left <= 0)) next = "Any minute now";
    else if (filling) next = `Once ${fmt(MIN_BURN_ETH, 3)} ETH is in`;
    else if (left !== null) next = `in ${countdown(left)}`;
    else next = "When fees arrive";
    if (filling) note = `${fmt(st.waitingEth, 4)} ETH from fees so far. It burns as soon as it gets there, and within a day at the latest`;
    else if (st.waitingEth > 0) note = `At most every 30 minutes, about ${fmt(st.waitingEth, 4)} ETH ready`;
  }
  const burnedAll = st ? st.tokens + st.dead : 0;
  const burnedPct = (burnedAll / 1_000_000_000) * 100;

  return (
    <section style={{ marginBottom: "var(--section-y)" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <h2 className="h3" style={{ margin: 0 }}>Burn status</h2>
        <span className="small muted">
          Live from the chain{err ? ", retrying" : ""}
        </span>
      </div>
      <div className="cells cells--4">
        <div className="cell">
          <span className="eyebrow">Next burn</span>
          <p className="h3" style={{ margin: "8px 0 0" }}>{next}</p>
          <p className="small muted" style={{ marginTop: 6 }}>
            {note}
          </p>
        </div>
        <div className="cell">
          <span className="eyebrow">Burned so far</span>
          <p className="h3" style={{ margin: "8px 0 0" }}>{st ? fmt(burnedAll) : "..."}</p>
          <p className="small muted" style={{ marginTop: 6 }}>
            {st ? `${fmt(burnedPct, 2)}% of all $PURSER: ${fmt(st.dead)} from the dev wallet, ${fmt(st.tokens)} by the burn pot` : " "}
          </p>
        </div>
        <div className="cell">
          <span className="eyebrow">Burns</span>
          <p className="h3" style={{ margin: "8px 0 0" }}>{st ? fmt(st.burns) : "..."}</p>
          <p className="small muted" style={{ marginTop: 6 }}>
            {st && st.lastAt > 0 ? `Last one ${new Date(st.lastAt * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : "The first one is coming"}
          </p>
        </div>
        <div className="cell">
          <span className="eyebrow">Bought back with</span>
          <p className="h3" style={{ margin: "8px 0 0" }}>{st ? `${fmt(st.eth, 4)} ETH` : "..."}</p>
          <p className="small muted" style={{ marginTop: 6 }}>
            Supply left {st ? fmt(st.supply - st.dead) : "..."}.{" "}
            <a className="link" href={`${EXPLORER}/address/${pot}`} target="_blank" rel="noreferrer">
              Every burn on chain
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
