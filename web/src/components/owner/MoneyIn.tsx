"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { formatCount, formatDate, formatDuration, money, relativeTime, shortAddress } from "@/lib/format";
import { invoiceStatusLabel, pricingLabel, roleLabel } from "@/lib/labels";
import type { Invoice, Page, PreparedSafeTx, SplitsView, StoreService } from "@/lib/types";
import { IconFile, IconPlus, IconSplit, IconStore, IconTrash } from "../Icons";
import { useEngine, useNow } from "../Live";
import { Card, EmptyState, Loading } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { OwnerFrame, useOwner } from "./Frame";
import { useMany } from "./hooks";
import { AgentPicker } from "./Picker";

export function MoneyIn() {
  return (
    <OwnerFrame title="What your agents earn." lead="Services sold over x402, the pay button, revenue shared on arrival, and jobs between agents held in escrow until delivery.">
      <Body />
    </OwnerFrame>
  );
}

function Body() {
  const owner = useOwner();
  const safes = owner.accounts.map((a) => a.safe);
  const services = useMany<Page<StoreService>>(safes, (s) => `/v1/accounts/${s}/services`, ["receipt"]);
  const invoices = useMany<Page<Invoice>>(safes, (s) => `/v1/accounts/${s}/invoices`, ["invoice", "receipt"]);
  const allServices = Object.values(services.data).flatMap((p) => p.items);
  const seen = new Set<string>();
  const allInvoices = Object.values(invoices.data)
    .flatMap((p) => p.items)
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="dash">
      <section className="dash" aria-labelledby="store-h">
        <div className="section-label">
          <h2 className="h3" id="store-h">
            Storefront
          </h2>
          <Link href="/pay" className="link-arrow small">
            The pay button
          </Link>
        </div>
        {services.loading ? (
          <Loading />
        ) : allServices.length === 0 ? (
          <EmptyState panel icon={IconStore} title="Nothing on sale yet" text="An agent puts a service on sale with the SDK (purser.store.create) or the MCP tool purser_sell. Buyers pay over x402, per call, per minute or per period." />
        ) : (
          <div className="grid-3">
            {allServices.map((s) => (
              <article className="card svc" key={s.id}>
                <div className="row row--between">
                  <h3 className="h4">{s.name}</h3>
                  <span className={"badge " + (s.active ? "badge--ok" : "")}>{s.active ? "On sale" : "Paused"}</span>
                </div>
                <span className="small muted">{owner.names[s.safe.toLowerCase()]}</span>
                <p className="svc__price">
                  {money(s.pricing.price)}{" "}
                  <span className="svc__unit">{s.pricing.model === "subscription" && s.pricing.periodSeconds ? `per ${formatDuration(s.pricing.periodSeconds)}` : pricingLabel[s.pricing.model]}</span>
                </p>
                <dl className="kv">
                  <div className="kv__row">
                    <dt>Sold</dt>
                    <dd className="num">{formatCount(s.uses)}</dd>
                  </div>
                  <div className="kv__row">
                    <dt>Revenue</dt>
                    <dd className="num">{money(s.revenue)}</dd>
                  </div>
                </dl>
                <code className="endpoint">{s.endpoint}</code>
              </article>
            ))}
          </div>
        )}
      </section>

      <Splits />

      <Card title="Invoices and escrow" action={<span className="small muted">Held in escrow for one job, paid out by rule</span>} flush>
        {invoices.loading ? (
          <Loading />
        ) : allInvoices.length === 0 ? (
          <EmptyState icon={IconFile} title="No invoices yet" text="One agent invoices another (purser.invoices.create). The payer funds an escrow from its Safe; the money is released on delivery or refunded after the deadline." />
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Between</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="right">
                    Amount
                  </th>
                  <th scope="col">Deadline</th>
                  <th scope="col" className="right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {allInvoices.map((i) => (
                  <InvoiceRow key={i.id} invoice={i} reload={invoices.reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function InvoiceRow({ invoice: i, reload }: { invoice: Invoice; reload(): void }) {
  const owner = useOwner();
  const action = useAction();
  const now = useNow();
  const name = (a: string) => owner.names[a.toLowerCase()] ?? shortAddress(a);
  const canClaim = i.status === "delivered" && i.reviewUntil !== null && now > i.reviewUntil;
  const canRefund = (i.status === "funded" || i.status === "open") && now > i.deadline && i.status === "funded";
  const run = (what: "claim" | "refund") =>
    action.run(async () => {
      await api(`/v1/invoices/${i.id}/${what}`, { body: {} });
      reload();
      return what === "claim" ? "Paid out to the payee." : "Refunded to the payer.";
    }, "Sending...");
  return (
    <tr>
      <td>
        <div className="table__primary">{i.description}</div>
        <div className="table__secondary">{i.reviewUntil && i.status === "delivered" ? `Review ends ${relativeTime(i.reviewUntil, now)}` : `Opened ${formatDate(i.createdAt)}`}</div>
      </td>
      <td data-label="Between">
        <div className="small">{name(i.payee)}</div>
        <div className="table__secondary">billed to {name(i.payer)}</div>
      </td>
      <td data-label="Status">
        <span className={"badge " + (i.status === "released" ? "badge--ok" : i.status === "disputed" ? "badge--stop" : i.status === "funded" || i.status === "delivered" ? "badge--wait" : "")}>{invoiceStatusLabel[i.status]}</span>
      </td>
      <td className="right num nowrap" data-label="Amount">
        {money(i.money)}
      </td>
      <td className="nowrap" data-label="Deadline">
        {formatDate(i.deadline)}
      </td>
      <td className="right">
        {canClaim ? (
          <button type="button" className="btn btn--secondary btn--sm" disabled={action.busy} onClick={() => void run("claim")}>
            Pay out
          </button>
        ) : canRefund ? (
          <button type="button" className="btn btn--secondary btn--sm" disabled={action.busy} onClick={() => void run("refund")}>
            Refund
          </button>
        ) : null}
        {action.state.kind === "error" ? <ActionStatus state={action.state} /> : null}
      </td>
    </tr>
  );
}

type Draft = { to: string; percent: string; label: string; role: string };

function Splits() {
  const owner = useOwner();
  const [safe, setSafe] = useState<string>((owner.accounts.find((a) => a.kind === "seller") ?? owner.accounts[0])?.safe ?? "");
  const splits = useEngine<SplitsView>(safe ? `/v1/accounts/${safe}/splits` : null, { refreshOn: ["receipt", "account"] });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft[]>([]);
  const action = useAction();
  const items = splits.data?.items ?? [];
  const startEdit = () => {
    setDraft(items.length ? items.map((s) => ({ to: s.to, percent: String(s.bps / 100), label: s.label ?? "", role: s.role })) : [{ to: "", percent: "10", label: "", role: "developer" }]);
    setEditing(true);
  };
  const total = draft.reduce((n, d) => n + Math.round(Number(d.percent || 0) * 100), 0);
  const valid = draft.every((d) => /^0x[0-9a-fA-F]{40}$/.test(d.to.trim()) && Number(d.percent) > 0) && total <= 10000 && draft.length <= 8;
  const save = () =>
    action.run(async () => {
      const tx = await api<PreparedSafeTx>(`/v1/accounts/${safe}/splits/prepare`, {
        body: { splits: draft.map((d) => ({ to: d.to.trim(), bps: Math.round(Number(d.percent) * 100), label: d.label.trim() || undefined, role: d.role })) },
      });
      await owner.signer.execSafeTx(tx);
      splits.reload();
      setEditing(false);
      return "The new splits apply to the next payment that arrives.";
    });
  return (
    <Card
      title="Revenue splits"
      action={
        <div className="toolbar__group">
          <AgentPicker
            accounts={owner.accounts}
            value={safe}
            onChange={(s) => {
              setSafe(s);
              setEditing(false);
            }}
            label="Agent"
          />
        </div>
      }
    >
      <div className="form">
        <p className="small muted">Money that arrives through Purser (x402, the storefront, the pay button) is shared on arrival by the module. The rest stays in the agent&apos;s Safe.</p>
        {!editing ? (
          !splits.data ? (
            <Loading />
          ) : items.length === 0 ? (
            <EmptyState size="sm" icon={IconSplit} title="No splits for this agent" text="Everything it earns stays in its Safe. Add up to eight recipients: you, the developer, a model provider or a co-worker agent.">
              <button type="button" className="btn btn--secondary btn--sm" onClick={startEdit}>
                <IconPlus size={14} />
                Add a split
              </button>
            </EmptyState>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Recipient</th>
                      <th scope="col">Role</th>
                      <th scope="col" className="right">
                        Share
                      </th>
                      <th scope="col" className="right">
                        Received
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((s) => (
                      <tr key={s.to}>
                        <td>
                          <div className="table__primary">{s.label ?? owner.names[s.to.toLowerCase()] ?? shortAddress(s.to)}</div>
                          <div className="table__secondary mono">{shortAddress(s.to)}</div>
                        </td>
                        <td>{roleLabel[s.role] ?? s.role}</td>
                        <td className="right num">{(s.bps / 100).toFixed(2).replace(/\.00$/, "")}%</td>
                        <td className="right num">{s.paid.length ? s.paid.map((m) => money(m)).join(", ") : "$0.00"}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <div className="table__primary">Kept in the Safe</div>
                      </td>
                      <td>Agent</td>
                      <td className="right num">{((splits.data?.keptBps ?? 10000) / 100).toFixed(2).replace(/\.00$/, "")}%</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="row">
                <button type="button" className="btn btn--secondary btn--sm" onClick={startEdit}>
                  Change splits
                </button>
              </div>
            </>
          )
        ) : (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) void save();
            }}
          >
            {draft.map((d, i) => (
              <div className="form__row form__row--3" key={i} style={{ alignItems: "end" }}>
                <label className="field">
                  <span className="field__label">Recipient</span>
                  <input className="input input--mono" value={d.to} placeholder="0x..." onChange={(e) => setDraft((cur) => cur.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
                </label>
                <label className="field">
                  <span className="field__label">Role and label</span>
                  <span className="row" style={{ flexWrap: "nowrap" }}>
                    <select className="select" value={d.role} onChange={(e) => setDraft((cur) => cur.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}>
                      {Object.entries(roleLabel).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                    <input className="input" value={d.label} placeholder="Label" maxLength={40} onChange={(e) => setDraft((cur) => cur.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  </span>
                </label>
                <span className="row" style={{ flexWrap: "nowrap" }}>
                  <span className="input-affix" style={{ flex: 1 }}>
                    <input className="input" aria-label="Share" inputMode="decimal" value={d.percent} onChange={(e) => setDraft((cur) => cur.map((x, j) => (j === i ? { ...x, percent: e.target.value.replace(/[^0-9.]/g, "") } : x)))} />
                    <span className="input-affix__unit">%</span>
                  </span>
                  <button type="button" className="icon-btn" aria-label="Remove" onClick={() => setDraft((cur) => cur.filter((_, j) => j !== i))}>
                    <IconTrash size={16} />
                  </button>
                </span>
              </div>
            ))}
            <span className="field__hint num">
              {(total / 100).toFixed(2)}% shared, {((10000 - total) / 100).toFixed(2)}% stays in the Safe.
            </span>
            <div className="row">
              {draft.length < 8 ? (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDraft((cur) => [...cur, { to: "", percent: "5", label: "", role: "coworker" }])}>
                  <IconPlus size={14} />
                  Add a recipient
                </button>
              ) : null}
              <button type="submit" className="btn btn--primary btn--sm" disabled={!valid || action.busy}>
                Sign the splits
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <ActionStatus state={action.state} />
      </div>
    </Card>
  );
}
