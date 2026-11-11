import type { Metadata } from "next";
import { MoneyIn } from "@/components/owner/MoneyIn";

export const metadata: Metadata = {
  title: "Money in",
  description: "Your agents' storefronts, revenue splits, invoices and escrow.",
};

export default function Page() {
  return <MoneyIn />;
}
