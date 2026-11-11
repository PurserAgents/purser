"use client";

import { useEffect, useRef, useState } from "react";
import { createFlow } from "@/lib/flowCanvas";
import type { Flow } from "@/lib/flowCanvas";
import { formatUnits, parseUnits, percentOf } from "@/lib/format";
import { IconArrowIn, IconArrowOut, IconBlocks, IconCpu, IconGlobe, IconShieldX, IconUser, IconUsers } from "./Icons";

const DECIMALS = 6;
const u = (value: string) => parseUnits(value, DECIMALS);

interface Entry {
  kind: "out" | "in" | "blocked";
  /** which flow node the money moves to or from */
  node: string;
  who: string;
  memo: string;
  amount: bigint;
}

/** The scripted loop the account card plays. Illustration only. */
const SCRIPT: Entry[] = [
  { kind: "out", node: "models", who: "Reasoning model", memo: "Summarise 14 filings", amount: u("0.84") },
  { kind: "in", node: "customers", who: "Customer payment", memo: "Briefing, per call", amount: u("12.00") },
  { kind: "out", node: "services", who: "Web search API", memo: "x402, 40 queries", amount: u("0.40") },
  { kind: "blocked", node: "unknown", who: "Unknown recipient", memo: "Tried to move the whole balance", amount: 0n },
  { kind: "out", node: "apps", who: "Swap router", memo: "ETH to USDG", amount: u("18.00") },
  { kind: "in", node: "owner", who: "Top-up from you", memo: "Owner funding", amount: u("50.00") },
  { kind: "out", node: "models", who: "Chat model", memo: "42 replies", amount: u("0.31") },
  { kind: "in", node: "customers", who: "Customer payment", memo: "Monthly plan", amount: u("29.00") },
  { kind: "out", node: "services", who: "Translation API", memo: "x402, 9 documents", amount: u("0.27") },
];

const START_BALANCE = u("1840.25");
const START_SPENT = u("38.42");
const BUDGET = u("120.00");
const VISIBLE = 5;
const TICK_MS = 2600;

interface LedgerState {
  step: number;
  balance: bigint;
  spent: bigint;
  rows: { id: number; entry: Entry }[];
}

function initialState(): LedgerState {
  // The last entries of the script are already on the card when the page loads.
  const rows = [];
  for (let i = 0; i < VISIBLE; i++) {
    const index = SCRIPT.length - 1 - i;
    rows.push({ id: -i, entry: SCRIPT[index] });
  }
  return { step: 0, balance: START_BALANCE, spent: START_SPENT, rows };
}

function advance(state: LedgerState): LedgerState {
  const index = state.step % SCRIPT.length;
  const entry = SCRIPT[index];
  // A new lap starts from the opening numbers so the loop never drifts.
  let balance = index === 0 ? START_BALANCE : state.balance;
  let spent = index === 0 ? START_SPENT : state.spent;
  if (entry.kind === "out") {
    balance -= entry.amount;
    spent += entry.amount;
  } else if (entry.kind === "in") {
    balance += entry.amount;
  }
  const rows = [{ id: state.step + 1, entry }, ...state.rows].slice(0, VISIBLE);
  return { step: state.step + 1, balance, spent, rows };
}

/** Eases the shown number toward the real one. Display only. */
function useEased(target: bigint): bigint {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  useEffect(() => {
    const from = shownRef.current;
    if (from === target) return;
    const start = performance.now();
    const delta = target - from;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 700);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = t >= 1 ? target : from + (delta * BigInt(Math.round(eased * 1000))) / 1000n;
      shownRef.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return shown;
}

function Ledger({ state }: { state: LedgerState }) {
  const balance = useEased(state.balance);
  const percent = percentOf(state.spent, BUDGET);
  return (
    <div className="ledger" data-flow-card="">
      <div className="ledger__head">
        <span className="ledger__name">
          <span className="dot" style={{ color: "var(--ok)" }} />
          Research desk
        </span>
        <span className="dim">Agent account</span>
      </div>
      <div className="ledger__balance">
        <span className="ledger__amount" aria-label={`Balance $${formatUnits(state.balance, DECIMALS)}`}>
          <span aria-hidden="true">${formatUnits(balance, DECIMALS)}</span>
        </span>
        <div className="meter" aria-hidden="true">
          <span className="meter__fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="ledger__budget">
          <span>Spent today ${formatUnits(state.spent, DECIMALS)}</span>
          <span>Daily budget ${formatUnits(BUDGET, DECIMALS, 0)}</span>
        </div>
      </div>
      <div className="ledger__rows" aria-hidden="true">
        <div className={"ledger__list" + (state.step > 0 ? " ledger__list--tick" : "")} key={state.step}>
          {state.rows.map(({ id, entry }) => (
            <div key={id} className={"ledger__row" + (entry.kind === "blocked" ? " ledger__row--blocked" : "")}>
              <span className="ledger__icon">
                {entry.kind === "blocked" ? (
                  <IconShieldX size={12} />
                ) : entry.kind === "in" ? (
                  <IconArrowIn size={12} />
                ) : (
                  <IconArrowOut size={12} />
                )}
              </span>
              <span className="ledger__text">
                <span>{entry.who}</span>
                <span>{entry.memo}</span>
              </span>
              <span className={"ledger__value" + (entry.kind === "in" ? " pos" : "")}>
                {entry.kind === "blocked"
                  ? "Blocked"
                  : (entry.kind === "in" ? "+$" : "-$") + formatUnits(entry.amount, DECIMALS)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Hero visual: payment flows between nodes and an account card whose ledger
 * writes itself. Pauses when off screen or in a hidden tab, and shows a still
 * frame when the visitor prefers reduced motion.
 */
export function HeroFlow() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flowRef = useRef<Flow | null>(null);
  const [state, setState] = useState<LedgerState>(initialState);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const flow = createFlow(root, canvas, reduced);
    flowRef.current = flow;
    if (!flow || reduced) return () => flow?.destroy();

    let inView = false;
    const update = () => {
      const on = inView && !document.hidden;
      flow.setRunning(on);
      setActive(on);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        inView = entries.some((entry) => entry.isIntersecting);
        update();
      },
      { threshold: 0.15 },
    );
    observer.observe(root);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      flow.destroy();
      flowRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setState(advance), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (state.step === 0) return;
    flowRef.current?.burst(state.rows[0].entry.node);
  }, [state.step, state.rows]);

  return (
    <div className="flow" ref={rootRef}>
      <canvas className="flow__canvas" ref={canvasRef} aria-hidden="true" />
      <div className="flow__row">
        <span className="flow__node" data-flow="in:owner">
          <IconUser size={14} />
          You
        </span>
        <span className="flow__node" data-flow="in:customers">
          <IconUsers size={14} />
          Customers
        </span>
      </div>
      <Ledger state={state} />
      <div className="flow__row flow__row--out">
        <span className="flow__node" data-flow="out:models">
          <IconCpu size={14} />
          Models
        </span>
        <span className="flow__node" data-flow="out:services">
          <IconGlobe size={14} />
          Services
        </span>
        <span className="flow__node" data-flow="out:apps">
          <IconBlocks size={14} />
          Apps
        </span>
        <span className="flow__node flow__node--stop" data-flow="stop:unknown">
          <IconShieldX size={14} />
          Unknown
        </span>
      </div>
    </div>
  );
}
