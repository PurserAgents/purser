import type { Metadata } from "next";
import { IconCheck, IconClock } from "@/components/Icons";
import { PageHead } from "@/components/ui";
import { changelog, upcoming } from "@/lib/changelog";
import { formatDay } from "@/lib/format";

export const metadata: Metadata = {
  title: "Changelog",
  description: "What has shipped in Purser, newest first.",
};

export default function ChangelogPage() {
  return (
    <>
      <PageHead eyebrow="Changelog" title="What has shipped." lead="Every release, newest first." />
      <div className="container page-body">
        <div className="log">
          {changelog.map((entry) => (
            <article className="log__entry" key={entry.version}>
              <div className="log__meta">
                <span className="badge badge--ink num">v{entry.version}</span>
                <time className="small dim num" dateTime={entry.date}>
                  {formatDay(entry.date)} {entry.date.slice(0, 4)}
                </time>
              </div>
              <div className="log__body">
                <h2 className="h2">{entry.title}</h2>
                <p className="lead">{entry.summary}</p>
                <ul className="checks" style={{ marginTop: 8 }}>
                  {entry.items.map((item) => (
                    <li key={item}>
                      <IconCheck size={16} />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
          <article className="log__entry">
            <div className="log__meta">
              <span className="badge">
                <IconClock size={12} />
                In the works
              </span>
            </div>
            <div className="log__body">
              <h2 className="h3">Being built now</h2>
              <ul className="cells cells--2">
                {upcoming.map((item) => (
                  <li className="cell cell--pad-sm small" key={item}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </article>
        </div>
      </div>
    </>
  );
}
