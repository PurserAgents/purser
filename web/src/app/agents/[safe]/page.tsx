import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IconArrowRight, IconStore } from "@/components/Icons";
import { ReceiptList } from "@/components/Receipts";
import { RulesList, dollarRule } from "@/components/Rules";
import { Card, EmptyState, initials } from "@/components/ui";
import { getPublicAgent } from "@/lib/data";
import { formatCount, formatDate, formatDuration, money, shortAddress, usd, usdSigned } from "@/lib/format";
import { kindLabel, pricingLabel } from "@/lib/labels";

export const revalidate = 15;

type Props = { params: Promise<{ safe: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { safe } = await params;
  const agent = await getPublicAgent(safe);
  if (!agent) return { title: "Agent not found" };
  if (agent === "private") return { title: "Private agent" };
  return { title: agent.name, description: `${agent.name}, ${kindLabel[agent.kind] ?? "agent"} on Purser: services, prices, income, spend and receipts.` };
}

export default async function AgentPage({ params }: Props) {
  const { safe } = await params;
  const agent = await getPublicAgent(safe);
  if (!agent) notFound();

  if (agent === "private") {
    return (
      <div className="container center-page">
        <div className="stack" style={{ justifyItems: "center", maxWidth: 520 }}>
          <span className="eyebrow">Agent</span>
          <h1 className="h1">This agent is private.</h1>
          <p className="lead">An agent page is public only when its owner opts in. The owner sees everything in the dashboard.</p>
          <div className="row" style={{ marginTop: 8 }}>
            <Link href="/app" className="btn btn--primary">
              Open the dashboard
            </Link>
            <Link href="/leaderboard" className="btn btn--secondary">
              Public agents
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const rule = dollarRule(agent.rules);
  const services = agent.services.filter((s) => s.active);
  const profitNegative = agent.profitUsd.trim().startsWith("-");

  return (
    <>
      <div className="page-head page-head--row">
        <div className="container">
          <div className="page-head__inner">
            <div className="page-head__main">
              <span className="eyebrow">{kindLabel[agent.kind] ?? "Agent"}</span>
              <div className="agent-head">
                <span className="avatar" aria-hidden="true">
                  {initials(agent.name)}
                </span>
                <h1 className="h1">{agent.name}</h1>
              </div>
              <div className="row">
                <span className="badge mono" title={agent.safe}>
                  Safe {shortAddress(agent.safe)}
                </span>
                {agent.agentId ? <span className="badge num">ERC-8004 id {agent.agentId}</span> : null}
                <span className="badge">Since {formatDate(agent.createdAt)}</span>
                <span className="badge">Public by owner opt-in</span>
              </div>
            </div>
            <Link href={`/pay?agent=${agent.safe}`} className="btn btn--primary">
              Pay this agent
              <IconArrowRight size={15} />
            </Link>
          </div>
        </div>
      </div>

      <div className="container page-body">
        <div className="dash">
          <dl className="cells cells--4">
            <div className="cell">
              <dt className="stat__label">Earned, 30 days</dt>
              <dd className="stat__value">{usd(agent.earnedUsd)}</dd>
            </div>
            <div className="cell">
              <dt className="stat__label">Spent, 30 days</dt>
              <dd className="stat__value">{usd(agent.spentUsd)}</dd>
            </div>
            <div className="cell">
              <dt className="stat__label">Profit and loss</dt>
              <dd className={"stat__value " + (profitNegative ? "neg" : "pos")}>{usdSigned(agent.profitUsd)}</dd>
            </div>
            <div className="cell">
              <dt className="stat__label">Services on sale</dt>
              <dd className="stat__value num">{formatCount(services.length)}</dd>
            </div>
          </dl>

          <section className="dash" aria-labelledby="store-title" id="store">
            <div className="section-label">
              <h2 className="h3" id="store-title">
                Storefront
              </h2>
              <span className="small muted">Paid per use over x402, straight into the agent&apos;s own Safe.</span>
            </div>
            {services.length === 0 ? (
              <EmptyState panel icon={IconStore} title="Nothing on sale yet" text="When this agent sells a service over x402, its price and endpoint appear here." />
            ) : (
              <div className="grid-3">
                {services.map((s) => (
                  <article className="card svc" key={s.id}>
                    <div className="row row--between">
                      <h3 className="h4">{s.name}</h3>
                      <span className="badge">{formatCount(s.uses)} sold</span>
                    </div>
                    <p className="small muted">{s.description || "A paid service of this agent."}</p>
                    <p className="svc__price">
                      {money(s.pricing.price)} <span className="svc__unit">{s.pricing.model === "subscription" && s.pricing.periodSeconds ? `per ${formatDuration(s.pricing.periodSeconds)}` : pricingLabel[s.pricing.model]}</span>
                    </p>
                    <code className="endpoint">{s.endpoint}</code>
                  </article>
                ))}
              </div>
            )}
          </section>

          <div className="dash__cols">
            <Card title="Receipts" flush>
              <ReceiptList receipts={agent.receipts.slice(0, 15)} compact empty="Payments in and out of this agent's account appear here." />
            </Card>
            <Card title="Rules" action={<span className="badge">Enforced on chain</span>}>
              {rule ? <RulesList rule={rule} /> : <p className="small muted">No token rules set.</p>}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
