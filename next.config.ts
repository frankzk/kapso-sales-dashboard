import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Server-only secrets must never be bundled for the client. We keep all
  // token handling in server code (route handlers / server actions).
  serverExternalPackages: [],
  // Advisors send a (client-resized) image over WhatsApp via a server action;
  // the default Server Actions body limit (~1MB) is too small for a photo.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
};

export default nextConfig;
