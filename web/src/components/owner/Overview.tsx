"use client";

import Link from "next/link";
import { api } from "@/lib/client";
import { formatMoney, money, percentOf, usd } from "@/lib/format";
import { kindLabel } from "@/lib/labels";
import type { Account, Page, PendingApproval, PreparedTx, Receipt, Verdict } from "@/lib/types";
import { IconArrowRight, IconPlus, IconShieldX, IconSnow } from "../Icons";
import { useEngine, useNow } from "../Live";
import { ReceiptList } from "../Receipts";
import { Card, EmptyState, Loading, Meter, initials } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { OwnerFrame, useOwner, type OwnerView } from "./Frame";
import { useMany } from "./hooks";

export function usdg(a: Account | undefined) {
  return a?.balances.find((b) => b.token.symbol === "USDG") ?? null;
}

function sumUnits(values: (string | undefined)[]): bigint {
  return values.reduce((n, v) => n + BigInt(v ?? "0"), 0n);
}

export function Overview() {
  return (
    <OwnerFrame
      title="Your agents and their money."
      lead="Balances, spending against the rules, and every receipt. Freeze any agent at once."
      aside={
        <Link href="/app/open" className="btn btn--primary">
          <IconPlus size={16} />
          Open an agent account
        </Link>
      }
    >
      <OverviewBody />
    </OwnerFrame>
  );
}

function OverviewBody() {
  const owner = useOwner();
  const safes = owner.accounts.map((a) => a.safe);
  const details = useMany<Account>(safes, (s) => `/v1/accounts/${s}`, ["account", "receipt", "intent"]);
  const receipts = useEngine<Page<Receipt>>("/v1/receipts?limit=200", { refreshOn: ["receipt"] });
  const approvals = useEngine<Page<PendingApproval>>("/v1/approvals", { refreshOn: ["approval", "intent"] });
  const verdicts = useEngine<Page<Verdict>>("/v1/verdicts?decision=block&limit=100", { refreshOn: ["verdict"] });
  const mine = new Set(safes.map((s) => s.toLowerCase()));
  const myReceipts = (receipts.data?.items ?? []).filter((r) => mine.has(r.safe.toLowerCase())).slice(0, 10);
  const myApprovals = (approvals.data?.items ?? []).filter((a) => mine.has(a.safe.toLowerCase()));
  const myBlocked = (verdicts.data?.items ?? []).filter((v) => mine.has(v.safe.toLowerCase()));
  const dayStart = Math.floor(useNow() / 86_400) * 86_400;
  const blockedToday = myBlocked.filter((v) => v.createdAt >= dayStart).length;

  const balances = owner.accounts.map((a) => usdg(details.data[a.safe])?.amount);
  const total = sumUnits(balances);
  const token = usdg(Object.values(details.data)[0])?.token ?? { symbol: "USDG", decimals: 6 };
  const spentCents = owner.accounts.reduce((n, a) => n + Math.round(Number(a.spentTodayUsd) * 100), 0);
  const earnedCents = owner.accounts.reduce((n, a) => n + Math.round(Number(a.earnedTodayUsd) * 100), 0);

  return (
    <div className="dash">
      <dl className="cells cells--4">
        <div className="cell">
          <dt className="stat__label">Total balance</dt>
          <dd className="stat__value">{details.loading ? "..." : formatMoney(total, token)}</dd>
          <dd className="stat__note">
            Across {owner.accounts.length} {owner.accounts.length === 1 ? "agent" : "agents"}, in your own Safes
          </dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Spent today</dt>
          <dd className="stat__value">{usd((spentCents / 100).toFixed(2))}</dd>
          <dd className="stat__note">Inside the rules of each agent</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Earned today</dt>
          <dd className="stat__value">{usd((earnedCents / 100).toFixed(2))}</dd>
          <dd className="stat__note num">Net {usd(((earnedCents - spentCents) / 100).toFixed(2))} today</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Blocked today</dt>
          <dd className="stat__value num">{blockedToday}</dd>
          <dd className="stat__note">
            <Link href="/app/safety" className="link">
              Stopped by the rules or the firewall
            </Link>
          </dd>
        </div>
      </dl>

      <AgentsTable owner={owner} details={details.data} />

      <div className="dash__cols">
        <Card
          title="Receipts"
          action={
            <Link href="/app/accounting" className="link-arrow small">
              All books
              <IconArrowRight size={14} />
            </Link>
          }
          flush
        >
          {receipts.data ? <ReceiptList receipts={myReceipts} names={owner.names} /> : <Loading />}
        </Card>
        <div className="dash">
          <Card
            title="Waiting for you"
            action={myApprovals.length ? <span className="badge badge--wait">{myApprovals.length}</span> : null}
            flush
          >
            {!approvals.data ? (
              <Loading />
            ) : myApprovals.length === 0 ? (
              <EmptyState size="sm" title="Nothing to approve" text="Payments above an agent's approval amount wait here until you approve them." />
            ) : (
              <div className="rows">
                {myApprovals.slice(0, 3).map((a) => (
                  <div className="rowi" key={a.id}>
                    <span className="rowi__icon rowi__icon--wait">
                      <IconShieldX size={15} />
                    </span>
                    <div className="rowi__main">
                      <span className="rowi__title">{a.summary}</span>
                      <span className="rowi__meta">{owner.names[a.safe.toLowerCase()]}</span>
                    </div>
                    <Link href="/app/approvals" className="btn btn--secondary btn--sm">
                      Review
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card
            title="Latest blocked payments"
            action={
              <Link href="/app/safety" className="link-arrow small">
                Safety
                <IconArrowRight size={14} />
              </Link>
            }
            flush
          >
            {!verdicts.data ? (
              <Loading />
            ) : myBlocked.length === 0 ? (
              <EmptyState size="sm" title="Nothing blocked" text="When the rules or the firewall stop a payment, the reason shows here." />
            ) : (
              <div className="rows">
                {myBlocked.slice(0, 3).map((v) => (
                  <div className="rowi" key={v.id}>
                    <span className="rowi__icon rowi__icon--stop">
                      <IconShieldX size={15} />
                    </span>
                    <div className="rowi__main">
                      <span className="rowi__title">{v.reasons.find((r) => r.severity === "block")?.title ?? v.summary}</span>
                      <span className="rowi__meta">{owner.names[v.safe.toLowerCase()]}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function AgentsTable({ owner, details }: { owner: OwnerView; details: Record<string, Account> }) {
  const action = useAction();
  const allFrozen = owner.accounts.every((a) => a.frozen);

  async function setFrozen(safes: string[], freeze: boolean) {
    await action.run(async (step) => {
      for (const safe of safes) {
        const tx = await api<PreparedTx>(`/v1/accounts/${safe}/${freeze ? "freeze" : "unfreeze"}/prepare`, { body: {} });
        step(`${freeze ? "Freezing" : "Unfreezing"} ${owner.names[safe.toLowerCase()]}. Confirm in your wallet...`);
        await owner.signer.sendTx(tx);
      }
      owner.reload();
      return freeze ? "Frozen. No payment can leave until you unfreeze." : "Unfrozen. The agent can pay again inside its rules.";
    });
  }

  return (
    <section className="card card--flush">
      <header className="card__head">
        <h2 className="h4">Agents</h2>
        <div className="toolbar__group">
          <button
            type="button"
            className={"btn btn--sm " + (allFrozen ? "btn--secondary" : "btn--danger")}
            disabled={action.busy}
            onClick={() => void setFrozen(owner.accounts.filter((a) => a.frozen === allFrozen).map((a) => a.safe), !allFrozen)}
          >
            <IconSnow size={15} />
            {allFrozen ? "Unfreeze all" : "Freeze all"}
          </button>
        </div>
      </header>
      {action.state.kind !== "idle" ? (
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <ActionStatus state={action.state} />
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="table table--stack">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Status</th>
              <th scope="col" className="right">
                Balance
              </th>
              <th scope="col">Spent today</th>
              <th scope="col" className="right">
                Earned today
              </th>
              <th scope="col" className="right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {owner.accounts.map((agent) => {
              const detail = details[agent.safe];
              const dollars = usdg(detail);
              const spend = detail?.spentToday.find((s) => s.token.symbol === "USDG");
              const budget = spend?.remaining != null ? (BigInt(spend.spent) + BigInt(spend.remaining)).toString() : null;
              return (
                <tr key={agent.safe} className={agent.frozen ? "tr--frozen" : undefined}>
                  <td>
                    <Link href={`/app/agents/${agent.safe}`} className="row" style={{ flexWrap: "nowrap" }}>
                      <span className="avatar avatar--sm" aria-hidden="true">
                        {initials(agent.name)}
                      </span>
                      <span className="agent-cell">
                        <span className="table__primary">{agent.name}</span>
                        <span className="table__secondary">{kindLabel[agent.kind] ?? agent.kind}</span>
                      </span>
                    </Link>
                  </td>
                  <td>
                    {agent.frozen ? (
                      <span className="badge">
                        <IconSnow size={12} />
                        Frozen
                      </span>
                    ) : (
                      <span className="badge badge--ok">
                        <span className="dot" />
                        Active
                      </span>
                    )}
                  </td>
                  <td className="right num nowrap" data-label="Balance">
                    <div className="table__primary">{dollars ? money(dollars) : "..."}</div>
                  </td>
                  <td data-label="Spent today">
                    <div className="budget-cell">
                      <span className="budget-cell__text">
                        <span>{usd(agent.spentTodayUsd)}</span>
                        {budget && spend ? <span className="dim">of {formatMoney(budget, spend.token, 0)}</span> : null}
                      </span>
                      {budget && spend ? <Meter percent={percentOf(spend.spent, budget)} label={`${agent.name} daily budget used`} limit /> : null}
                    </div>
                  </td>
                  <td className="right num nowrap" data-label="Earned today">
                    {usd(agent.earnedTodayUsd)}
                  </td>
                  <td className="right">
                    <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      <Link href={`/app/agents/${agent.safe}`} className="btn btn--ghost btn--sm">
                        Open
                      </Link>
                      <button type="button" className="btn btn--secondary btn--sm" aria-pressed={agent.frozen} disabled={action.busy} onClick={() => void setFrozen([agent.safe], !agent.frozen)}>
                        {agent.frozen ? "Unfreeze" : "Freeze"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
