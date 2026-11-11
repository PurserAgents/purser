import type { Metadata } from "next";
import { AgentDetail } from "@/components/owner/AgentDetail";

export const metadata: Metadata = {
  title: "Agent",
  description: "One agent account: balances, rules, top up, freeze, the agent key, passkey approvals, recovery and receipts.",
};

export default async function OwnerAgentPage({ params }: { params: Promise<{ safe: string }> }) {
  const { safe } = await params;
  return <AgentDetail safe={safe.toLowerCase()} />;
}
