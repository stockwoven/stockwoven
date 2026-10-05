import type { MetadataRoute } from "next";
import { colorToken } from "@/lib/tokens";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Stockwoven",
    short_name: "Stockwoven",
    description: "One stock. One token. The Stockwoven vault on Solana devnet.",
    start_url: "/",
    display: "standalone",
    background_color: colorToken("brand-ivory"),
    theme_color: colorToken("brand-ivory"),
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
