import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/db";

export const dynamic = "force-dynamic";

// Exchanges the OAuth / magic-link `code` for a session, then redirects.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next =
    url.searchParams.get("redirectedFrom") ?? url.searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createServerSupabase();
    await supabase.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
