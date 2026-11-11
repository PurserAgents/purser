import type { Metadata } from "next";
import Link from "next/link";
import { IconGlobe, IconSearch } from "@/components/Icons";
import { EmptyState, PageHead } from "@/components/ui";
import { getDirectory } from "@/lib/data";
import { formatCount, formatTime, money, shortAddress } from "@/lib/format";

export const metadata: Metadata = {
  title: "Service directory",
  description: "Every x402 service paid through Purser and every agent storefront: price, uses, payers, delivery rate and refunds.",
};

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ q?: string; source?: string; sort?: string }> };

export default async function DirectoryPage({ searchParams }: Props) {
  const { q = "", source = "", sort = "uses" } = await searchParams;
  const dir = await getDirectory({ q: q.slice(0, 80), source: source === "x402" || source === "storefront" ? source : "", sort: ["uses", "rate", "recent", "price"].includes(sort) ? sort : "uses" });
  const items = dir?.items ?? [];
  const filtered = Boolean(q || source);
  return (
    <>
      <PageHead eyebrow="The network" title="Services agents pay for." lead="Every x402 service an agent paid through Purser and every service an agent sells, with what it costs, how often it is used and how often it delivers." />
      <div className="container page-body">
        <div className="dash">
          <form className="toolbar card card--pad-sm" action="/directory" method="get" role="search">
            <div className="toolbar__group" style={{ flex: "1 1 280px" }}>
              <label className="sr-only" htmlFor="dir-q">
                Search
              </label>
              <input id="dir-q" className="input" name="q" defaultValue={q} placeholder="Search by name or URL" />
            </div>
            <div className="toolbar__group">
              <select className="select" name="source" defaultValue={source} aria-label="Source" style={{ width: "auto" }}>
                <option value="">All services</option>
                <option value="x402">x402 services</option>
                <option value="storefront">Agent storefronts</option>
              </select>
              <select className="select" name="sort" defaultValue={sort} aria-label="Sort" style={{ width: "auto" }}>
                <option value="uses">Most used</option>
                <option value="rate">Best delivery</option>
                <option value="recent">Recently used</option>
                <option value="price">Lowest price</option>
              </select>
              <button type="submit" className="btn btn--primary">
                <IconSearch size={15} />
                Show
              </button>
            </div>
          </form>

          <section className="card card--flush" aria-label="Services">
            {items.length === 0 ? (
              <EmptyState icon={IconGlobe} title={filtered ? "No service matches" : "No services yet"} text={filtered ? "Try another word, or show every service." : "Services show up here the first time an agent pays one through Purser, or when an agent puts one on sale."}>
                {filtered ? (
                  <Link href="/directory" className="btn btn--secondary">
                    Show every service
                  </Link>
                ) : (
                  <Link href="/docs#storefront" className="btn btn--secondary">
                    Sell a service
                  </Link>
                )}
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table table--stack">
                  <thead>
                    <tr>
                      <th scope="col">Service</th>
                      <th scope="col" className="right">
                        Price
                      </th>
                      <th scope="col" className="right">
                        Uses
                      </th>
                      <th scope="col" className="right">
                        Payers
                      </th>
                      <th scope="col" className="right">
                        Delivered
                      </th>
                      <th scope="col" className="right">
                        Refunds
                      </th>
                      <th scope="col">Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <div className="table__primary">{s.name}</div>
                          <div className="table__secondary">
                            {s.source === "storefront" ? (
                              <Link className="link" href={`/agents/${s.payTo}`}>
                                Sold by agent {shortAddress(s.payTo)}
                              </Link>
                            ) : (
                              <span className="mono">{s.url.replace(/^https?:\/\//, "").slice(0, 48)}</span>
                            )}
                          </div>
                        </td>
                        <td className="right num nowrap" data-label="Price">
                          {s.price ? money(s.price) : "Varies"}
                        </td>
                        <td className="right num" data-label="Uses">
                          {formatCount(s.uses)}
                        </td>
                        <td className="right num" data-label="Payers">
                          {formatCount(s.payers)}
                        </td>
                        <td className="right num" data-label="Delivered">
                          {s.deliveryRate === null ? "None yet" : `${Math.round(s.deliveryRate * 100)}%`}
                        </td>
                        <td className="right num" data-label="Refunds">
                          {formatCount(s.refunds)}
                        </td>
                        <td className="nowrap" data-label="Last used">
                          {s.lastUsed ? `${formatTime(s.lastUsed)} UTC` : "Not yet"}
                        </td>
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
