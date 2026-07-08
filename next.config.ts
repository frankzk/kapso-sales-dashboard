import type { NextConfig } from "next";

// App-wide security response headers. CSP is intentionally permissive on
// scripts/styles ('unsafe-inline') because the app relies on Next/React inline
// runtime + Tailwind; tighten to nonces later. `frame-ancestors 'none'` blocks
// clickjacking; `connect-src` allows the Supabase project; media is same-origin
// (proxied), so 'self' + data:/blob: covers images.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co https://*.supabase.in wss://*.supabase.co",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  { key: "Content-Security-Policy", value: CSP },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework/version.
  poweredByHeader: false,
  // Server-only secrets must never be bundled for the client. We keep all
  // token handling in server code (route handlers / server actions).
  serverExternalPackages: [],
  // Advisors send a (client-resized) image over WhatsApp via a server action;
  // the default Server Actions body limit (~1MB) is too small for a photo.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
