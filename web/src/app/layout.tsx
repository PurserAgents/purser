import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { RouteFade } from "@/components/RouteFade";
import { themeScript } from "@/components/ThemeToggle";
import { LiveProvider } from "@/components/Live";
import { WalletProvider } from "@/components/Wallet";
import { site } from "@/lib/site";
import "./globals.css";
import "./product.css";

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: `${site.name}: ${site.tagline}`, template: `%s | ${site.name}` },
  description: site.description,
  applicationName: site.name,
  openGraph: {
    type: "website",
    siteName: site.name,
    title: `${site.name}: ${site.tagline}`,
    description: site.description,
    url: site.url,
  },
  twitter: { card: "summary_large_image", title: `${site.name}: ${site.tagline}`, description: site.description },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // light on every first visit; ThemeToggle repaints it when the visitor picks dark
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="preload" href="/fonts/geist.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body>
        <a href="#main" className="skip">
          Skip to content
        </a>
        <LiveProvider>
          <WalletProvider>
            <RouteFade />
            <Header />
            <main id="main">{children}</main>
            <Footer />
          </WalletProvider>
        </LiveProvider>
      </body>
    </html>
  );
}
