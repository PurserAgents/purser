import type { Metadata } from "next";
import { Overview } from "@/components/owner/Overview";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your agents and their money: balances, spending against the rules, approvals and every receipt. Freeze any agent at once.",
};

export default function DashboardPage() {
  return <Overview />;
}
