import type { Metadata } from "next";
import Link from "next/link";
import { CodeTabs, type CodeSample } from "@/components/CodeTabs";
import { IconArrowRight, IconChart, IconCpu, IconReceipt, IconShield, IconSliders, IconVault, IconWallet } from "@/components/Icons";
import { Reveal } from "@/components/Reveal";
import { PageHead, SectionHead } from "@/components/ui";
import { AT_COST_MODELS, SETTLE_AT_USD, callCost, levelLabel } from "@/lib/models";

export const metadata: Metadata = {
  title: "Models at cost",
  description: "Every AI model at the provider's own price, paid per call from the agent's own account. No markup, nothing prepaid, the owner's rules and budgets on every call.",
};

const promises = [
  { icon: IconWallet, title: "Paid from the agent's account", text: "Each call is charged at the provider's price and paid from the agent's own account, through its rules and the firewall." },
  { icon: IconVault, title: "No balance with anyone", text: "Nothing sits prepaid at a middleman. The money stays in the account until the calls are made." },
  { icon: IconCpu, title: "The cheapest model that does the job", text: "Ask for fast, balanced or best. Purser picks the lowest priced model at that level that is still inside your budgets." },
];

const steps = [
  { icon: IconShield, title: "Checked before the call", text: "The account must be able to pay what it owes plus the most this call can cost, under its rules. If not, the model is never asked." },
  { icon: IconCpu, title: "The call", text: "Purser sends the request to the provider and returns the answer in the OpenAI format your framework already speaks." },
  { icon: IconReceipt, title: "The exact cost", text: "The tokens the call really used, times the provider's price. No markup, rounded to the millionth of a dollar." },
  { icon: IconWallet, title: "Paid on chain", text: `Calls settle together once they add up to $${SETTLE_AT_USD.toFixed(2)} or after an hour, one payment per model, so gas never costs more than the call.` },
];

const samples: CodeSample[] = [
  {
    label: "OpenAI SDK",
    code: `import OpenAI from "openai";

// the agent's own Purser key, nothing else to set up
const ai = new OpenAI({ apiKey: process.env.PURSER_API_KEY, baseURL: "https://purseragents.fun/v1" });

const r = await ai.chat.completions.create({
  model: "auto:fast", // or auto:balanced, auto:best, purser/claude-sonnet-5-5
  messages: [{ role: "user", content: "Summarise this report in three lines." }],
});
// r.purser.costUsd is what the call cost, at the provider's price`,
  },
  {
    label: "Purser SDK",
    code: `import { Purser } from "@purseragents/sdk";

const purser = new Purser({ apiKey: process.env.PURSER_API_KEY });
const r = await purser.chat.completions.create({
  model: "auto:balanced",
  messages: [{ role: "user", content: "Draft the reply to this client." }],
});
await purser.atCost.owed(); // what the agent owes since the last payment`,
  },
  {
    label: "curl",
    code: `curl https://purseragents.fun/v1/chat/completions \\
  -H "Authorization: Bearer $PURSER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Purser-Task: report-42" \\
  -d '{"model":"auto:best","messages":[{"role":"user","content":"Plan the launch."}]}'`,
  },
];

const fmtPrice = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(0)}`;
const fmtCost = (n: number) => `$${n.toFixed(n < 0.01 ? 5 : 4)}`;

export default function ModelsPage() {
  return (
    <>
      <PageHead
        eyebrow="Models at cost"
        title={
          <>
            Every AI model at the provider&apos;s price. <span className="serif">Paid from the agent&apos;s own account.</span>
          </>
        }
        lead="Models are where agents spend the most. On Purser an agent pays for each call at the price the provider charges, from an account its owner controls, with the same rules, firewall and receipts as every other payment."
      />
      <div className="container page-body">
        <div className="dash">
          <ul className="cells cells--3">
            {promises.map((p) => (
              <li className="cell" key={p.title}>
                <span className="card__icon">
                  <p.icon size={18} />
                </span>
                <h2 className="h3">{p.title}</h2>
                <p className="small muted">{p.text}</p>
              </li>
            ))}
          </ul>

          <section className="card card--flush" aria-label="Prices" id="prices">
            <header className="card__head">
              <h2 className="h4">The price list</h2>
              <span className="small muted">Dollars per million tokens, the provider&apos;s own price</span>
            </header>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col" className="hide-sm">
                      Level
                    </th>
                    <th scope="col" className="right">
                      Input
                    </th>
                    <th scope="col" className="right">
                      Output
                    </th>
                    <th scope="col" className="right hide-sm">
                      1,000 in, 500 out
                    </th>
                    <th scope="col" className="right">
                      Markup
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {AT_COST_MODELS.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <span className="table__primary">{m.name}</span>
                        <span className="table__secondary hide-sm" style={{ display: "block" }}>
                          {m.goodFor}
                        </span>
                      </td>
                      <td className="hide-sm">{levelLabel[m.level]}</td>
                      <td className="right num nowrap">{fmtPrice(m.input)}</td>
                      <td className="right num nowrap">{fmtPrice(m.output)}</td>
                      <td className="right num nowrap hide-sm">{fmtCost(callCost(m, 1000, 500))}</td>
                      <td className="right num nowrap table__primary">$0</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <p className="small muted" style={{ marginTop: -8 }}>
            Claude Haiku 5.5 has a second rate for prompts above 100,000 tokens ($0.50 in, $2.50 out), the same as the provider charges. The model price has no markup; when the calls are paid, the usual Purser fee of 0.1% applies to that payment, as on every payment.
          </p>

          <section aria-label="How a call is paid" style={{ marginTop: 24 }}>
            <SectionHead eyebrow="How a call is paid" title="Four steps, every call." />
            <Reveal>
              <ol className="cells cells--4">
                {steps.map((s, i) => (
                  <li className="cell" key={s.title}>
                    <div className="row row--between">
                      <span className="card__icon">
                        <s.icon size={18} />
                      </span>
                      <span className="step-no">0{i + 1}</span>
                    </div>
                    <h3 className="h3">{s.title}</h3>
                    <p className="small muted">{s.text}</p>
                  </li>
                ))}
              </ol>
            </Reveal>
          </section>

          <div className="cells cells--2">
            <section className="cell" aria-label="Budgets per model">
              <span className="card__icon">
                <IconSliders size={18} />
              </span>
              <h2 className="h3">Budgets per model</h2>
              <p className="small muted">
                The owner caps what an agent may spend on each model per day and per task. When the cheapest model has used its budget, a request for a level moves to the next model up. A request for that exact model is refused with the reason.
              </p>
            </section>
            <section className="cell" aria-label="Cost you can see">
              <span className="card__icon">
                <IconChart size={18} />
              </span>
              <h2 className="h3">Cost you can see</h2>
              <p className="small muted">
                Every payment is a receipt with the model and the tokens. The books show cost per model and per task, and every call adds to the open price index of AI work on the network page.
              </p>
            </section>
          </div>

          <CodeTabs samples={samples} title="Works with the OpenAI format your agent already uses" />

          <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
            <Link href="/docs#models" className="link-arrow">
              Models at cost in the docs
              <IconArrowRight size={15} />
            </Link>
            <Link href="/app/open" className="link-arrow">
              Open an agent account
              <IconArrowRight size={15} />
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
