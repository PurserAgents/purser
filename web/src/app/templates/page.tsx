import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowRight, IconSliders } from "@/components/Icons";
import { daysText, hoursText } from "@/components/Rules";
import { EmptyState, PageHead } from "@/components/ui";
import { getTemplates } from "@/lib/data";
import { formatMoney } from "@/lib/format";
import { alertLabel, kindLabel } from "@/lib/labels";

export const metadata: Metadata = {
  title: "Rule templates",
  description: "Ready rules for each kind of agent: budgets, limits, approval amounts, hours, the firewall, the watchdog and alerts, applied in one transaction.",
};

export const revalidate = 15;

const USDG = { symbol: "USDG", decimals: 6 };
const amount = (v: string | null, none = "No cap") => (v === null ? none : formatMoney(v, USDG, 0));

export default async function TemplatesPage() {
  const templates = await getTemplates();
  const items = templates?.items ?? [];
  return (
    <>
      <PageHead eyebrow="Rule templates" title="Rules for every kind of agent." lead="Start from a template when you open an account, or apply one later in one transaction. Every value can be changed afterwards." />
      <div className="container page-body">
        {items.length === 0 ? (
          <EmptyState panel icon={IconSliders} title="Templates load from the engine" text="The engine serves the templates and applies them on chain. They show up here as soon as it answers." />
        ) : (
          <div className="dash">
            <div className="grid-3">
              {items.map((t) => (
                <article className={"card tpl" + (t.id === "custom" ? " tpl--wide" : "")} key={t.id} id={t.id}>
                  <div className="tpl__head">
                    <h2 className="h4">{t.name}</h2>
                    <span className="badge">{kindLabel[t.kind] ?? t.kind}</span>
                  </div>
                  <p className="small muted">{t.description}</p>
                  <dl className="tpl__rules">
                    <div className="tpl__rule">
                      <dt>Daily budget</dt>
                      <dd>{amount(t.rules.daily)}</dd>
                    </div>
                    <div className="tpl__rule">
                      <dt>Weekly budget</dt>
                      <dd>{amount(t.rules.weekly)}</dd>
                    </div>
                    <div className="tpl__rule">
                      <dt>Largest payment</dt>
                      <dd>{amount(t.rules.maxSingle)}</dd>
                    </div>
                    <div className="tpl__rule">
                      <dt>Ask me above</dt>
                      <dd>{amount(t.rules.approvalAbove, "Never")}</dd>
                    </div>
                    <div className="tpl__rule">
                      <dt>Hours</dt>
                      <dd>{hoursText(t.config.hoursUtc)}</dd>
                    </div>
                    <div className="tpl__rule">
                      <dt>Days</dt>
                      <dd>{daysText(t.config.weekdays)}</dd>
                    </div>
                  </dl>
                  <ul className="checks">
                    {t.highlights.slice(0, 3).map((h) => (
                      <li key={h}>
                        <IconArrowRight size={14} />
                        <span className="small">{h}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="chips">
                    {t.config.useFirewall ? <span className="badge badge--ink">Firewall</span> : null}
                    {t.config.useWatchdog ? <span className="badge badge--ink">Watchdog</span> : null}
                    {t.config.payeeAllowlist ? <span className="badge">Allowlist only</span> : null}
                    {t.rules.cosignAbove ? <span className="badge">Second signer above {amount(t.rules.cosignAbove)}</span> : null}
                    {t.alerts.length ? <span className="badge" title={t.alerts.map((a) => alertLabel[a.kind]?.title ?? a.kind).join(", ")}>{t.alerts.length} {t.alerts.length === 1 ? "alert" : "alerts"}</span> : null}
                  </div>
                </article>
              ))}
              <aside className="card tpl tpl--cta">
                <span className="eyebrow">Use one</span>
                <h2 className="h4">Open an account with a template</h2>
                <p className="small muted">Pick a template in the first step. Every value can be changed later from the agent&apos;s page, and each change is a transaction you sign.</p>
                <div className="row">
                  <Link href="/app/open" className="btn btn--primary">
                    Open an agent account
                    <IconArrowRight size={15} />
                  </Link>
                </div>
              </aside>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
