"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { formatTime, money, shortAddress } from "@/lib/format";
import { jobStatusLabel } from "@/lib/labels";
import { withOwner } from "@/lib/owner";
import type { HireRules, Job, Listing, Page } from "@/lib/types";
import { IconUsers } from "../Icons";
import { useEngine } from "../Live";
import { Card, EmptyState, Loading } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { useOwner } from "./Frame";

const badge: Record<Job["status"], string> = {
  awaiting_owner: "badge--wait",
  blocked: "badge--stop",
  cancelled: "",
  funded: "badge--wait",
  delivered: "badge--wait",
  disputed: "badge--stop",
  released: "badge--ok",
  refunded: "",
  resolved: "",
};

/** Jobs one agent hired out and jobs it was hired for, newest first. */
export function JobsCard({ safe }: { safe: string }) {
  const owner = useOwner();
  const jobs = useEngine<Page<Job>>(`/v1/accounts/${safe}/jobs`, { refreshOn: ["invoice", "receipt", "intent"] });
  const name = (a: string, fallback: string | null) => owner.names[a.toLowerCase()] ?? fallback ?? shortAddress(a);
  const items = jobs.data?.items ?? [];
  return (
    <Card
      title="Jobs between agents"
      action={
        <Link href="/market" className="link-arrow small">
          Marketplace
        </Link>
      }
      flush
    >
      {!jobs.data ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState icon={IconUsers} title="No jobs yet" text="When this agent hires another agent, or is hired, the job shows here: the money in escrow, the delivery and the payout." />
      ) : (
        <div className="table-wrap">
          <table className="table table--stack">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Status</th>
                <th scope="col" className="right">
                  Amount
                </th>
                <th scope="col">Due</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 25).map((j) => {
                const selling = j.seller.toLowerCase() === safe.toLowerCase();
                return (
                  <tr key={j.id}>
                    <td>
                      <Link className="table__primary link" href={`/market/jobs/${j.id}`}>
                        {j.title}
                      </Link>
                      <div className="table__secondary">{selling ? `Sold to ${name(j.buyer, j.buyerName)}` : `Hired ${name(j.seller, j.sellerName)}`}</div>
                    </td>
                    <td data-label="Status">
                      <span className={"badge " + badge[j.status]}>{jobStatusLabel[j.status]}</span>
                      {j.status === "awaiting_owner" ? (
                        <div className="table__secondary">
                          <Link className="link" href="/app/approvals">
                            Approve or reject
                          </Link>
                        </div>
                      ) : null}
                    </td>
                    <td className="right num nowrap" data-label="Amount">
                      {selling ? "+" : "-"}
                      {money(j.money)}
                    </td>
                    <td className="nowrap small" data-label="Due">
                      {j.status === "delivered" && j.reviewUntil ? `Review ends ${formatTime(j.reviewUntil)}` : ["funded", "awaiting_owner"].includes(j.status) ? `Deliver by ${formatTime(j.deliverBy)}` : j.finishedAt ? `Done ${formatTime(j.finishedAt)}` : formatTime(j.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** The owner's hiring rules for one agent: who it may hire and the most per job. Signed in with the owner wallet. */
export function HiringCard({ safe }: { safe: string }) {
  const rules = useEngine<HireRules>(`/v1/accounts/${safe}/hire-rules`);
  // the status lives here, so it stays on screen when the saved rules come back and the form starts fresh from them
  const action = useAction();
  return <Card title="Hiring">{!rules.data ? <Loading /> : <HiringForm key={`${rules.data.updatedAt ?? 0}`} safe={safe} rules={rules.data} reload={rules.reload} action={action} />}</Card>;
}

function HiringForm({ safe, rules, reload, action }: { safe: string; rules: HireRules; reload(): void; action: ReturnType<typeof useAction> }) {
  const owner = useOwner();
  const market = useEngine<Page<Listing>>("/v1/market/listings?limit=200");
  const [mode, setMode] = useState<HireRules["mode"]>(rules.mode);
  const [sellers, setSellers] = useState<string[]>(rules.sellers.map((s) => s.toLowerCase()));
  const [max, setMax] = useState(rules.maxPerJob ? String(Number(rules.maxPerJob.amount) / 1e6) : "");

  const known = new Map<string, string>();
  for (const l of market.data?.items ?? []) if (l.seller.toLowerCase() !== safe.toLowerCase()) known.set(l.seller.toLowerCase(), l.sellerName ?? shortAddress(l.seller));
  for (const s of sellers) if (!known.has(s)) known.set(s, owner.names[s] ?? shortAddress(s));

  const save = () =>
    action.run(async () => {
      const maxPerJob = max.trim() === "" ? null : String(Math.round(Number(max) * 1e6));
      await withOwner(owner.signer, (token) => api(`/v1/accounts/${safe}/hire-rules`, { method: "PUT", token, body: { mode, sellers, maxPerJob } }));
      reload();
      return "Hiring rules saved. The firewall applies them to every hire from now on.";
    }, "Sign in with your wallet...");

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small muted" style={{ marginBottom: 8 }}>
          Who this agent may hire
        </legend>
        {(
          [
            ["any", "Any agent on the marketplace"],
            ["listed", "Only the agents I pick"],
            ["off", "No hiring"],
          ] as const
        ).map(([k, label]) => (
          <label className="row" key={k} style={{ gap: 8 }}>
            <input type="radio" name={`hire-mode-${safe}`} checked={mode === k} onChange={() => setMode(k)} />
            <span className="small">{label}</span>
          </label>
        ))}
      </fieldset>
      {mode === "listed" ? (
        known.size === 0 ? (
          <p className="small muted">No other agent sells work yet. Agents appear here once they list on the marketplace.</p>
        ) : (
          <div className="hire-sellers card card--pad-sm">
            {[...known.entries()].map(([addr, label]) => (
              <label key={addr}>
                <input type="checkbox" checked={sellers.includes(addr)} onChange={(e) => setSellers(e.target.checked ? [...sellers, addr] : sellers.filter((s) => s !== addr))} />
                <span className="small">{label}</span>
                <span className="micro muted mono">{shortAddress(addr)}</span>
              </label>
            ))}
          </div>
        )
      ) : null}
      {mode !== "off" ? (
        <label className="field">
          <span className="field__label">Most per job</span>
          <span className="input-affix">
            <input className="input" inputMode="decimal" placeholder="Up to the largest single payment" value={max} onChange={(e) => setMax(e.target.value.replace(/[^0-9.]/g, ""))} />
            <span className="input-affix__unit">USDG</span>
          </span>
        </label>
      ) : null}
      <p className="small muted">
        Every hire is also a payment under this agent&apos;s rules. {rules.approvalAbove ? `Above ${money(rules.approvalAbove)} it waits for your approval.` : "Set an approval amount in the rules to approve big hires yourself."}
      </p>
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={action.busy}>
          Save hiring rules
        </button>
      </div>
      <ActionStatus state={action.state} />
    </form>
  );
}
