import type { Metadata } from "next";
import { Approvals } from "@/components/owner/Approvals";

export const metadata: Metadata = {
  title: "Approvals",
  description: "Payments waiting for the owner: approve or reject with your wallet or a passkey, checked on chain.",
};

export default function Page() {
  return <Approvals />;
}
