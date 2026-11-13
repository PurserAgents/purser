"use client";

import { useEffect, useState } from "react";

const EXPLORER = "https://robinhoodchain.blockscout.com";

type Burn = { n: number; at: number; tokens: number; eth: number; tx: string; kind: "pot" | "dev" };

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

function when(at: number): string {
  const d = new Date(at * 1000);
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function BurnList() {
  const [list, setList] = useState<Burn[] | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/burns", { cache: "no-store" });
        const j = await r.json();
        if (alive) setList(j.burns as Burn[]);
      } catch {
        /* keep the last list */
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const shown = list ? (all ? list : list.slice(0, 10)) : [];

  return (
    <section style={{ marginBottom: "var(--section-y)" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <h2 className="h3" style={{ margin: 0 }}>Every burn</h2>
        <span className="small muted">Each one links to its transaction</span>
      </div>
      <div className="cell" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                {["Burn", "When", "$PURSER burned", "Bought with", "Transaction"].map((h) => (
                  <th key={h} style={{ padding: "14px 18px", fontWeight: 500, fontSize: 12, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--text-muted, #71717a)", whiteSpace: "nowrap", borderBottom: "1px solid var(--line)", fontFamily: "var(--font-mono, monospace)" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list === null && (
                <tr>
                  <td colSpan={5} className="muted" style={{ padding: "18px" }}>
                    Reading the chain
                  </td>
                </tr>
              )}
              {shown.map((b) => (
                <tr key={b.tx} style={{ borderBottom: "1px solid var(--line)" }}>
                  <td style={{ padding: "14px 18px", whiteSpace: "nowrap" }}>{b.kind === "dev" ? "Dev wallet" : `#${b.n}`}</td>
                  <td style={{ padding: "14px 18px", whiteSpace: "nowrap" }} className="muted">
                    {when(b.at)}
                  </td>
                  <td style={{ padding: "14px 18px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{fmt(b.tokens)}</td>
                  <td style={{ padding: "14px 18px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }} className="muted">
                    {b.kind === "dev" ? "Sent to the dead address" : `${fmt(b.eth, 4)} ETH`}
                  </td>
                  <td style={{ padding: "14px 18px", whiteSpace: "nowrap" }}>
                    <a className="link" href={`${EXPLORER}/tx/${b.tx}`} target="_blank" rel="noreferrer" style={{ fontFamily: "var(--font-mono, monospace)" }}>
                      {b.tx.slice(0, 10)}...{b.tx.slice(-6)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {list && list.length > 10 && (
        <div className="row" style={{ justifyContent: "center", marginTop: 14 }}>
          <button type="button" className="btn btn--secondary" onClick={() => setAll((v) => !v)}>
            {all ? "Show the latest 10" : `Show all ${list.length}`}
          </button>
        </div>
      )}
    </section>
  );
}
