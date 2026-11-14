import type { Metadata } from "next";
import Link from "next/link";
import { IconCheck } from "@/components/Icons";
import { PageHead } from "@/components/ui";
import { shipped, stages, statusLabel } from "@/lib/roadmap";
import { formatDay } from "@/lib/format";

export const metadata: Metadata = {
  title: "Roadmap",
  description: "What is live in Purser, what ships next and where it is going: Shield, approvals on your phone, models at cost, agents hiring agents and every fee burning $PURSER.",
};

export default function RoadmapPage() {
  const counts = { live: 0, next: 0, soon: 0, big: 0 };
  for (const s of stages) counts[s.status]++;
  return (
    <>
      <PageHead
        eyebrow="Roadmap"
        title={
          <>
            The bank every AI agent <span className="serif">runs on.</span>
          </>
        }
        lead="Accounts, rules and the firewall are live. Next, Purser becomes the money layer of the whole agent economy: safer together, cheaper to run, and paying out to the real world."
      />
      <div className="container page-body">
        <nav className="rm-track" aria-label="Roadmap stages">
          <ol>
            {stages.map((s) => (
              <li key={s.slug} className={`rm-track__step rm-track__step--${s.status}`}>
                <a href={`#${s.slug}`}>
                  <span className="rm-track__n mono">{s.n}</span>
                  <span className="rm-track__name">{s.short}</span>
                  <span className="rm-track__st mono">{statusLabel[s.status]}</span>
                </a>
              </li>
            ))}
          </ol>
          <p className="rm-track__sum small dim mono">
            {counts.live} live · {counts.next} next · {counts.soon} soon · {counts.big} big
          </p>
        </nav>

        <div className="rm-stages">
          {stages.map((s) => (
            <section key={s.slug} id={s.slug} className={`rm-stage rm-stage--${s.status}`}>
              <div className="rm-stage__rail" aria-hidden="true">
                <span className="rm-stage__node mono">{s.n}</span>
              </div>
              <div className="rm-stage__head">
                <span className={`rm-pill rm-pill--${s.status} mono`}>{statusLabel[s.status]}</span>
                <h2 className="h2">{s.title}</h2>
                <p className="lead">{s.summary}</p>
                <p className="rm-why small">
                  <span className="mono dim">Why it matters</span>
                  {s.why}
                </p>
                {s.status === "live" ? (
                  <div className="rm-shipped">
                    <span className="mono dim small">Shipped so far</span>
                    <ul>
                      {shipped.map((x) => (
                        <li key={x.text} className="small">
                          <time className="mono dim num" dateTime={x.date}>
                            {formatDay(x.date)}
                          </time>
                          <span>{x.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
              <ul className="rm-items">
                {s.items.map((it) => (
                  <li key={it.title} className="rm-item">
                    {s.status === "live" ? <IconCheck size={16} /> : <span className="rm-item__dot" aria-hidden="true" />}
                    <div>
                      <h3 className="h4">{it.title}</h3>
                      <p className="small muted">{it.text}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="cells cells--3 rm-how">
          <div className="cell">
            <span className="mono dim small">01</span>
            <h2 className="h4">One release at a time</h2>
            <p className="small muted">Each stage ships in parts, tested on a fork of the live chain before it goes live.</p>
          </div>
          <div className="cell">
            <span className="mono dim small">02</span>
            <h2 className="h4">Every release on the record</h2>
            <p className="small muted">
              What shipped and when is on the{" "}
              <Link href="/changelog" className="link">
                changelog
              </Link>
              .
            </p>
          </div>
          <div className="cell">
            <span className="mono dim small">03</span>
            <h2 className="h4">Open source</h2>
            <p className="small muted">Every contract, the engine and the site can be read before you trust them with money.</p>
          </div>
        </div>
      </div>
    </>
  );
}
