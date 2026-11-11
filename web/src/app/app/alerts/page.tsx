import type { Metadata } from "next";
import { Alerts } from "@/components/owner/Alerts";

export const metadata: Metadata = {
  title: "Alerts",
  description: "Alerts per agent and signed webhooks for every event.",
};

export default function Page() {
  return <Alerts />;
}
