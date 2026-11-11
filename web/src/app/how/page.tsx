import type { Metadata } from "next";
import Link from "next/link";
import {
  IconArrowRight,
  IconChart,
  IconCheck,
  IconEye,
  IconReceipt,
  IconShield,
  IconSliders,
  IconUsers,
  IconVault,
  IconX,
} from "@/components/Icons";
import { Reveal } from "@/components/Reveal";
import { PageHead, SectionHead } from "@/components/ui";

export const metadata: Metadata = {
  title: "How it works",
  description: "How a Purser account is built: your Safe, a policy module, one agent key, and a receipt for every payment.",
};

const ruleKinds = [
  { title: "Budgets", text: "A daily and a weekly budget per token. The fee counts toward the budget." },
  { title: "Largest single payment", text: "No single payment may be larger than the amount you set." },
  { title: "Per counterparty limit", text: "A cap on what any one payee can receive per day." },
  { title: "Allowlists", text: "The contracts, x402 payees, models and services the agent may pay." },
  { title: "Time windows", text: "The hours and weekdays, in UTC, when the agent may spend." },
  { title: "Rate limit", text: "The most payments the agent may make per minute." },
  { title: "Approval above an amount", text: "Larger payments wait in a queue until you approve with a passkey or MetaMask." },
  { title: "Co-sign", text: "Above a threshold, a second agent key has to sign as well." },
  { title: "Freeze and recovery", text: "Freeze at once. Add a recovery key that takes effect after a waiting period you can cancel." },
];

const pipeline = [
  { title: "Request", text: "The agent asks to pay a model, a service or a contract with its key." },
  { title: "Rules", text: "Budgets, limits, allowlists and time windows are checked." },
  { title: "Firewall", text: "The payment is simulated and screened for drains and hidden instructions." },
  { title: "Approval", text: "If it is above your limit, it waits for you or a co-signer." },
  { title: "Settle", text: "The module moves the funds from your Safe to the payee." },
  { title: "Receipt", text: "A signed receipt is written and shown in your dashboard." },
];

const never = [
  "Hold your money. Funds sit in your own Safe at all times.",
  "Issue cards or lend money.",
  "Ask for an application or identity documents.",
  "Let an agent's key move funds outside the rules.",
];

export default function HowPage() {
  return (
    <>
      <PageHead
        eyebrow="How it works"
        title={
          <>
            Your Safe, your rules, <span className="serif">one key</span> for the agent.
          </>
        }
        lead="Purser turns a Safe you own into an account an AI agent can use on its own, without ever being able to empty it."
      />

      <section className="section section--subtle" id="account">
        <div className="container">
          <div className="split">
            <div>
              <SectionHead
                eyebrow="The account"
                title="Each agent gets its own Safe. You own it."
                lead="The agent never becomes an owner of the Safe. It holds a session key that can only act through the Purser policy module, and the module checks every rule before a single unit moves."
              />
              <ul className="checks">
                <li>
                  <IconCheck size={16} />
                  <span>
                    <strong>Non-custodial.</strong> There is no Purser balance and no pooled account.
                  </span>
                </li>
                <li>
                  <IconCheck size={16} />
                  <span>
                    <strong>One transaction to open.</strong> The Safe is created and the module enabled together.
                  </span>
                </li>
                <li>
                  <IconCheck size={16} />
                  <span>
                    <strong>An on-chain identity.</strong> The agent is registered in the ERC-8004 identity registry.
                  </span>
                </li>
                <li>
                  <IconCheck size={16} />
                  <span>
                    <strong>You can leave.</strong> The module can be switched off in one Safe transaction.
                  </span>
                </li>
              </ul>
            </div>
            <Reveal>
              <div className="diagram" role="img" aria-label="You own the Safe. The policy module enforces the rules. The agent key acts only through the module.">
                <div className="diagram__box">
                  <span className="h4">You</span>
                  <span className="small dim">Owner, with MetaMask</span>
                </div>
                <div className="diagram__wire">owns</div>
                <div className="diagram__box diagram__box--ink">
                  <span className="h4">Agent account</span>
                  <span className="small dim">A Safe that holds the funds</span>
                </div>
                <div className="diagram__wire">enforced by</div>
                <div className="diagram__box">
                  <span className="h4">Purser policy module</span>
                  <span className="small dim">Rules, approvals, freeze, fee</span>
                </div>
                <div className="diagram__wire">acts only through</div>
                <div className="diagram__box">
                  <span className="h4">Agent key</span>
                  <span className="small dim">Scoped, revocable, never an owner</span>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="section" id="rules">
        <div className="container">
          <SectionHead
            eyebrow="The rules"
            title="Set once, enforced on every payment."
            lead="Rules live in the module on chain. Changing them is a transaction only the owner can sign."
          />
          <Reveal>
            <div className="cells cells--3">
              {ruleKinds.map((rule) => (
                <div className="cell cell--pad-sm" key={rule.title}>
                  <div className="row">
                    <IconSliders size={16} />
                    <h3 className="h4">{rule.title}</h3>
                  </div>
                  <p className="small muted">{rule.text}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section section--subtle" id="payment">
        <div className="container">
          <SectionHead
            eyebrow="One payment"
            title="What happens between the request and the receipt."
            lead="Every payment takes the same path, whether it is a model call, an x402 service or a contract call."
          />
          <Reveal>
            <ol className="pipeline">
              {pipeline.map((step, index) => (
                <li className={"pipeline__step" + (index === 2 ? " pipeline__step--stop" : "")} key={step.title}>
                  <h3 className="h4">{step.title}</h3>
                  <p className="small muted">{step.text}</p>
                </li>
              ))}
            </ol>
          </Reveal>
          <p className="small dim" style={{ marginTop: 20 }}>
            A payment that fails a rule or the firewall stops there. It never reaches the chain, and you see the reasons.
          </p>
        </div>
      </section>

      <section className="section" id="safety">
        <div className="container">
          <SectionHead
            eyebrow="Safety"
            title="Three layers, each with a different job."
            lead="The rules say what is allowed. The firewall looks at each payment. The watchdog looks at the pattern."
          />
          <Reveal>
            <div className="grid grid--3">
              <div className="card">
                <span className="card__icon">
                  <IconSliders size={18} />
                </span>
                <h3 className="h3">Rules</h3>
                <p className="small muted">
                  Hard limits in the contract. A payment that breaks one is rejected by the module itself, whatever the
                  agent was told.
                </p>
              </div>
              <div className="card">
                <span className="card__icon">
                  <IconShield size={18} />
                </span>
                <h3 className="h3">Firewall</h3>
                <p className="small muted">
                  Simulates every payment before it is signed and checks for balance drains, unknown contracts,
                  approvals to unknown spenders and prompt-injection markers.
                </p>
              </div>
              <div className="card">
                <span className="card__icon">
                  <IconEye size={18} />
                </span>
                <h3 className="h3">Watchdog</h3>
                <p className="small muted">
                  Keeps a baseline per agent. Spikes, loops and strange new counterparties freeze the account if you
                  enabled it, with the reason sent to you.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section section--subtle" id="books">
        <div className="container">
          <SectionHead
            eyebrow="The books"
            title="Know what each agent costs and what it brings in."
            lead="Receipts add up to real accounting, per agent and per team."
          />
          <Reveal>
            <div className="cells cells--4">
              <div className="cell">
                <IconReceipt size={18} />
                <h3 className="h4">Receipts</h3>
                <p className="small muted">One per payment, in or out, signed and hash-chained into an audit trail.</p>
              </div>
              <div className="cell">
                <IconChart size={18} />
                <h3 className="h4">Profit and loss</h3>
                <p className="small muted">Cost per task and per model, revenue per customer, CSV export.</p>
              </div>
              <div className="cell">
                <IconUsers size={18} />
                <h3 className="h4">Teams</h3>
                <p className="small muted">A shared treasury Safe with budgets per agent and department.</p>
              </div>
              <div className="cell">
                <IconVault size={18} />
                <h3 className="h4">Treasury</h3>
                <p className="small muted">Idle balance can move into an on-chain vault from your own Safe.</p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section" id="never">
        <div className="container">
          <div className="split split--even split--top">
            <SectionHead
              eyebrow="The lines Purser does not cross"
              title="What Purser never does."
              lead="Purser is software that enforces rules on an account you own. It is not a bank."
            />
            <ul className="stack">
              {never.map((item) => (
                <li className="notice" key={item} style={{ justifyContent: "flex-start", flexWrap: "nowrap" }}>
                  <IconX size={16} />
                  <span>
                    <strong>Never:</strong> {item.charAt(0).toLowerCase() + item.slice(1)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="row" style={{ marginTop: 48 }}>
            <Link href="/app" className="btn btn--primary">
              Open an agent account
              <IconArrowRight size={16} />
            </Link>
            <Link href="/docs" className="btn btn--secondary">
              Read the docs
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
