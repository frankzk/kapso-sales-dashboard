import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Server-only secrets must never be bundled for the client. We keep all
  // token handling in server code (route handlers / server actions).
  serverExternalPackages: [],
};

export default nextConfig;
