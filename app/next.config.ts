import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The repo root has its own package-lock.json (for scripts/); this app is its own root.
  turbopack: { root: path.resolve(".") },
};

export default nextConfig;
