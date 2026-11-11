import type { Metadata } from "next";
import { Treasury } from "@/components/owner/Treasury";

export const metadata: Metadata = {
  title: "Treasury",
  description: "Idle money of your agents in on-chain vaults, straight from their own Safes.",
};

export default function Page() {
  return <Treasury />;
}
