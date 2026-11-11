import type { Metadata } from "next";
import { Teams } from "@/components/owner/Teams";

export const metadata: Metadata = {
  title: "Teams",
  description: "Agent organisations: a shared treasury, departments with budgets, members and the org chart.",
};

export default function Page() {
  return <Teams />;
}
