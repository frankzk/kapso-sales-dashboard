import { createServerSupabase } from "@/lib/db";
import { parseClientPerformanceMetric } from "@/lib/performance-metrics";

export async function POST(req: Request) {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > 4_096) return new Response(null, { status: 413 });

  const sb = await createServerSupabase();
  const { data } = await sb.auth.getClaims();
  if (!data?.claims?.sub) return new Response(null, { status: 401 });

  const raw = await req.text();
  if (raw.length > 4_096) return new Response(null, { status: 413 });
  const body = (() => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  })();
  const metric = parseClientPerformanceMetric(body);
  if (!metric) return new Response(null, { status: 400 });

  console.info("[Kapso performance]", JSON.stringify({
    ...metric,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "local",
  }));
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
