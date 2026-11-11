import type { Metadata } from "next";
import { MoneyOut } from "@/components/owner/MoneyOut";

export const metadata: Metadata = {
  title: "Money out",
  description: "Streams and subscriptions your agents pay, inside their rules. Stop or cancel any of them.",
};

export default function Page() {
  return <MoneyOut />;
}
