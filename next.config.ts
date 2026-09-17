import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  experimental: {
    cpus: 2,
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
