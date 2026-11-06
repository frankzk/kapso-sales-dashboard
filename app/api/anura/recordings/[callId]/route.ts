import { NextResponse, type NextRequest } from "next/server";
import { anuraRecordingAccessFor } from "@/lib/anura/server";

// La grabación de una llamada de Anura, servida desde el MISMO origen (MOM
// §8.7). La CSP no tiene Supabase en media-src (cae en `default-src 'self'`),
// así que un `<audio>` con la URL firmada de Storage quedaba bloqueado. Esta
// ruta comprueba quién la pide (quien hizo la llamada o quien ve la tienda del
// pedido, por RLS, como el historial) y copia los bytes desde el bucket
// privado `anura-recordings`, pasando el `Range` para que el reproductor pueda
// adelantar (Safari no reproduce sin 206). La URL firmada nunca sale del
// servidor.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGE_RE = /^bytes=\d*-\d*$/;
const PASS_HEADERS = ["content-length", "content-range", "last-modified", "etag"] as const;

export async function GET(req: NextRequest, ctx: { params: Promise<{ callId: string }> }) {
  const { callId } = await ctx.params;
  const access = await anuraRecordingAccessFor(callId);
  if (!access.ok) {
    return new NextResponse(access.status === 401 ? "unauthorized" : "not found", { status: access.status, headers: { "cache-control": "no-store" } });
  }

  const range = req.headers.get("range");
  let upstream: Response;
  try {
    upstream = await fetch(access.signedUrl, {
      headers: range && RANGE_RE.test(range) ? { range } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return new NextResponse("upstream error", { status: 502, headers: { "cache-control": "no-store" } });
  }
  if (upstream.status === 416) {
    await upstream.body?.cancel().catch(() => {});
    return new NextResponse(null, { status: 416, headers: { "content-range": upstream.headers.get("content-range") ?? "bytes */0" } });
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    return new NextResponse("recording unavailable", { status: upstream.status === 404 ? 404 : 502, headers: { "cache-control": "no-store" } });
  }

  // Se sirve desde ESTE origen: solo un tipo de audio; cualquier otro, mp3.
  const rawCt = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const headers = new Headers({
    "content-type": /^audio\/[a-z0-9.+-]+$/.test(rawCt) ? rawCt : "audio/mpeg",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "accept-ranges": "bytes",
    // Privada (por persona) y corta: como la URL firmada que reemplaza.
    "cache-control": "private, max-age=300",
  });
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
}
