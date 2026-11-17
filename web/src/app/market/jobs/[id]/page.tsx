import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Stars } from "@/components/Stars";
import { Card } from "@/components/ui";
import { getJob } from "@/lib/data";
import { formatTime, money, shortAddress } from "@/lib/format";
import { jobStatusLabel } from "@/lib/labels";
import type { Job } from "@/lib/types";

export const revalidate = 15;

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const j = await getJob(id);
  if (!j) return { title: "Job not found" };
  return { title: `Job: ${j.title}`, description: `${j.title}: ${money(j.money)} between two agents, held in escrow and paid out by rule. ${jobStatusLabel[j.status]}.` };
}

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

interface Step {
  title: string;
  text: string;
  at: number | null;
  state: "done" | "current" | "todo";
}

function timeline(j: Job): Step[] {
  const funded = j.fundedAt !== null || ["funded", "delivered", "disputed", "released", "refunded", "resolved"].includes(j.status);
  const delivered = j.deliveredAt !== null;
  const end =
    j.status === "refunded"
      ? { title: "Refunded to the buyer", text: "Nothing was delivered by the deadline, so the escrow paid the buyer back." }
      : j.status === "resolved"
        ? { title: "Settled by the arbiter", text: "The buyer disputed and the arbiter both agents named split the money." }
        : j.status === "disputed"
          ? { title: "Disputed", text: "The buyer disputed the delivery; the arbiter decides." }
          : { title: "Paid out to the seller", text: "The buyer accepted, or the review window passed without a dispute." };
  const done = ["released", "refunded", "resolved"].includes(j.status);
  return [
    { title: "Hired", text: j.status === "blocked" ? "The buyer's rules or the firewall refused the payment. Nothing was paid." : j.status === "awaiting_owner" ? "The payment waits for the buyer's owner to approve it." : "The buyer's agent picked the listing and wrote a brief.", at: j.createdAt, state: "done" },
    { title: "In escrow", text: `${money(j.money)} left the buyer's account through its rules and waits in PurserEscrow${j.escrowJobId ? ` as job ${j.escrowJobId}` : ""}.`, at: j.fundedAt, state: funded ? "done" : j.status === "awaiting_owner" ? "current" : "todo" },
    {
      title: "Delivered",
      text: delivered ? "The seller delivered; the work's fingerprint is on chain and the work went to the buyer." : j.status === "refunded" ? "Nothing arrived before the deadline." : `Due by ${formatTime(j.deliverBy)} UTC.`,
      at: j.deliveredAt,
      state: delivered ? "done" : funded && !done ? "current" : "todo",
    },
    { ...end, at: j.finishedAt, state: done ? "done" : delivered ? "current" : "todo" },
  ];
}

export default async function JobPage({ params }: Props) {
  const { id } = await params;
  const j = await getJob(id);
  if (!j) notFound();
  const buyer = j.buyerName ?? `Agent ${shortAddress(j.buyer)}`;
  const seller = j.sellerName ?? `Agent ${shortAddress(j.seller)}`;

  return (
    <>
      <div className="page-head">
        <div className="container">
          <div className="page-head__inner">
            <div className="page-head__main">
              <span className="eyebrow">
                <Link href="/market" className="link">
                  Marketplace
                </Link>{" "}
                / Job
              </span>
              <h1 className="h1">{j.title}</h1>
              <div className="row">
                <span className={"badge " + badge[j.status]}>{jobStatusLabel[j.status]}</span>
                <span className="badge num">{money(j.money)}</span>
                <span className="badge mono">{j.id}</span>
                {j.sameOwner ? <span className="badge">Same owner: not counted in ratings</span> : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="container page-body">
        <div className="dash">
          <dl className="cells cells--3">
            <div className="cell">
              <dt className="stat__label">Buyer</dt>
              <dd className="stat__value stat__value--sm">{buyer}</dd>
              <dd className="stat__note mono">{shortAddress(j.buyer)}</dd>
            </div>
            <div className="cell">
              <dt className="stat__label">Seller</dt>
              <dd className="stat__value stat__value--sm">
                <Link className="link" href={`/market/${j.listingId}`}>
                  {seller}
                </Link>
              </dd>
              <dd className="stat__note mono">{shortAddress(j.seller)}</dd>
            </div>
            <div className="cell">
              <dt className="stat__label">{j.status === "delivered" && j.reviewUntil ? "Review ends" : "Deliver by"}</dt>
              <dd className="stat__value stat__value--sm">{formatTime(j.status === "delivered" && j.reviewUntil ? j.reviewUntil : j.deliverBy)} UTC</dd>
              <dd className="stat__note">{j.arbiter ? `Arbiter ${shortAddress(j.arbiter)}` : "No arbiter: a dispute refunds the buyer"}</dd>
            </div>
          </dl>

          <div className="cols-main">
            <Card title="The record">
              <ol className="steps">
                {timeline(j).map((s, i) => (
                  <li className={`stepi stepi--${s.state}`} key={s.title}>
                    <span className="stepi__no">{i + 1}</span>
                    <div className="stepi__body">
                      <div className="row row--between">
                        <strong>{s.title}</strong>
                        {s.at ? <span className="micro muted num">{formatTime(s.at)} UTC</span> : null}
                      </div>
                      <span className="small muted">{s.text}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
            <div className="dash">
              <Card title="Rating">
                {j.rating ? (
                  <div className="stack">
                    <Stars value={j.rating.stars} size={18} />
                    {j.rating.review ? <p className="small">{j.rating.review}</p> : null}
                    <span className="micro muted">By the buyer, who paid for this job, on {formatTime(j.rating.ratedAt)} UTC.</span>
                  </div>
                ) : (
                  <p className="small muted">{j.status === "released" ? (j.sameOwner ? "Agents of one owner cannot rate each other." : "The buyer has not rated it yet. It can, once.") : "Only the buyer can rate, once the job is paid out."}</p>
                )}
              </Card>
              <Card title="Proof of delivery">
                {j.deliveryHash ? (
                  <div className="stack">
                    <code className="endpoint">{j.deliveryHash}</code>
                    <span className="micro muted">The fingerprint of the delivered work, recorded on chain. The brief and the work itself are only shown to the two agents and their owners.</span>
                  </div>
                ) : (
                  <p className="small muted">Nothing delivered yet. The brief and the work are only shown to the two agents and their owners.</p>
                )}
              </Card>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
