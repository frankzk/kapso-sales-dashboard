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

  // Follow redirects MANUALLY: Kapso often 302s to a storage CDN, and the
  // store's Kapso key must NOT be sent to a non-allowlisted host (undici keeps
  // custom headers across cross-origin redirects). Only attach X-API-Key while
  // the current host is still on the allowlist.
  const MAX_REDIRECTS = 5;
  const MAX_BYTES = 25 * 1024 * 1024; // ceiling for a single WhatsApp media blob
  let current = target;
  let upstream: Response;
  try {
    let hops = 0;
    for (;;) {
      const onAllowlist = ALLOWED_HOSTS.has(current.hostname);
      upstream = await fetch(current.toString(), {
        headers: onAllowlist ? { "X-API-Key": creds.kapso_api_key } : {},
        redirect: "manual",
      });
      if (upstream.status < 300 || upstream.status >= 400) break;
      const loc = upstream.headers.get("location");
      if (!loc || hops >= MAX_REDIRECTS) return new NextResponse("too many redirects", { status: 502 });
      let nextUrl: URL;
      try {
        nextUrl = new URL(loc, current);
      } catch {
        return new NextResponse("bad redirect", { status: 502 });
      }
      if (nextUrl.protocol !== "https:") return new NextResponse("forbidden redirect", { status: 502 });
      current = nextUrl;
      hops += 1;
    }
  } catch {
    return new NextResponse("upstream error", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new NextResponse("media unavailable", { status: upstream.status === 404 ? 404 : 502 });
  }

  // Size ceiling when the upstream declares one (bandwidth/cost DoS guard).
  const declared = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return new NextResponse("media too large", { status: 413 });
  }

  // The blob is served from THIS origin, so an attacker-influenced content-type
  // (text/html, image/svg+xml) could execute inline. Only pass through a safe
  // media allowlist; anything else becomes an opaque download. `nosniff` stops
  // the browser from second-guessing us.
  const rawCt = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const safeCt = /^(image\/(png|jpe?g|gif|webp|bmp)|audio\/|video\/|application\/pdf)$/.test(rawCt)
    ? rawCt
    : "application/octet-stream";

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": safeCt,
      "x-content-type-options": "nosniff",
      // Private (per-user) + short cache so re-opening the drawer is instant
      // without persisting media in shared caches.
      "cache-control": "private, max-age=3600",
    },
  });
}
