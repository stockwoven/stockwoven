import path from "node:path";
import createMDX from "@next/mdx";
import type { NextConfig } from "next";

// The browser only talks to this site and the Solana RPC (HTTPS for requests, WSS for the
// confirmation subscriptions). Fonts, data and images are all served from here.
const rpc = new URL(process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com");
const rpcOrigins = [rpc.origin, `${rpc.protocol === "https:" ? "wss:" : "ws:"}//${rpc.host}`];
const dev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  // Next.js bootstraps with inline scripts; the dev server also needs eval for fast refresh.
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ${rpcOrigins.join(" ")}${dev ? " ws:" : ""}`,
  // No other site may frame the app: a framed page can trick a visitor into approving a transaction.
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  // Wallet extensions don't need popups to share this window, but a web wallet's popup may.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  // HTTPS only from the first visit on. Browsers ignore it over plain HTTP.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // A self-contained server (.next/standalone/server.js) for deploying behind nginx; see deploy/README.md.
  output: "standalone",
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  // The repo root has its own package-lock.json (for scripts/); this app is its own root.
  turbopack: { root: path.resolve(".") },
  // `next dev` blocks its scripts for hosts other than localhost. To open the dev server from
  // another computer, list the address it uses: ALLOWED_DEV_ORIGINS=192.168.3.32 npm run dev
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS ?? "").split(",").filter(Boolean),
};

// Plugins are named as strings so Turbopack can serialize them.
export default createMDX({ options: { remarkPlugins: [["remark-gfm", {}]] } })(nextConfig);
