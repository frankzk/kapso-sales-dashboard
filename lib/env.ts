// Centralised, lazily-evaluated environment access. Functions (not eager
// constants) so importing this module never throws during build when a given
// secret is absent — it only throws at the call site that actually needs it.

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export const env = {
  // --- public (safe for browser) ---
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  siteUrl: () =>
    (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, ""),

  // --- server-only secrets ---
  serviceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  encryptionKey: () => required("ENCRYPTION_KEY"),
  cronSecret: () => required("CRON_SECRET"),

  // --- non-secret runtime config ---
  shopifyApiVersion: () => process.env.SHOPIFY_API_VERSION ?? "2025-01",
  kapsoApiBase: () =>
    (process.env.KAPSO_API_BASE ?? "https://api.kapso.ai/platform/v1").replace(/\/$/, ""),
};
