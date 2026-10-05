import path from "node:path";
import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  // The repo root has its own package-lock.json (for scripts/); this app is its own root.
  turbopack: { root: path.resolve(".") },
};

// Plugins are named as strings so Turbopack can serialize them.
export default createMDX({ options: { remarkPlugins: [["remark-gfm", {}]] } })(nextConfig);
