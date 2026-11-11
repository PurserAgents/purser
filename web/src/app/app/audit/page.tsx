import type { Metadata } from "next";
import { Audit } from "@/components/owner/Audit";

export const metadata: Metadata = {
  title: "Audit trail",
  description: "Every action on your agents, signed and hash-chained, with export and verification.",
};

export default function Page() {
  return <Audit />;
}
