import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // We fetch videos + GIFs from github.com release asset URLs. Allowlisted for <Image>.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "github.com" },
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
      { protocol: "https", hostname: "objects.githubusercontent.com" },
    ],
  },
  experimental: { typedRoutes: true },
};

export default nextConfig;
