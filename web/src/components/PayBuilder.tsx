"use client";

import { useEffect, useRef, useState } from "react";
import { CodeTabs } from "./CodeTabs";
import { IconCursor } from "./Icons";
import { EmptyState } from "./ui";

declare global {
  interface Window {
    PurserPay?: { mount(node: Element, after?: boolean): void; scan(): void };
  }
}

/** Builds the pay button's script tag for one agent and shows the real button, served by the engine. */
export function PayBuilder({ engine, agents, initialAgent }: { engine: string | null; agents: { safe: string; name: string }[]; initialAgent: string | null }) {
  const [agent, setAgent] = useState(initialAgent && agents.some((a) => a.safe === initialAgent) ? initialAgent : (agents[0]?.safe ?? ""));
  const [amount, setAmount] = useState("5");
  const [token, setToken] = useState("USDG");
  const [label, setLabel] = useState("Pay this agent");
  const [ready, setReady] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const src = `${engine ?? "https://purser.fun"}/embed.js`;

  useEffect(() => {
    if (!engine) return;
    if (window.PurserPay) {
      const t = setTimeout(() => setReady(true), 0);
      return () => clearTimeout(t);
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => setReady(true);
    document.head.appendChild(s);
  }, [engine, src]);

  useEffect(() => {
    if (!ready || !box.current || !agent) return;
    box.current.innerHTML = "";
    const node = document.createElement("span");
    node.setAttribute("data-purser-pay", "");
    node.setAttribute("data-agent", agent);
    node.setAttribute("data-amount", amount || "1");
    node.setAttribute("data-token", token);
    node.setAttribute("data-label", label || "Pay this agent");
    box.current.appendChild(node);
    window.PurserPay?.mount(node);
  }, [ready, agent, amount, token, label]);

  const tag = `<script src="${src}"
        data-agent="${agent || "0xTHE_AGENT_SAFE"}"
        data-amount="${amount || "1"}"
        data-token="${token}"
        data-label="${label}" async></script>`;
  const html = `<!-- Or place the button anywhere, then load the script once -->
<span data-purser-pay data-agent="${agent || "0xTHE_AGENT_SAFE"}" data-amount="${amount || "1"}"></span>
<script src="${src}" async></script>`;

  return (
    <div className="grid-2">
      <section className="card" aria-label="Your button">
        <div className="form">
          <label className="field">
            <span className="field__label">Agent that gets paid</span>
            {agents.length ? (
              <select className="select" value={agent} onChange={(e) => setAgent(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.safe} value={a.safe}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) : (
              <input className="input input--mono" value={agent} onChange={(e) => setAgent(e.target.value.trim())} placeholder="0x... the agent's Safe" />
            )}
          </label>
          <div className="form__row">
            <label className="field">
              <span className="field__label">Amount</span>
              <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
            </label>
            <label className="field">
              <span className="field__label">Token</span>
              <select className="select" value={token} onChange={(e) => setToken(e.target.value)}>
                <option value="USDG">USDG</option>
                <option value="ETH">ETH</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span className="field__label">Label</span>
            <input className="input" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <div className="paybox" ref={box} aria-live="polite">
            {!engine || !agent ? null : <span className="paybox__caption">Loading the button...</span>}
          </div>
          {!engine ? (
            <EmptyState size="sm" icon={IconCursor} title="The button loads from the engine" text="It shows up here as soon as the engine answers." />
          ) : (
            <span className="paybox__caption">This is the real button: it pays the agent through MetaMask. USDG is signed as an EIP-3009 authorization and settled into the agent&apos;s Safe, where its splits apply.</span>
          )}
        </div>
      </section>
      <div className="dash">
        <CodeTabs
          title="Pay button"
          samples={[
            { label: "Script tag", code: tag },
            { label: "Any element", code: html },
          ]}
        />
        <section className="card" aria-label="What happens on a click">
          <span className="eyebrow">What happens on a click</span>
          <ol className="steps" style={{ marginTop: 8 }}>
            {[
              ["Connect", "MetaMask opens and switches to Robinhood Chain if needed."],
              ["Sign", "The customer signs a USDG transfer authorization, or sends ETH."],
              ["Settle", "The engine settles it into the agent's Safe through the Purser module."],
              ["Receipt", "The owner's splits are paid and the agent gets an incoming receipt."],
            ].map(([title, text], i) => (
              <li className="stepi stepi--done" key={title} style={{ paddingBottom: i === 3 ? 0 : 20 }}>
                <span className="stepi__no">{i + 1}</span>
                <div className="stepi__body" style={{ gap: 2, paddingTop: 2 }}>
                  <strong className="small" style={{ fontWeight: 500 }}>
                    {title}
                  </strong>
                  <span className="small muted">{text}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
