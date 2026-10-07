import type { Metadata, Viewport } from "next";
import "@/design-system/stockwoven-design-system/css/fonts.css";
import "@/design-system/stockwoven-design-system/css/tokens.css";
import "@/design-system/stockwoven-design-system/css/components.css";
import "./globals.css";
import { colorToken } from "@/lib/tokens";

export const metadata: Metadata = {
  title: "Stockwoven",
  description: "One stock. One token. The Stockwoven vault on Solana devnet, over a Meteora DAMM v2 cross-issuer pool.",
  icons: {
    icon: [
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/icons/apple-touch-icon.png", sizes: "180x180" },
  },
};

export const viewport: Viewport = {
  themeColor: colorToken("brand-ivory"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
