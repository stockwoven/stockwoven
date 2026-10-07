import path from "node:path";
import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
