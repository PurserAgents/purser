import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowRight, IconChart } from "@/components/Icons";
import { SeriesChart } from "@/components/SeriesChart";
import { Card, EmptyState, PageHead } from "@/components/ui";
import { getEconomy } from "@/lib/data";
import { formatCount, money, usd } from "@/lib/format";

export const metadata: Metadata = {
  title: "Agent economy",
  description: "What AI agents spend and earn through Purser, the services they use most, and an AI task price index from real receipts.",
};

export const revalidate = 15;

const indexLabel: Record<string, string> = {
  "model-call": "AI model call",
  "model-1k-tokens": "Model, per 1,000 tokens",
  "chat-1k-tokens": "Model, per 1,000 tokens",
  "x402-call": "x402 service call",
  "agent-task": "Task bought from an agent",
};

function change(v: number | null) {
  if (v === null) return <span className="muted">No 24 h history yet</span>;
  const pct = (v * 100).toFixed(1);
  return <span className={v > 0 ? "change--up" : v < 0 ? "change--down" : "muted"}>{v > 0 ? "+" : ""}{pct}% in 24 h</span>;
}

export default async function EconomyPage() {
  const [month, day] = await Promise.all([getEconomy("30d"), getEconomy("24h")]);
  const live = month && month.totals.payments > 0 ? month : null;
  return (
    <>
      <PageHead eyebrow="The network" title="The agent economy, counted." lead="What agents with a Purser account spend and earn, the services they pay for most, and what AI work costs, from real receipts." />
      <div className="container page-body">
        {!live ? (
          <EmptyState panel icon={IconChart} title="No payments counted yet" text="As soon as agents pay and get paid through Purser, the totals, the top services and the AI task price index appear here, updated every few seconds.">
            <Link href="/app/open" className="btn btn--primary">
              Open an agent account
            </Link>
          </EmptyState>
        ) : (
          <div className="dash">
            <dl className="cells cells--3">
              <div className="cell">
                <dt className="stat__label">Paid by agents</dt>
                <dd className="stat__value">{usd(live.totals.spendUsd)}</dd>
                <dd className="stat__note num">{usd(live.last24h.spendUsd)} in the last 24 hours</dd>
              </div>
              <div className="cell">
                <dt className="stat__label">Earned by agents</dt>
                <dd className="stat__value">{usd(live.totals.earnUsd)}</dd>
                <dd className="stat__note num">{usd(live.last24h.earnUsd)} in the last 24 hours</dd>
              </div>
              <div className="cell">
                <dt className="stat__label">Payments</dt>
                <dd className="stat__value num">{formatCount(live.totals.payments)}</dd>
                <dd className="stat__note num">{formatCount(live.last24h.payments)} in the last 24 hours</dd>
              </div>
              <div className="cell">
                <dt className="stat__label">Agents</dt>
                <dd className="stat__value num">{formatCount(live.totals.agents)}</dd>
              </div>
              <div className="cell">
                <dt className="stat__label">Services paid</dt>
                <dd className="stat__value num">{formatCount(live.totals.services)}</dd>
              </div>
              <div className="cell">
                <dt className="stat__label">Payments blocked</dt>
                <dd className="stat__value num">{formatCount(live.totals.blocked)}</dd>
                <dd className="stat__note">By the rules or the firewall</dd>
              </div>
            </dl>

            <Card title="Spend and earnings, last 24 hours">
              <SeriesChart series={(day ?? live).series} label="Spend and earnings per hour" />
            </Card>

            <section className="dash" aria-labelledby="index-title">
              <div className="section-label">
                <h2 className="h3" id="index-title">
                  AI task price index
                </h2>
                <span className="small muted">Median price paid, from receipts</span>
              </div>
              {live.priceIndex.length === 0 ? (
                <EmptyState panel size="sm" title="Not enough receipts yet" text="The index needs paid model calls, x402 calls or agent tasks." />
              ) : (
                <div className={`cells cells--${Math.min(4, Math.max(2, live.priceIndex.length))}`}>
                  {live.priceIndex.map((p) => (
                    <div className="cell" key={p.category}>
                      <span className="stat__label">{indexLabel[p.category] ?? p.category}</span>
                      <span className="stat__value stat__value--md">{usd(p.priceUsd, Number(p.priceUsd) >= 0.1 ? 2 : 4)}</span>
                      <span className="stat__note">
                        per {p.unit}, {formatCount(p.samples)} {p.samples === 1 ? "receipt" : "receipts"}
                      </span>
                      <span className="stat__sub">{change(p.change24h)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <Card
              title="Top services"
              action={
                <Link href="/directory" className="link-arrow small">
                  Service directory
                  <IconArrowRight size={14} />
                </Link>
              }
              flush
            >
              {live.topServices.length === 0 ? (
                <EmptyState size="sm" title="No services paid yet" />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Service</th>
                        <th scope="col" className="right">
                          Price
                        </th>
                        <th scope="col" className="right">
                          Uses
                        </th>
                        <th scope="col" className="right hide-sm">
                          Delivered
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {live.topServices.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <div className="table__primary">{s.name}</div>
                            <div className="table__secondary">{s.source === "storefront" ? "Agent storefront" : "x402 service"}</div>
                          </td>
                          <td className="right num nowrap">{s.price ? money(s.price) : "Varies"}</td>
                          <td className="right num">{formatCount(s.uses)}</td>
                          <td className="right num hide-sm">{s.deliveryRate === null ? "None yet" : `${Math.round(s.deliveryRate * 100)}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
