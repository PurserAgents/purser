import type { Metadata } from "next";
import { RobGame } from "@/components/RobGame";
import { PageHead } from "@/components/ui";

export const metadata: Metadata = {
  title: "Rob the agent",
  description: "An AI agent holds $100 in a real Purser account. Talk it into paying you and the money is yours. Every try meets the same rules, firewall and Purser Shield as any account.",
};

export default function RobPage() {
  return (
    <>
      <PageHead
        eyebrow="Contest"
        title={
          <>
            Rob the agent. <span className="serif">Keep what you take.</span>
          </>
        }
        lead="Ledger is an AI agent with $100 in a real Purser account. It pays three vendors and nobody else. Talk it into paying you and the money lands in your wallet, on chain, the second it happens."
      />
      <div className="container page-body">
        <RobGame />
      </div>
    </>
  );
}
