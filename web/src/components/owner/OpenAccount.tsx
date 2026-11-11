"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { formatMoney, parseUnits, shortAddress } from "@/lib/format";
import { withOwner } from "@/lib/owner";
import type { Account, ApiKey, Page, PreparedSafeTx, PreparedTx, Template } from "@/lib/types";
import { IconArrowRight, IconCheck, IconCopy } from "../Icons";
import { useEngine } from "../Live";
import { ActionStatus, useAction } from "./Action";
import { OwnerFrame, useOwner } from "./Frame";

/** Nobody holds this key: the account starts with no working agent until the owner hands over a Purser key. */
const NO_AGENT_YET = "0x000000000000000000000000000000000000dEaD";

export function OpenAccount() {
  return (
    <OwnerFrame allowEmpty eyebrow="Open an account" title="Give your agent an account." lead="A Safe that you own, the Purser rules switched on in the same transaction, and one key for your agent.">
      <Wizard />
    </OwnerFrame>
  );
}

type Step = 1 | 2 | 3 | 4 | 5;

function StepItem({ no, current, title, children }: { no: number; current: Step; title: string; children?: React.ReactNode }) {
  const state = current > no ? "done" : current === no ? "current" : "todo";
  return (
    <li className={`stepi stepi--${state}`} aria-current={state === "current" ? "step" : undefined}>
      <span className="stepi__no">{state === "done" ? <IconCheck size={15} /> : no}</span>
      <div className="stepi__body">
        <h2 className="h4">{title}</h2>
        {state === "current" ? children : null}
      </div>
    </li>
  );
}

function Wizard() {
  const owner = useOwner();
  const templates = useEngine<Page<Template>>("/v1/templates");
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("research");
  const [isPublic, setPublic] = useState(false);
  const [ownKey, setOwnKey] = useState("");
  const [safe, setSafe] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fund, setFund] = useState("50");
  const action = useAction();
  const chosen = templates.data?.items.find((t) => t.id === template);
  const selfHeld = /^0x[0-9a-fA-F]{40}$/.test(ownKey.trim());

  async function create() {
    await action.run(async (status) => {
      const prepared = await api<{ predictedSafe: string; tx: PreparedTx }>("/v1/accounts/prepare", {
        body: { owners: [owner.address], creator: owner.address, template, agent: selfHeld ? ownKey.trim() : NO_AGENT_YET, salt: String(Date.now()) },
      });
      status("Confirm the account in your wallet...");
      await owner.signer.sendTx(prepared.tx);
      status("Account created. Sign in to save its name...");
      await withOwner(owner.signer, (token) =>
        api<Account>("/v1/accounts/register", { token, body: { safe: prepared.predictedSafe, name: name.trim() || "My agent", kind: chosen?.kind ?? "custom", public: isPublic, template } }),
      );
      setSafe(prepared.predictedSafe);
      owner.reload();
      setStep(selfHeld ? 4 : 3);
      return `Account ${shortAddress(prepared.predictedSafe)} is open.`;
    }, "Preparing the account...");
  }

  async function makeKey() {
    if (!safe) return;
    await action.run(async (status) => {
      const created = await withOwner(owner.signer, (token) => api<{ key: ApiKey; secret: string }>(`/v1/accounts/${safe}/keys`, { token, body: { name: `${name.trim() || "Agent"} key`, managed: true } }));
      setSecret(created.secret);
      status("Make this key the agent. Confirm in your wallet...");
      const account = await api<Account>(`/v1/accounts/${safe}`);
      const tx = await api<PreparedSafeTx>(`/v1/accounts/${safe}/rules/prepare`, { body: { config: { ...account.config, agent: created.key.sessionAddress } } });
      await owner.signer.execSafeTx(tx);
      setStep(4);
      return "The key is the agent now. Copy it: it is shown only once.";
    }, "Creating the key...");
  }

  async function topUp() {
    if (!safe) return;
    const usdg = owner.engine.tokens.find((t) => t.symbol === "USDG");
    if (!usdg) return;
    await action.run(async () => {
      await owner.signer.topUp(safe, usdg, parseUnits(fund || "0", usdg.decimals));
      owner.reload();
      setStep(5);
      return `Sent ${formatMoney(parseUnits(fund || "0", usdg.decimals), usdg)} to the agent's Safe.`;
    });
  }

  return (
    <div className="cols-main">
      <ol className="steps card" aria-label="Open an account">
        <StepItem no={1} current={step} title="Choose the rules">
          <div className="form">
            <label className="field">
              <span className="field__label">Name</span>
              <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Research desk" />
            </label>
            <div className="field">
              <span className="field__label">Rules to start with</span>
              <div className="choice-grid">
                {(templates.data?.items ?? []).map((t) => (
                  <button type="button" key={t.id} className="choice" aria-pressed={t.id === template} onClick={() => setTemplate(t.id)}>
                    <span className="choice__title">{t.name}</span>
                    <span className="choice__text">{t.highlights[0] ?? t.description}</span>
                  </button>
                ))}
              </div>
              <span className="field__hint">You can change every rule later. Each change is a transaction you sign.</span>
            </div>
            <label className="field">
              <span className="field__label">The agent keeps its own key (optional)</span>
              <input className="input input--mono" value={ownKey} onChange={(e) => setOwnKey(e.target.value)} placeholder="0x... the agent's session address" />
              <span className="field__hint">Leave empty and Purser creates a key for the agent in step 3.</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} />
              <span>Show this agent on the leaderboard and a public page</span>
            </label>
            <div className="row">
              <button type="button" className="btn btn--primary" onClick={() => setStep(2)} disabled={!templates.data}>
                Continue
                <IconArrowRight size={15} />
              </button>
            </div>
          </div>
        </StepItem>
        <StepItem no={2} current={step} title="Create the account">
          <p className="small muted">
            One transaction from {shortAddress(owner.address)} creates a Safe you own, switches on the Purser module with the {chosen?.name ?? template} rules and the firewall, and registers the agent&apos;s ERC-8004 identity.
          </p>
          <div className="row">
            <button type="button" className="btn btn--primary" disabled={action.busy} onClick={() => void create()}>
              Create the account
            </button>
            <button type="button" className="btn btn--ghost" disabled={action.busy} onClick={() => setStep(1)}>
              Back
            </button>
          </div>
        </StepItem>
        <StepItem no={3} current={step} title="Give the agent its key">
          <p className="small muted">Purser creates a key for the agent and keeps its signing part sealed under the key itself. One Safe transaction makes it the agent of this account.</p>
          <div className="row">
            <button type="button" className="btn btn--primary" disabled={action.busy} onClick={() => void makeKey()}>
              Create the agent key
            </button>
          </div>
        </StepItem>
        <StepItem no={4} current={step} title="Fund it">
          {secret ? (
            <div className="field">
              <span className="field__label">Agent key, shown once</span>
              <div className="secret">
                <code>{secret}</code>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Copy the key"
                  onClick={() => {
                    void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
                  }}
                >
                  {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                </button>
              </div>
            </div>
          ) : null}
          <label className="field">
            <span className="field__label">Amount</span>
            <span className="input-affix">
              <input className="input" inputMode="decimal" value={fund} onChange={(e) => setFund(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span className="input-affix__unit">USDG</span>
            </span>
            <span className="field__hint">Sent from your wallet straight into the agent&apos;s Safe. You can top up any time.</span>
          </label>
          <div className="row">
            <button type="button" className="btn btn--primary" disabled={action.busy || !Number(fund)} onClick={() => void topUp()}>
              Send to the agent
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setStep(5)}>
              Later
            </button>
          </div>
        </StepItem>
        <StepItem no={5} current={step} title="Ready">
          <p className="small muted">The agent can pay inside its rules now. Every payment shows up as a receipt.</p>
          {safe ? (
            <div className="row">
              <Link href={`/app/agents/${safe}`} className="btn btn--primary">
                Open the agent
                <IconArrowRight size={15} />
              </Link>
              <Link href="/developers" className="btn btn--secondary">
                Connect the agent
              </Link>
            </div>
          ) : null}
        </StepItem>
      </ol>
      <aside className="dash">
        <ActionStatus state={action.state} />
        <section className="card">
          <span className="eyebrow">{chosen?.name ?? "Rules"}</span>
          <p className="small muted">{chosen?.description}</p>
          {chosen ? (
            <dl className="kv">
              <div className="kv__row">
                <dt>Daily budget</dt>
                <dd>{chosen.rules.daily ? formatMoney(chosen.rules.daily, { symbol: "USDG", decimals: 6 }) : "No cap"}</dd>
              </div>
              <div className="kv__row">
                <dt>Largest single payment</dt>
                <dd>{chosen.rules.maxSingle ? formatMoney(chosen.rules.maxSingle, { symbol: "USDG", decimals: 6 }) : "No cap"}</dd>
              </div>
              <div className="kv__row">
                <dt>Ask me above</dt>
                <dd>{chosen.rules.approvalAbove ? formatMoney(chosen.rules.approvalAbove, { symbol: "USDG", decimals: 6 }) : "Never"}</dd>
              </div>
              <div className="kv__row">
                <dt>Firewall and watchdog</dt>
                <dd>{chosen.config.useFirewall ? "On" : "Off"}</dd>
              </div>
            </dl>
          ) : null}
        </section>
        <section className="card">
          <span className="eyebrow">What you sign</span>
          <ul className="checks">
            <li>
              <IconCheck size={16} />
              <span>
                <strong>One transaction</strong> creates the Safe, owned by your wallet, with the rules on.
              </span>
            </li>
            <li>
              <IconCheck size={16} />
              <span>
                <strong>One message</strong> signs you in to save the agent&apos;s name. It costs nothing.
              </span>
            </li>
            <li>
              <IconCheck size={16} />
              <span>
                <strong>One Safe transaction</strong> makes the new key the agent of this account.
              </span>
            </li>
            <li>
              <IconCheck size={16} />
              <span>
                <strong>A transfer</strong> from your wallet funds it, whenever you like.
              </span>
            </li>
          </ul>
        </section>
      </aside>
    </div>
  );
}
