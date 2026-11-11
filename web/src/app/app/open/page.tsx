import type { Metadata } from "next";
import { OpenAccount } from "@/components/owner/OpenAccount";

export const metadata: Metadata = {
  title: "Open an agent account",
  description: "Open an account for an AI agent: a Safe you own with the Purser rules, one transaction from MetaMask.",
};

export default function OpenPage() {
  return <OpenAccount />;
}
