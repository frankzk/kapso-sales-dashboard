import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";

// Streams a WhatsApp media blob (Yape voucher, product photo) from Kapso through
// the dashboard so the browser never needs Kapso credentials and the file stays
// behind login + RLS. Needs the service-role client (token decrypt) → Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only ever relay Kapso-hosted media. `app.kapso.ai` serves the stored blob
// (the `media_url`); `api.kapso.ai` covers any future API-hosted variant. The
// initial redirect may hop to a storage CDN — `redirect: follow` handles that.
const ALLOWED_HOSTS = new Set(["app.kapso.ai", "api.kapso.ai"]);

export async function GET(req: NextRequest, ctx: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await ctx.params;
  const raw = req.nextUrl.searchParams.get("u");
  if (!raw) return new NextResponse("missing url", { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new NextResponse("bad url", { status: 400 });
  }
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    return new NextResponse("forbidden host", { status: 400 });
  }

  // Authorize: the caller must be able to SEE this lead under RLS (so only the
  // store's own users can pull its conversation media).
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });
  const { data: lead } = await sb.from("leads").select("store_id").eq("id", leadId).maybeSingle();
  if (!lead) return new NextResponse("forbidden", { status: 403 });

  const creds = await getStoreCreds((lead as { store_id: string }).store_id);
  if (!creds?.kapso_api_key) return new NextResponse("kapso not configured", { status: 404 });

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      headers: { "X-API-Key": creds.kapso_api_key },
      redirect: "follow",
    });
  } catch {
    return new NextResponse("upstream error", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new NextResponse("media unavailable", { status: upstream.status === 404 ? 404 : 502 });
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      // Private (per-user) + short cache so re-opening the drawer is instant
      // without persisting media in shared caches.
      "cache-control": "private, max-age=3600",
    },
  });
}
