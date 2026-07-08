import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/db";

export const dynamic = "force-dynamic";

// Exchanges the OAuth / magic-link `code` for a session, then redirects.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");

  // Only allow same-origin, path-only redirects. A raw `next` like `//evil.com`
  // or `https://evil.com` would otherwise resolve off-origin via `new URL()`,
  // giving an unauthenticated open redirect (phishing). proxy.ts only ever sets
  // `redirectedFrom` to a bare pathname, so this costs nothing legitimate.
  const raw =
    url.searchParams.get("redirectedFrom") ?? url.searchParams.get("next") ?? "/dashboard";
  const next = /^\/(?!\/)/.test(raw) ? raw : "/dashboard";

  if (code) {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    // A failed exchange (expired/replayed link) must not pretend to log in.
    if (error) {
      return NextResponse.redirect(new URL("/login?error=auth", url.origin));
    }
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
