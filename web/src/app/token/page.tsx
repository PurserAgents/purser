import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowRight, IconFile, IconXLogo } from "@/components/Icons";
import { site } from "@/lib/site";
import { CopyAddress } from "./CopyAddress";
import { BurnStatus } from "./BurnStatus";

const TOKEN = "0x3E4587B12ac365407B5c5d788941eAEBcFC18A1E";
const BURN_POT = "0xD3049f1ef0569D3c9Bf9c44f114a76Bf7CFD404f";
const BUY = `https://ponsfamily.com/launchpad/${TOKEN}`;
const EXPLORER = "https://robinhoodchain.blockscout.com";

export const metadata: Metadata = {
  title: "Token",
  description: "$PURSER is live. The contract address, where to buy it, and how part of the trading fees buys it back and burns it.",
};

export default function TokenPage() {
  return (
    <div className="container">
      <section className="soon" id="token">
        <span className="eyebrow">The Purser token</span>
        <h1 className="soon__word">
          <span className="serif">$PURSER is live.</span>
        </h1>
        <p className="lead">
          This page is the place to check the contract address. Part of the trading fees buys $PURSER back and burns it,
          so the supply only goes down.
        </p>
        <div style={{ display: "flex", justifyContent: "center", margin: "8px 0 20px" }}>
          <CopyAddress address={TOKEN} />
        </div>
        <div className="row" style={{ justifyContent: "center" }}>
          <a href={BUY} target="_blank" rel="noreferrer" className="btn btn--primary">
            Buy on ponsfamily.com
          </a>
          <a href={site.x} target="_blank" rel="noreferrer" className="btn btn--secondary">
            <IconXLogo size={14} />
            Follow @PurserAgents
          </a>
        </div>
      </section>

      <BurnStatus pot={BURN_POT} token={TOKEN} />

      <div className="cells cells--3" style={{ marginBottom: "var(--section-y)" }}>
        <div className="cell">
          <IconFile size={18} />
          <h2 className="h4">Contract address</h2>
          <p className="small muted" style={{ wordBreak: "break-all" }}>
            <a className="link" href={`${EXPLORER}/token/${TOKEN}`} target="_blank" rel="noreferrer">
              {TOKEN}
            </a>
          </p>
        </div>
        <div className="cell">
          <IconArrowRight size={18} />
          <h2 className="h4">Buy back and burn</h2>
          <p className="small muted">
            A contract with no owner and no withdraw function buys $PURSER with its share of the fees and burns it, at
            most every 30 minutes.
          </p>
          <p className="small" style={{ marginTop: 8 }}>
            <a className="link" href={`${EXPLORER}/address/${BURN_POT}`} target="_blank" rel="noreferrer">
              Burn pot {BURN_POT.slice(0, 6)}...{BURN_POT.slice(-4)}
            </a>
          </p>
        </div>
        <div className="cell">
          <IconArrowRight size={18} />
          <h2 className="h4">The product comes first</h2>
          <p className="small muted">
            Purser is open source.{" "}
            <Link href="/changelog" className="link">
              Follow the changelog
            </Link>{" "}
            to see what ships. Holding the token is at your own risk.
          </p>
        </div>
      </div>
    </div>
  );
}
