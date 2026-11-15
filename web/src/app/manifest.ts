import type { MetadataRoute } from "next";

/** Purser in your pocket: the installable phone app (Add to Home Screen opens /pocket full screen). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/pocket",
    name: "Purser",
    short_name: "Purser",
    description: "Your agents' money on your phone. Approve with Face ID, watch every payment as it happens, freeze with one tap.",
    start_url: "/pocket",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/pocket/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pocket/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pocket/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
