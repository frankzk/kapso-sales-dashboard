// Supabase clients. SERVER-ONLY module — do not import from client components.
//   - createServerSupabase(): RLS-scoped, reads the user session from cookies.
//     Use in Server Components, Route Handlers and Server Actions for reads.
//   - createAdminSupabase(): service-role, BYPASSES RLS. Use only in trusted
//     ingestion paths (webhooks, cron) for writes.

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/** RLS-scoped client bound to the current request's auth cookies. */
export async function createServerSupabase(): Promise<SupabaseClient> {
  // Imported dynamically so that admin-only consumers (cron, webhooks, tests)
  // can use createAdminSupabase() without pulling in the next/headers runtime.
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl(), env.supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component where cookies are read-only.
          // Session refresh is handled by middleware, so this is safe to ignore.
        }
      },
    },
  });
}

let _admin: SupabaseClient | null = null;

/** Service-role client. Bypasses RLS — keep to server-side ingestion only. */
export function createAdminSupabase(): SupabaseClient {
  if (_admin) return _admin;
  _admin = createClient(env.supabaseUrl(), env.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}
