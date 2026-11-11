import type { Metadata } from "next";
import { PageHead } from "@/components/ui";

export const metadata: Metadata = {
  title: "Own risk",
  description: "Purser is software, not a bank. No custody, no advice. Use at your own risk.",
};

const points = [
  {
    title: "Software, not a bank",
    text: "Purser is a set of smart contracts and tools. It is not a bank, a payment institution, a broker or a card issuer, and it offers no deposit protection.",
  },
  {
    title: "No custody",
    text: "Purser never holds your funds. They sit in a Safe that you own and control with your own wallet. If you lose access to your wallet and have set no recovery key, nobody can restore it for you.",
  },
  {
    title: "No advice",
    text: "Nothing on this site or in the product is financial, legal or tax advice. Rule templates and defaults are starting points, not recommendations.",
  },
  {
    title: "Agents make mistakes",
    text: "AI agents can be wrong, and they can be manipulated. Rules, the firewall and the watchdog reduce what can go wrong. They cannot rule out every loss. Set limits you can afford.",
  },
  {
    title: "Smart contracts and the chain",
    text: "Smart contracts can contain bugs. Transactions on chain are final and cannot be reversed. The network, the tokens and the services your agent pays can fail or change.",
  },
  {
    title: "Your responsibility",
    text: "You decide what your agent may do and you are responsible for it, including the laws and taxes that apply to you where you live.",
  },
  {
    title: "No warranty",
    text: "The software is provided as it is, without warranty of any kind. You use it at your own risk.",
  },
];

export default function OwnRiskPage() {
  return (
    <>
      <PageHead
        eyebrow="Own risk"
        title="Use Purser at your own risk."
        lead="Purser is software, not a bank. It never holds your funds and gives no advice. Please read this page before you put money in an agent's account."
      />
      <div className="container page-body">
        <div className="cells cells--2">
          {points.map((point, index) => (
            <section className="cell" key={point.title}>
              <span className="step-no">{String(index + 1).padStart(2, "0")}</span>
              <h2 className="h3">{point.title}</h2>
              <p className="small muted">{point.text}</p>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
