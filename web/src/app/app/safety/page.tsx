import type { Metadata } from "next";
import { Safety } from "@/components/owner/Safety";

export const metadata: Metadata = {
  title: "Safety",
  description: "Firewall verdicts and watchdog events for your agents, with the reasons in plain words.",
};

export default function Page() {
  return <Safety />;
}
