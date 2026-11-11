"use client";

import { useState } from "react";
import { usd, usdNumber, usdSigned } from "@/lib/format";
import { categoryLabel } from "@/lib/labels";
import type { Page, Pnl, PnlLine, ReceiptCategory, Team } from "@/lib/types";
import { DayChart } from "../DayChart";
import { IconDownload } from "../Icons";
import { useEngine, useNow } from "../Live";
import { Card, EmptyState, Loading } from "../ui";
import { fillDays } from "./AgentDetail";
import { OwnerFrame, busiest, useOwner } from "./Frame";

export function Accounting() {
  return (
    <OwnerFrame title="The books." lead="Profit and loss per agent and per team, cost per task and per model, revenue per customer. Every line comes from a receipt; download them all as CSV.">
      <Body />
    </OwnerFrame>
  );
}

function Lines({ lines, label, empty, hint, income }: { lines: PnlLine[]; label: (key: string) => string; empty: string; hint?: string; income?: boolean }) {
  const value = (l: PnlLine) => usdNumber(income ? l.income : l.spend);
  const shown = lines.filter((l) => value(l) > 0).sort((a, b) => value(b) - value(a)).slice(0, 8);
  if (shown.length === 0) return <EmptyState size="sm" title={empty} text={hint} />;
  const max = Math.max(...shown.map(value), 0.0001);
  return (
    <div className="hbar">
      {shown.map((l) => (
        <div className="hbar__row" key={l.key}>
          <span>
            {label(l.key)} <span className="muted micro num">{l.count}x</span>
          </span>
          <span className="num">{usd(income ? l.income : l.spend)}</span>
          <span className="hbar__track">
            <span className={"hbar__fill" + (income ? " hbar__fill--in" : "")} style={{ width: `${(value(l) / max) * 100}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function Body() {
  const owner = useOwner();
  const teams = useEngine<Page<Team>>(`/v1/teams?owner=${owner.address}`);
  const [scope, setScope] = useState(`a:${busiest(owner.accounts) ?? ""}`);
  const [days, setDays] = useState(30);
  const from = Math.floor(useNow(600_000) / 3600) * 3600 - days * 86400;
  const [kind, id] = scope.split(":");
  const base = kind === "t" ? `/v1/teams/${id}` : `/v1/accounts/${id}`;
  const pnl = useEngine<Pnl>(id ? `${base}/pnl?from=${from}` : null, { refreshOn: ["receipt"] });
  const p = pnl.data;
  const negative = p?.profitUsd.trim().startsWith("-");

  return (
    <div className="dash">
      <div className="toolbar">
        <label className="picker">
          <span className="field__label">Books of</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
            <optgroup label="Agents">
              {owner.accounts.map((a) => (
                <option key={a.safe} value={`a:${a.safe}`}>
                  {a.name}
                </option>
              ))}
            </optgroup>
            {teams.data?.items.length ? (
              <optgroup label="Teams">
                {teams.data.items.map((t) => (
                  <option key={t.id} value={`t:${t.id}`}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        <div className="toolbar__group">
          <div className="segmented" role="group" aria-label="Period">
            {[7, 30, 90].map((d) => (
              <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
                {d} days
              </button>
            ))}
          </div>
          <a className="btn btn--secondary btn--sm" href={`${base}/export.csv?from=${from}`} download>
            <IconDownload size={15} />
            CSV
          </a>
        </div>
      </div>

      <dl className="cells cells--4">
        <div className="cell">
          <dt className="stat__label">Income</dt>
          <dd className="stat__value">{p ? usd(p.incomeUsd) : "..."}</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Spend</dt>
          <dd className="stat__value">{p ? usd(p.spendUsd) : "..."}</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Purser fees</dt>
          <dd className="stat__value">{p ? usd(p.feesUsd) : "..."}</dd>
          <dd className="stat__note">Included in spend</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Profit and loss</dt>
          <dd className={"stat__value " + (negative ? "neg" : "pos")}>{p ? usdSigned(p.profitUsd) : "..."}</dd>
          <dd className="stat__note">Vault moves are not counted</dd>
        </div>
      </dl>

      <Card title={`Income and spend per day, ${days} days`}>
        {p ? <DayChart series={fillDays(p.byDay, Math.min(days, 30))} /> : <Loading />}
      </Card>

      <div className="grid-2">
        <Card title="Spend by category">
          {p ? <Lines lines={p.byCategory} label={(k) => categoryLabel[k as ReceiptCategory] ?? k} empty="No spending in this period" hint="Each payment the agent makes is counted here by kind." /> : <Loading />}
        </Card>
        <Card title="Cost per model">
          {p ? <Lines lines={p.byModel} label={(k) => k.replace(/^model:/, "")} empty="No model calls in this period" hint="Calls through the model proxy are counted here with their cost." /> : <Loading />}
        </Card>
        <Card title="Cost per task">
          {p ? <Lines lines={p.byTask} label={(k) => k} empty="No tasks tagged yet" hint="Agents tag a cost with taskId or the X-Purser-Task header." /> : <Loading />}
        </Card>
        <Card title="Revenue per customer">
          {p ? <Lines lines={p.byCustomer} label={(k) => (k.startsWith("0x") && k.length === 42 ? (owner.names[k.toLowerCase()] ?? `${k.slice(0, 6)}...${k.slice(-4)}`) : k)} empty="No income in this period" hint="What each customer paid this agent shows up here." income /> : <Loading />}
        </Card>
      </div>
    </div>
  );
}
