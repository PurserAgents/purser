import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Pocket } from "@/components/pocket/Pocket";

export const metadata: Metadata = {
  title: "Statements",
  description: "What each of your agents spent, earned and was stopped from doing, day by day and week by week.",
  appleWebApp: { capable: true, title: "Purser", statusBarStyle: "default" },
  robots: { index: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f7f7f8",
};

export default function StatementPage() {
  return (
    <Suspense fallback={<div className="pocket" />}>
      <Pocket view="statement" />
    </Suspense>
  );
}
