"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { formatTime, shortAddress } from "@/lib/format";
import type { AuditPage, AuditVerifyResult } from "@/lib/types";
import { IconCheck, IconDoc, IconDownload, IconShield, IconX } from "../Icons";
import { useEngine } from "../Live";
import { Card, EmptyState, Loading } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { OwnerFrame, busiest, useOwner } from "./Frame";
import { AgentPicker } from "./Picker";

export function Audit() {
  return (
    <OwnerFrame title="Every action, signed." lead="Each payment, verdict, approval, freeze, key and rule change is written to a hash chain and signed by the engine's audit key. Anyone can check that nothing was edited or removed.">
      <Body />
    </OwnerFrame>
  );
}

const ACTION_WORDS: Record<string, string> = { "firewall.scenario": "Firewall scenario run", "demo.firewall": "Firewall scenario run" };

function actionLabel(action: string): string {
  return ACTION_WORDS[action] ?? action.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function Body() {
  const owner = useOwner();
  const [safe, setSafe] = useState<string>(busiest(owner.accounts) ?? "");
  const trail = useEngine<AuditPage>(safe ? `/v1/audit?safe=${safe}&limit=40` : null, { refreshOn: ["receipt", "verdict", "account", "approval"] });
  const [result, setResult] = useState<AuditVerifyResult | null>(null);
  const action = useAction();
  const verify = () =>
    action.run(async (status) => {
      const res = await fetch("/v1/audit/export", { cache: "no-store" });
      if (!res.ok) throw new Error("The export could not be downloaded.");
      const jsonl = await res.text();
      status(`Checking ${jsonl.trim().split("\n").length} entries...`);
      const r = await api<AuditVerifyResult>(`/v1/audit/verify?signer=${owner.engine.auditSigner}`, { body: jsonl });
      setResult(r);
      return r.ok ? `All ${r.entries} entries check out: every hash links to the one before and every signature is from ${shortAddress(r.signer)}.` : `The chain breaks at entry ${r.brokenAt}: ${r.problem}`;
    }, "Downloading the whole trail...");

  const items = trail.data?.items ?? [];
  return (
    <div className="dash">
      <div className="cols-main">
        <Card title="Trail" action={<AgentPicker accounts={owner.accounts} value={safe} onChange={setSafe} />} flush>
          {!trail.data ? (
            <Loading />
          ) : items.length === 0 ? (
            <EmptyState icon={IconDoc} title="No entries for this agent yet" text="Everything the engine does for this agent is written here: payments, verdicts, approvals, freezes, keys and rule changes." />
          ) : (
            <div className="rows">
              {items.map((e) => (
                <details className="rowi" key={e.seq} style={{ display: "block" }}>
                  <summary style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr) auto", gap: 16, alignItems: "center", cursor: "pointer", listStyle: "none" }}>
                    <span className="rowi__icon num micro">{e.seq}</span>
                    <span className="rowi__main">
                      <span className="rowi__title">{actionLabel(e.action)}</span>
                      <span className="rowi__meta">
                        {e.actor.replace(/:0x[0-9a-f]+$/i, "")}, {formatTime(e.ts)} UTC
                      </span>
                    </span>
                    <span className="hash">{e.hash.slice(0, 10)}...</span>
                  </summary>
                  <div className="stack" style={{ gap: 8, marginTop: 12, paddingLeft: 48 }}>
                    <pre className="endpoint" style={{ whiteSpace: "pre-wrap" }}>
                      {JSON.stringify(e.data, null, 2)}
                    </pre>
                    <span className="hash">Previous {e.prevHash}</span>
                    <span className="hash">Hash {e.hash}</span>
                  </div>
                </details>
              ))}
            </div>
          )}
        </Card>
        <div className="dash">
          <Card title="Verify">
            <div className="form">
              <p className="small muted">Downloads the whole trail and checks every link and every signature against the engine&apos;s audit key.</p>
              <dl className="kv">
                <div className="kv__row">
                  <dt>Audit key</dt>
                  <dd className="mono">{shortAddress(owner.engine.auditSigner)}</dd>
                </div>
                <div className="kv__row">
                  <dt>Scheme</dt>
                  <dd>keccak256 chain, EIP-191 signatures</dd>
                </div>
              </dl>
              <div className="row">
                <button type="button" className="btn btn--primary" disabled={action.busy} onClick={() => void verify()}>
                  <IconShield size={15} />
                  Verify the trail
                </button>
                <a className="btn btn--secondary" href="/v1/audit/export" download="purser-audit.jsonl">
                  <IconDownload size={15} />
                  Export
                </a>
              </div>
              <ActionStatus state={action.state} />
              {result ? (
                <dl className="kv">
                  <div className="kv__row">
                    <dt>Result</dt>
                    <dd>{result.ok ? <span className="badge badge--ok"><IconCheck size={12} /> Intact</span> : <span className="badge badge--stop"><IconX size={12} /> Broken</span>}</dd>
                  </div>
                  <div className="kv__row">
                    <dt>Entries checked</dt>
                    <dd className="num">{result.entries}</dd>
                  </div>
                </dl>
              ) : null}
              <span className="field__hint">Offline: purser audit export &gt; audit.jsonl, then purser audit verify audit.jsonl.</span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
