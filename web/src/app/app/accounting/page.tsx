import type { Metadata } from "next";
import { Accounting } from "@/components/owner/Accounting";

export const metadata: Metadata = {
  title: "Accounting",
  description: "Profit and loss per agent, cost per task and per model, revenue per customer, CSV export.",
};

export default function Page() {
  return <Accounting />;
}
