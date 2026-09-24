import type { NextConfig } from "next";
import { LEGACY_REDIRECTS } from "./src/lib/redirects";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  async redirects() {
    return LEGACY_REDIRECTS;
  },
};

export default nextConfig;
