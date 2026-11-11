import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowRight, IconClock, IconFile, IconXLogo } from "@/components/Icons";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Token",
  description: "The Purser token is not live yet. Details will be published on this page first.",
};

export default function TokenPage() {
  return (
    <div className="container">
      <section className="soon" id="soon">
        <span className="eyebrow">The Purser token</span>
        <h1 className="soon__word">
          <span className="serif">Soon.</span>
        </h1>
        <p className="lead">
          The token is not live yet. When it is, the contract address and the details are published on this page first.
        </p>
        <div className="row" style={{ justifyContent: "center" }}>
          <a href={site.x} target="_blank" rel="noreferrer" className="btn btn--primary">
            <IconXLogo size={14} />
            Follow for the date
          </a>
          <Link href="/how" className="btn btn--secondary">
            See how Purser works
          </Link>
        </div>
      </section>

      <div className="cells cells--3" style={{ marginBottom: "var(--section-y)" }}>
        <div className="cell">
          <IconClock size={18} />
          <h2 className="h4">Status</h2>
          <p className="small muted">Not live. There is no Purser token to buy today.</p>
        </div>
        <div className="cell">
          <IconFile size={18} />
          <h2 className="h4">Contract address</h2>
          <p className="small muted">Published here first, at launch. This page is the place to check it.</p>
        </div>
        <div className="cell">
          <IconArrowRight size={18} />
          <h2 className="h4">Until then</h2>
          <p className="small muted">
            The product comes first.{" "}
            <Link href="/changelog" className="link">
              Follow the changelog
            </Link>{" "}
            to see what ships.
          </p>
        </div>
      </div>
    </div>
  );
}
