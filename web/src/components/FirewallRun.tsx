"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/client";
import { formatMoney, formatTime, shortAddress } from "@/lib/format";
import type { DemoStep, EngineConfig, FirewallRun as Run, Intent, Verdict, VerdictReason } from "@/lib/types";
import { IconAlert, IconCheck, IconGlobe, IconPlay, IconShield, IconShieldX, IconVault, IconX } from "./Icons";
import { useEngineEvents } from "./Live";
import { EmptyState } from "./ui";

const TOTAL = 7;
const USDG = { symbol: "USDG", decimals: 6 };
const PACE_MS = 2200;

type StepData = Record<string, unknown>;

function text(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

/** The article lines of the page the agent read, and its hidden paragraph. */
function parsePage(page: string) {
  const lines = page.split("\n");
  const title = text(lines.find((l) => l.startsWith("<h1")) ?? "");
  const paragraphs = lines.filter((l) => l.startsWith("<p")).map((l) => ({ hidden: /font-size:0|color:#fff/i.test(l), text: text(l) }));
  return { title, paragraphs };
}

function Reason({ reason }: { reason: VerdictReason }) {
  return (
    <li className={`fw__check fw__check--${reason.severity}`}>
      {reason.severity === "block" ? <IconX size={15} /> : reason.severity === "warn" ? <IconAlert size={15} /> : <IconCheck size={15} />}
      <span>
        {reason.title}
        <span className="fw__check-detail">{reason.detail}</span>
      </span>
      <span className="micro">{reason.severity === "block" ? "Fail" : reason.severity === "warn" ? "Warn" : "Note"}</span>
    </li>
  );
}

const PRIORITY = ["injection", "drain", "hidden_text", "delegated_eoa", "approval_unknown_spender", "dangerous_call", "burn_address", "token_contract", "unknown_contract", "max_single", "daily_budget"];
const rank = (r: VerdictReason) => ["block", "warn", "info"].indexOf(r.severity) * 100 + (PRIORITY.includes(r.code) ? PRIORITY.indexOf(r.code) : 50);
const byImportance = (reasons: VerdictReason[]) => [...reasons].sort((a, b) => rank(a) - rank(b));

function triggerText(trigger: string | null | undefined): string | null {
  if (!trigger) return null;
  const hidden = trigger.match(/<p[^>]*(?:font-size:0|color:#fff)[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? trigger.match(/<!--([\s\S]*?)-->/)?.[1];
  const plain = (hidden ?? trigger).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return plain.length > 200 ? plain.slice(0, 197) + "..." : plain;
}

/** The payment the agent tried, the simulation, every check and the verdict. */
function PaymentPanel({ step, verdict, intent }: { step: DemoStep; verdict: Verdict | null; intent: Intent | null }) {
  const d = (step.data ?? {}) as StepData;
  const blocked = d.decision === "block";
  const reasons = (d.reasons as VerdictReason[] | undefined) ?? [];
  const sim = verdict?.simulation;
  const ordered = byImportance(reasons).slice(0, blocked ? 4 : 3);
  const trigger = blocked ? triggerText(verdict?.trigger) : null;
  return (
    <section className="fw__panel" aria-label="The payment">
      <header className="fw__panel-head">
        <span>{blocked ? "The payment the agent signed" : "A normal payment"}</span>
        {intent?.to ? <span className="badge mono">To {shortAddress(intent.to)}</span> : null}
      </header>
      <div className="fw__pay">
        <div className="stack" style={{ gap: 4 }}>
          <span className="stat__label">Amount</span>
          <span className={"fw__amount" + (blocked ? " fw__amount--struck" : "")}>{intent?.money ? formatMoney(intent.money.amount, intent.money.token) : "..."}</span>
        </div>
        {trigger ? (
          <p className="fw__hidden" style={{ margin: 0 }}>
            <span className="fw__hidden-label">What made the agent pay</span>
            {trigger}
          </p>
        ) : null}
        <dl className="kv">
          <div className="kv__row">
            <dt>Simulated with</dt>
            <dd className="mono">{sim ? sim.backend : "..."}</dd>
          </div>
          <div className="kv__row">
            <dt>Simulation</dt>
            <dd>{sim ? (sim.success ? (blocked ? "Runs, so the checks decide" : "Runs clean") : "Would revert on chain") : "..."}</dd>
          </div>
        </dl>
      </div>
      <ul className="fw__checks" aria-label="Checks">
        {ordered.length === 0 ? (
          <li className="fw__check fw__check--info">
            <IconCheck size={15} />
            <span>Every check passed</span>
            <span className="micro">Pass</span>
          </li>
        ) : (
          ordered.map((r, i) => <Reason key={r.code + i} reason={r} />)
        )}
      </ul>
      <div className={"fw__verdict" + (blocked ? "" : " fw__verdict--allow")}>
        <span>{String(d.summary ?? "")}</span>
        <span className="fw__stamp">
          {blocked ? <IconShieldX size={13} /> : <IconCheck size={13} />}
          {blocked ? "Blocked" : "Allowed"}
        </span>
      </div>
    </section>
  );
}

/** The two refused payments, side by side with their main reasons. */
function RefusedPanel({ steps, intents }: { steps: DemoStep[]; intents: Record<string, Intent> }) {
  const refused = steps.filter((s) => s.status === "blocked");
  if (refused.length === 0) return null;
  return (
    <section className="fw__panel" aria-label="What the owner sees">
      <header className="fw__panel-head">
        <span>What the owner sees</span>
        <span className="badge badge--stop">{refused.length} blocked</span>
      </header>
      <div className="rows">
        {refused.map((s) => {
          const d = (s.data ?? {}) as StepData;
          const intent = intents[String(d.intent ?? "")];
          const main = byImportance((d.reasons as VerdictReason[] | undefined) ?? []).filter((r) => r.severity === "block").map((r) => r.title);
          return (
            <div className="rowi" key={s.step}>
              <span className="rowi__icon rowi__icon--stop">
                <IconShieldX size={15} />
              </span>
              <div className="rowi__main">
                <span className="rowi__title">{main[0] ?? s.title}</span>
                <span className="rowi__meta">{main.length > 1 ? `And ${main.length - 1} more: ${main.slice(1, 3).join(", ").toLowerCase()}${main.length > 3 ? ", ..." : ""}` : s.title}</span>
              </div>
              <div className="rowi__side">
                <span className="fw__amount--struck num">{intent?.money ? formatMoney(intent.money.amount, intent.money.token) : ""}</span>
                <span className="badge">Never sent</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PagePanel({ page }: { page: string }) {
  const { title, paragraphs } = parsePage(page);
  return (
    <section className="fw__panel" aria-label="The page the agent read">
      <header className="fw__panel-head">
        <span>The page the agent read</span>
        <IconGlobe size={16} />
      </header>
      <div className="fw__browser">
        <div className="fw__article">
          <h4>{title}</h4>
          {paragraphs.map((p, i) =>
            p.hidden ? (
              <p className="fw__hidden" key={i}>
                <span className="fw__hidden-label">Hidden in white, zero-size text</span>
                {p.text}
              </p>
            ) : (
              <p key={i}>{p.text}</p>
            ),
          )}
        </div>
      </div>
    </section>
  );
}

function AccountPanel({ step }: { step: DemoStep }) {
  const d = (step.data ?? {}) as StepData;
  const funded = step.detail.match(/Funded with ([\d.,]+) USDG/)?.[1];
  const rules = step.detail.match(/rules \(([^)]+)\)/)?.[1];
  return (
    <section className="fw__panel" aria-label="The account">
      <header className="fw__panel-head">
        <span>The agent&apos;s account</span>
        <IconVault size={16} />
      </header>
      <div className="fw__pay">
        <div className="stack" style={{ gap: 4 }}>
          <span className="stat__label">Balance</span>
          <span className="fw__amount">{funded ? `$${funded}` : "..."}</span>
        </div>
        <dl className="kv">
          <div className="kv__row">
            <dt>Safe</dt>
            <dd className="mono">{shortAddress(String(d.safe ?? ""))}</dd>
          </div>
          <div className="kv__row">
            <dt>Rules</dt>
            <dd>{rules ?? "The research template"}</dd>
          </div>
          <div className="kv__row">
            <dt>Firewall</dt>
            <dd>On, signs only after the checks pass</dd>
          </div>
          {d.agentId ? (
            <div className="kv__row">
              <dt>Identity</dt>
              <dd className="num">ERC-8004 id {String(d.agentId)}</dd>
            </div>
          ) : null}
        </dl>
      </div>
    </section>
  );
}

function ResultPanel({ step }: { step: DemoStep }) {
  const d = (step.data ?? {}) as StepData;
  const ok = step.status === "ok";
  return (
    <section className="fw__panel" aria-label="The result">
      <header className="fw__panel-head">
        <span>{ok ? "Nothing left the account" : "The run stopped"}</span>
        <IconShield size={16} />
      </header>
      <dl className="fw__result">
        <div>
          <dt>Balance before</dt>
          <dd>{formatMoney(String(d.before ?? "0"), USDG)}</dd>
        </div>
        <div>
          <dt>Balance after</dt>
          <dd>{formatMoney(String(d.after ?? "0"), USDG)}</dd>
        </div>
        <div>
          <dt>The attacker got</dt>
          <dd>{formatMoney(String(d.attackerReceived ?? "0"), USDG)}</dd>
        </div>
      </dl>
      <div className={"fw__verdict" + (ok ? " fw__verdict--allow" : "")}>
        <span>{ok ? "Both payments were refused before signing. Neither reached the chain." : step.detail}</span>
        <span className="fw__stamp">
          <IconShield size={13} />
          {ok ? "Safe" : "Stopped"}
        </span>
      </div>
    </section>
  );
}

function Stage({ steps, verdicts, intents }: { steps: DemoStep[]; verdicts: Record<string, Verdict>; intents: Record<string, Intent> }) {
  const last = steps[steps.length - 1];
  if (!last) return null;
  const page = steps.find((s) => s.step === 4)?.data?.page as string | undefined;
  if (last.step === 1) return <AccountPanel step={last} />;
  if (last.step === 4 && page) return <PagePanel page={page} />;
  if (last.step >= 7)
    return (
      <>
        <ResultPanel step={last} />
        <RefusedPanel steps={steps} intents={intents} />
      </>
    );
  const d = (last.data ?? {}) as StepData;
  return d.decision ? <PaymentPanel step={last} verdict={verdicts[String(d.verdict ?? "")] ?? null} intent={intents[String(d.intent ?? "")] ?? null} /> : null;
}

/**
 * The firewall scenario, step by step: the engine runs it on its local node and sends each step as a live event.
 * Without test mode the page replays the engine's last run, or says how to start one.
 */
export function FirewallRun({ initial, config }: { initial: Run | null; config: EngineConfig | null }) {
  const [steps, setSteps] = useState<DemoStep[]>(initial?.steps ?? []);
  const [finishedAt, setFinishedAt] = useState<number | null>(initial?.finishedAt ?? null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [intents, setIntents] = useState<Record<string, Intent>>({});
  const runStart = useRef(0);
  const canRun = Boolean(config?.testMode);

  const loadDetails = useCallback((data: StepData | undefined) => {
    const verdict = data?.verdict;
    const intent = data?.intent;
    if (typeof verdict === "string")
      api<Verdict>(`/v1/verdicts/${verdict}`)
        .then((v) => setVerdicts((cur) => ({ ...cur, [verdict]: v })))
        .catch(() => {});
    if (typeof intent === "string")
      api<Intent>(`/v1/intents/${intent}`)
        .then((v) => setIntents((cur) => ({ ...cur, [intent]: v })))
        .catch(() => {});
  }, []);

  useEffect(() => {
    for (const s of initial?.steps ?? []) loadDetails(s.data as StepData | undefined);
  }, [initial, loadDetails]);

  useEngineEvents(
    ["demo"],
    (event) => {
      if (!running || event.ts < runStart.current) return;
      const step = event.data as DemoStep;
      setSteps((cur) => (step.step === 1 ? [step] : [...cur.filter((s) => s.step !== step.step), step].sort((a, b) => a.step - b.step)));
      loadDetails(step.data as StepData | undefined);
      if (step.step >= TOTAL || step.status === "error") {
        setRunning(false);
        setFinishedAt(Math.floor(Date.now() / 1000));
      }
    },
    true,
  );

  async function start() {
    setError(null);
    setSteps([]);
    setFinishedAt(null);
    setRunning(true);
    runStart.current = Math.floor(Date.now() / 1000) - 1;
    try {
      await api("/v1/demo/firewall/run", { body: { paceMs: PACE_MS, wait: false } });
    } catch (e) {
      setRunning(false);
      setError(errorMessage(e));
    }
  }

  const final = steps.find((s) => s.step === TOTAL);
  const status = running
    ? `Step ${Math.max(1, steps.length)} of ${TOTAL}`
    : final
      ? final.status === "ok"
        ? `Finished${finishedAt ? ` ${formatTime(finishedAt)} UTC` : ""}. Nothing left the account.`
        : "The run stopped before the end."
      : canRun
        ? "Ready. The run takes about 15 seconds on a local copy of the chain."
        : "";

  if (!canRun && steps.length === 0) {
    return (
      <EmptyState panel icon={IconShield} title="Runs on a local copy of the chain" text="This scenario moves real test money, so it runs only on an engine in test mode. Start one with the command below and open this page again.">
        <code className="endpoint">cd engine && npm run testmode</code>
      </EmptyState>
    );
  }

  return (
    <div className="dash" id="run">
      <div className="fw__controls">
        <div className="toolbar__group">
          <div className="fw__progress" aria-hidden="true">
            {Array.from({ length: TOTAL }, (_, i) => {
              const s = steps.find((x) => x.step === i + 1);
              const cls = s ? (s.status === "blocked" ? " fw__pip--blocked" : s.status === "error" ? " fw__pip--blocked" : " fw__pip--ok") : running && i === steps.length ? " fw__pip--running" : "";
              return <span key={i} className={"fw__pip" + cls} />;
            })}
          </div>
          <span className="small muted" role="status">
            {status}
          </span>
        </div>
        {canRun ? (
          <button type="button" className="btn btn--primary" onClick={() => void start()} disabled={running}>
            <IconPlay size={15} />
            {running ? "Running" : steps.length ? "Run it again" : "Run it"}
          </button>
        ) : null}
      </div>
      {error ? <div className="action-status action-status--error">{error}</div> : null}
      {steps.length === 0 ? (
        <EmptyState panel icon={IconShield} title="Press Run it to start" text="An agent gets an account with $500, does two normal paid tasks, then reads a page with a hidden instruction to send everything away." />
      ) : (
        <div className="fw">
          <ol className="fw__timeline" aria-label="Steps">
            {steps.map((s) => (
              <li key={s.step} className={`fw__step fw__step--${s.status}` + (s.step === TOTAL ? " fw__step--final" : "")}>
                <span className="fw__no">{s.status === "blocked" ? <IconShieldX size={14} /> : s.step}</span>
                <div className="fw__step-body">
                  <div className="fw__step-title">
                    <span>{s.title}</span>
                    {s.status === "blocked" ? <span className="badge badge--stop">Blocked</span> : s.status === "error" ? <span className="badge badge--stop">Stopped</span> : null}
                  </div>
                  <p className="fw__step-detail">{s.detail}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="fw__stage">
            <Stage steps={steps} verdicts={verdicts} intents={intents} />
          </div>
        </div>
      )}
    </div>
  );
}
