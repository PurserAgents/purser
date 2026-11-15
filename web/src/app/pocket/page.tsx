import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Pocket } from "@/components/pocket/Pocket";

export const metadata: Metadata = {
  title: "Purser in your pocket",
  description: "Your agents' money on your phone. Approve with Face ID, watch every payment as it happens, and freeze any agent with one tap.",
  appleWebApp: { capable: true, title: "Purser", statusBarStyle: "default" },
  alternates: { canonical: "/pocket" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0c" },
  ],
};

export default function PocketPage() {
  return (
    <Suspense fallback={<div className="pocket" />}>
      <Pocket />
    </Suspense>
  );
}
