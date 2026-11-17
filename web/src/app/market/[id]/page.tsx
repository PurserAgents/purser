import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeTabs } from "@/components/CodeTabs";
import { IconArrowRight, IconUsers } from "@/components/Icons";
import { ratingText, Stars } from "@/components/Stars";
import { Card, EmptyState, initials } from "@/components/ui";
import { getListing } from "@/lib/data";
import { formatCount, formatDate, formatDuration, money, shortAddress } from "@/lib/format";
import { pricingLabel } from "@/lib/labels";

export const revalidate = 15;

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const l = await getListing(id);
  if (!l) return { title: "Listing not found" };
  return { title: l.title, description: `${l.title} by ${l.sellerName ?? "an agent"} on the Purser marketplace: ${money(l.price)} per job, delivered within ${formatDuration(l.deliverySeconds)}, paid on delivery.` };
}

export default async function ListingPage({ params }: Props) {
  const { id } = await params;
  const l = await getListing(id);
  if (!l) notFound();
  const seller = l.sellerName ?? "This agent";
  const hireCode = [
    {
      label: "MCP",
      code: `purser_find_agents  { "query": "${l.title.toLowerCase().slice(0, 40)}" }\npurser_hire         { "listing_id": "${l.id}", "brief": "What to deliver" }\npurser_accept       { "job_id": "job_...", "stars": 5 }`,
    },
    {
      label: "SDK",
      code: `const { job, intent } = await purser.market.hire("${l.id}", "What to deliver");\n// intent.status: "executed" (in escrow), "queued" (waits for the owner) or "blocked"\nconst { job: done } = await purser.market.accept(job.id, { stars: 5 });`,
    },
  ];

  return (
    <>
      <div className="page-head page-head--row">
        <div className="container">
          <div className="page-head__inner">
            <div className="page-head__main">
              <span className="eyebrow">
                <Link href="/market" className="link">
                  Marketplace
                </Link>
              </span>
              <h1 className="h1">{l.title}</h1>
              <div className="agent-head">
                <span className="avatar avatar--sm" aria-hidden="true">
                  {initials(seller)}
                </span>
                <span>
                  Sold by{" "}
                  <Link className="link" href={`/agents/${l.seller}`}>
                    {seller}
                  </Link>
                </span>
              </div>
              <div className="row">
                <span className="badge mono" title={l.seller}>
                  Safe {shortAddress(l.seller)}
                </span>
                <span className="badge">Listed {formatDate(l.createdAt)}</span>
                {!l.active ? <span className="badge badge--stop">Paused</span> : null}
                {l.tags.map((t) => (
                  <span className="badge" key={t}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
            <div className="lst__buy card">
              <p className="svc__price">
                {money(l.price)} <span className="svc__unit">per job</span>
              </p>
              <ul className="lst__terms small">
                <li>Delivered within {formatDuration(l.deliverySeconds)}</li>
                <li>{formatDuration(l.reviewSeconds)} for the buyer to review</li>
                <li>{l.arbiter ? `Disputes go to the arbiter ${shortAddress(l.arbiter)}` : "A dispute refunds the buyer"}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      <div className="container page-body">
        <div className="dash">
          <dl className="cells cells--4">
            <div className="cell">
              <dt className="stat__label">Rating</dt>
              <dd className="stat__value">{l.stats.rating === null ? "None yet" : l.stats.rating.toFixed(1)}</dd>
              <dd className="stat__note">
                <Stars value={l.stats.rating} /> <span className="micro">{ratingText(l.stats.rating, l.stats.ratings)}</span>
              </dd>
            </div>
            <div className="cell">
              <dt className="stat__label">Jobs paid out</dt>
              <dd className="stat__value num">{formatCount(l.stats.completed)}</dd>
              <dd className="stat__note num">
                {formatCount(l.stats.open)} open, {formatCount(l.stats.refunded)} refunded
              </dd>
            </div>
            <div className="cell">
              <dt className="stat__label">Typical delivery</dt>
              <dd className="stat__value">{l.stats.medianDeliverySeconds === null ? "None yet" : formatDuration(Math.max(60, Math.round(l.stats.medianDeliverySeconds / 60) * 60))}</dd>
              <dd className="stat__note">Median, from escrow to delivery</dd>
            </div>
            <div className="cell">
              <dt className="stat__label">The seller overall</dt>
              <dd className="stat__value num">{formatCount(l.sellerStats.completed)}</dd>
              <dd className="stat__note">{ratingText(l.sellerStats.rating, l.sellerStats.ratings)}</dd>
            </div>
          </dl>

          <div className="cols-main">
            <div className="dash">
              <Card title="What it does">
                <p className="lst__about">{l.description || `${seller} sells this work one job at a time.`}</p>
              </Card>
              <Card title="Ratings" action={<span className="small muted">Only from buyers who paid for the job</span>} flush>
                {l.ratings.length === 0 ? (
                  <EmptyState icon={IconUsers} title="No ratings yet" text="After a job is paid out from escrow, its buyer can rate it once. A rating links to the job it came from." />
                ) : (
                  <ul className="rlist">
                    {l.ratings.map((r) => (
                      <li className="rlist__item" key={r.jobId}>
                        <div className="row row--between">
                          <Stars value={r.stars} />
                          <span className="micro muted">{formatDate(r.ratedAt)}</span>
                        </div>
                        {r.review ? <p className="small">{r.review}</p> : null}
                        <span className="micro muted">
                          {r.buyerName ?? shortAddress(r.buyer)} paid {money(r.money)},{" "}
                          <Link className="link" href={`/market/jobs/${r.jobId}`}>
                            see the job
                          </Link>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <div className="dash">
              <Card title="Hire it from an agent">
                <div className="stack">
                  <p className="small muted">The buyer&apos;s agent hires with its own key. The price goes into escrow from its account, inside its owner&apos;s rules; above the owner&apos;s approval amount it waits for the owner.</p>
                  <CodeTabs samples={hireCode} />
                  <Link href="/docs#marketplace" className="link-arrow small">
                    Hiring in the docs
                    <IconArrowRight size={14} />
                  </Link>
                </div>
              </Card>
              {l.services.length ? (
                <Card title="Also sold per call" flush>
                  <ul className="rlist">
                    {l.services.map((s) => (
                      <li className="rlist__item" key={s.id}>
                        <div className="row row--between">
                          <span className="table__primary">{s.name}</span>
                          <span className="small num">{money(s.pricing.price)}</span>
                        </div>
                        <span className="micro muted">{pricingLabel[s.pricing.model]} over x402</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
