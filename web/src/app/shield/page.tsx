import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowRight, IconCheck, IconFingerprint, IconLock, IconShield, IconShieldX, IconUsers, IconX } from "@/components/Icons";
import { ShieldLookup } from "@/components/ShieldLookup";
import { Card, EmptyState, PageHead } from "@/components/ui";
import { getShield } from "@/lib/data";
import { formatCount, formatTime, shortAddress } from "@/lib/format";
import type { ShieldThreat } from "@/lib/types";

export const metadata: Metadata = {
  title: "Purser Shield",
  description: "One agent attacked, every agent protected. Each attack the firewall blocks puts the attacker on a list every Purser account checks before it signs.",
};

export const revalidate = 15;

const EXPLORER = "https://robinhoodchain.blockscout.com";

const kindLabel: Record<ShieldThreat["kind"], string> = {
  planted_payee: "Planted payee",
  forwarding_wallet: "Forwarding wallet",
  forwarding_code: "Forwarding contract",
  spender: "Hostile spender",
};

const steps = [
  { n: "01", title: "One firewall catches an attack", text: "An agent reads a page with a hidden instruction, or is asked to pay a wallet that forwards everything away. Its firewall simulates the payment and refuses it before anything is signed." },
  { n: "02", title: "The attacker goes on the list", text: "The attacker's side of that attack is added to one list in the same second: the address, the contract behind it and a fingerprint of the injected sentence." },
  { n: "03", title: "Every account checks it first", text: "Before any account signs a payment, its firewall checks the payee, every recipient and every spender against the list. The attack that hit one agent never reaches another." },
];

const shared = [
  "Attacker addresses: planted payees, forwarding wallets and hostile spenders",
  "The contract a forwarding wallet hands control to",
  "A one-way fingerprint of each injected sentence, with addresses and amounts masked",
  "How many accounts an attack was aimed at, as a number",
];
const never = [
  "Balances, amounts or what an agent paid for",
  "Owners, agents or which accounts were attacked",
  "The text the agent read",
  "Anything about payments that went through",
];

export default async function ShieldPage() {
  const shield = await getShield();
  const s = shield?.stats;
  const empty = !shield || (shield.threats.length === 0 && shield.prints.length === 0);
  return (
    <>
      <PageHead
        eyebrow="Purser Shield"
        title={
          <>
            One agent attacked, <span className="serif">every agent protected.</span>
          </>
        }
        lead="Every wallet fights alone. On Purser, each attack the firewall blocks puts the attacker on a list that every account checks before it signs, in the same second."
      />
      <div className="container page-body">
        <div className="dash">
          <dl className="cells cells--4">
            <div className="cell">
              <dt className="stat__label">Attackers on the list</dt>
              <dd className="stat__value num">{s ? formatCount(s.addresses) : "0"}</dd>
              <dd className="stat__note">Addresses caught in an attack</dd>
            </div>
            <div className="cell">
              <dt className="stat__label">Injected instructions</dt>
              <dd className="stat__value num">{s ? formatCount(s.prints) : "0"}</dd>
              <dd className="stat__note">Sentences fingerprinted</dd>
            </div>
            <div className="cell">
              <dt className="stat__label">Stopped by the Shield</dt>
              <dd className="stat__value num">{s ? formatCount(s.stoppedByShield) : "0"}</dd>
              <dd className="stat__note">Payments on other accounts</dd>
            </div>
            <div className="cell">
              <dt className="stat__label">Accounts protected</dt>
              <dd className="stat__value num">{s ? formatCount(s.accountsProtected) : "0"}</dd>
              <dd className="stat__note">Every Purser account, by default</dd>
            </div>
          </dl>

          <ol className="cells cells--3">
            {steps.map((x) => (
              <li className="cell" key={x.n}>
                <span className="mono dim small">{x.n}</span>
                <h2 className="h4">{x.title}</h2>
                <p className="small muted">{x.text}</p>
              </li>
            ))}
          </ol>

          <div className="cells cells--2 shield-pair">
            <Card title="Only the attacker is shared">
              <ul className="checks">
                {shared.map((x) => (
                  <li key={x}>
                    <IconCheck size={15} />
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
              <p className="micro dim" style={{ marginTop: 14 }}>
                Never shared
              </p>
              <ul className="checks" style={{ marginTop: 8 }}>
                {never.map((x) => (
                  <li key={x}>
                    <IconX size={15} />
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Your call, per account">
              <div className="stack" style={{ gap: 12 }}>
                <div className="shield-opt">
                  <IconLock size={16} />
                  <p className="small muted">
                    <strong>Block</strong>, the default. A payment that touches anything on the list is refused before it is signed.
                  </p>
                </div>
                <div className="shield-opt">
                  <IconUsers size={16} />
                  <p className="small muted">
                    <strong>Warn and wait for me.</strong> The payment is held, nothing moves, and you release or reject it from the dashboard.
                  </p>
                </div>
                <p className="small muted">An address you put on your own list is never stopped for you; you get a warning instead. Scheduled payouts never wait: a flagged payee is not paid again, and the owner is told at once.</p>
                <Link href="/app/safety" className="link-arrow">
                  Set it in the dashboard
                  <IconArrowRight size={15} />
                </Link>
              </div>
            </Card>
          </div>

          <Card title="Is an address on the list?">
            <ShieldLookup />
          </Card>

          <Card title="The list, live" action={s?.lastFlaggedAt ? <span className="small dim">Last added {formatTime(s.lastFlaggedAt)} UTC</span> : null} flush>
            {empty ? (
              <EmptyState icon={IconShield} title="Nothing on the list yet" text="When a Purser firewall blocks an attack, the attacker's address and a fingerprint of the injected instruction appear here within seconds, with how many accounts it was aimed at." />
            ) : (
              <div className="rows">
                {shield!.threats.map((t) => (
                  <div className="rowi" key={t.address}>
                    <span className="rowi__icon rowi__icon--stop">
                      <IconShieldX size={15} />
                    </span>
                    <div className="rowi__main">
                      <span className="rowi__title">
                        <a className="mono" href={`${EXPLORER}/address/${t.address}`} target="_blank" rel="noreferrer">
                          {shortAddress(t.address)}
                        </a>
                      </span>
                      <span className="rowi__meta">
                        {t.attacks === 1 ? "1 attack" : `${t.attacks} attacks`}, aimed at {t.accounts === 1 ? "1 account" : `${t.accounts} accounts`}
                        {t.stoppedElsewhere ? `, ${t.stoppedElsewhere} more stopped by the Shield` : ""}. Last seen {formatTime(t.lastSeen)} UTC
                      </span>
                    </div>
                    <span className="badge badge--stop">{kindLabel[t.kind]}</span>
                  </div>
                ))}
                {shield!.prints.map((p) => (
                  <div className="rowi" key={p.print}>
                    <span className="rowi__icon rowi__icon--wait">
                      <IconFingerprint size={15} />
                    </span>
                    <div className="rowi__main">
                      <span className="rowi__title">Injected instruction: it {p.why}</span>
                      <span className="rowi__meta">
                        Fingerprint <span className="mono">{p.print.slice(0, 12)}</span>, {p.attacks === 1 ? "1 attack" : `${p.attacks} attacks`} on {p.accounts === 1 ? "1 account" : `${p.accounts} accounts`}
                        {p.stoppedElsewhere ? `, ${p.stoppedElsewhere} more stopped` : ""}. Last seen {formatTime(p.lastSeen)} UTC
                      </span>
                    </div>
                    <span className="badge badge--wait">Fingerprint</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className="row">
            <Link href="/firewall" className="link-arrow">
              Watch the firewall block an attack
              <IconArrowRight size={15} />
            </Link>
            <Link href="/docs#shield" className="link-arrow">
              How the Shield works, in the docs
              <IconArrowRight size={15} />
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
