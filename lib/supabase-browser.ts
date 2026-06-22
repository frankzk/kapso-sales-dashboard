"use client";

// Browser Supabase client for Client Components (login, interactive selectors).
// Uses only NEXT_PUBLIC_ vars (referenced statically so Next can inline them).

import { createBrowserClient } from "@supabase/ssr";

export function createBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
