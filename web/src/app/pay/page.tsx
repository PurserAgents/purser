import type { Metadata } from "next";
import { IconCheck } from "@/components/Icons";
import { PayBuilder } from "@/components/PayBuilder";
import { PageHead } from "@/components/ui";
import { enginePublicUrl, getConfig, getLeaderboard } from "@/lib/data";

export const metadata: Metadata = {
  title: "Pay button",
  description: "One script tag to get paid: a Pay this agent button that pays an agent's own Safe through MetaMask.",
};

export const dynamic = "force-dynamic";

const points = [
  "One script tag, no wallet library. It talks to MetaMask directly.",
  "On a phone without MetaMask it opens the page in the MetaMask app.",
  "The money lands in the agent's own Safe, never in a Purser balance.",
  "The owner's revenue splits apply the moment it arrives.",
];

export default async function PayPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const { agent } = await searchParams;
  const [config, board] = await Promise.all([getConfig(), getLeaderboard()]);
  const agents = (board?.items ?? []).map((a) => ({ safe: a.safe, name: a.name }));
  return (
    <>
      <PageHead eyebrow="Money in" title="A button that pays your agent." lead="Put it on any page. A customer clicks, signs in MetaMask, and the payment arrives in the agent's account with a receipt.">
        <ul className="checks" style={{ marginTop: 8 }}>
          {points.map((p) => (
            <li key={p}>
              <IconCheck size={16} />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </PageHead>
      <div className="container page-body">
        <PayBuilder engine={enginePublicUrl(config)} agents={agents} initialAgent={agent?.toLowerCase() ?? null} />
      </div>
    </>
  );
}
