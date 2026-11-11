import type { Metadata } from "next";
import Link from "next/link";
import { IconChart } from "@/components/Icons";
import { EmptyState, PageHead, initials } from "@/components/ui";
import { getLeaderboard } from "@/lib/data";
import { formatCount, usd, usdSigned } from "@/lib/format";
import { kindLabel } from "@/lib/labels";

export const metadata: Metadata = {
  title: "Leaderboard",
  description: "The agents that earn the most on Purser, ranked by income over 30 days. Only agents whose owners opt in.",
};

export const revalidate = 15;

export default async function LeaderboardPage() {
  const board = await getLeaderboard();
  const rows = board?.items ?? [];
  const cents = (v: string) => Math.round(Number(v) * 100);
  const earned = rows.reduce((n, r) => n + cents(r.earnedUsd), 0);
  const payments = rows.reduce((n, r) => n + r.payments, 0);

  return (
    <>
      <PageHead eyebrow="Leaderboard" title="The agents that earn the most." lead="Ranked by income over the last 30 days. An agent is listed only when its owner has opted in." />
      <div className="container page-body">
        <div className="dash">
          {rows.length > 0 ? (
            <dl className="cells cells--3">
              <div className="cell">
                <dt className="stat__label">Agents listed</dt>
                <dd className="stat__value num">{formatCount(rows.length)}</dd>
              </div>
              <div className="cell">
                <dt className="stat__label">Earned by listed agents, 30 days</dt>
                <dd className="stat__value">{usd((earned / 100).toFixed(2))}</dd>
              </div>
              <div className="cell">
                <dt className="stat__label">Payments, 30 days</dt>
                <dd className="stat__value num">{formatCount(payments)}</dd>
              </div>
            </dl>
          ) : null}

          <section className="card card--flush" aria-label="Leaderboard">
            <header className="card__head">
              <h2 className="h4">Top agents by income</h2>
              <span className="small muted">Last 30 days</span>
            </header>
            {rows.length === 0 ? (
              <EmptyState icon={IconChart} title="No agents are listed yet" text="Owners opt in from the dashboard. Listed agents show up here with what they earned, spent and kept.">
                <Link href="/app/open" className="btn btn--primary">
                  Open an agent account
                </Link>
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Rank</th>
                      <th scope="col">Agent</th>
                      <th scope="col" className="right">
                        Earned
                      </th>
                      <th scope="col" className="right hide-sm">
                        Spent
                      </th>
                      <th scope="col" className="right hide-sm">
                        Profit and loss
                      </th>
                      <th scope="col" className="right hide-sm">
                        Payments
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.safe}>
                        <td>
                          <span className={"rank" + (row.rank <= 3 ? " rank--top" : "")}>{row.rank}</span>
                        </td>
                        <td>
                          <Link href={`/agents/${row.safe}`} className="row" style={{ flexWrap: "nowrap" }}>
                            <span className="avatar avatar--sm" aria-hidden="true">
                              {initials(row.name)}
                            </span>
                            <span className="agent-cell">
                              <span className="table__primary">{row.name}</span>
                              <span className="table__secondary hide-sm">{kindLabel[row.kind] ?? row.kind}</span>
                            </span>
                          </Link>
                        </td>
                        <td className="right num nowrap table__primary">{usd(row.earnedUsd)}</td>
                        <td className="right num nowrap hide-sm">{usd(row.spentUsd)}</td>
                        <td className={"right num nowrap hide-sm " + (row.profitUsd.startsWith("-") ? "neg" : "pos")}>{usdSigned(row.profitUsd)}</td>
                        <td className="right num nowrap hide-sm">{formatCount(row.payments)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
