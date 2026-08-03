import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { publicClient } from "@/lib/shalom/session";
import { describeShalomError } from "@/lib/shalom/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sonda de rastreo: la MISMA guía por los DOS caminos, en una sola petición.
//
// POR QUÉ EXISTE. El cron devolvió, para las 92 guías, el mismo error del
// upstream de Shalom: «Ingrese un código de orden». Eso NO es "no encuentro esa
// guía" —es "me llegó el campo vacío"—, y se contradice con lo comprobado a
// mano: la guía 89892640 existe en pro.shalom.pe y está En destino. O sea que el
// número es bueno y algo se pierde por el camino.
//
// Con solo el batch no se puede separar la causa: puede ser el sobre del batch
// (nombre del campo, forma del item) o el rastreo entero. Pedir la misma guía
// por el endpoint de una sola lo resuelve de un tiro:
//
//   * si `single` responde y `batch` no  → el problema es el sobre del batch
//   * si fallan los dos igual            → es el rastreo, no cómo lo pedimos
//   * si responden los dos               → era pasajero y el cron ya se arregla solo
//
// Devuelve la respuesta CRUDA a propósito: interpretarla acá sería tapar justo
// el detalle que se está buscando.
//
// No escribe nada. Es de solo lectura y por eso se puede lanzar sin miedo.

function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

/** Lo que devolvió una vía, sin interpretar. */
async function attempt(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: true, respuesta: await run() };
  } catch (err) {
    return { ok: false, error: describeShalomError(err) };
  }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });
  if (!env.shalomConfigured()) {
    return NextResponse.json({ ok: false, error: "SHALOM_API_KEY no configurada" }, { status: 400 });
  }

  // Sin `numero` se toma una guía real de la base: la gracia de la sonda es que
  // se pueda lanzar desde el navegador sin tener que buscar un número antes.
  let numero = req.nextUrl.searchParams.get("numero")?.trim() ?? "";
  if (!numero) {
    const admin = createAdminSupabase();
    const { data } = await admin
      .from("shipments")
      .select("guide_code")
      .eq("courier", "shalom")
      .not("guide_code", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    numero = (data as { guide_code?: string } | null)?.guide_code ?? "";
  }
  if (!numero) {
    return NextResponse.json({ ok: false, error: "No hay ninguna guía de Shalom que sondear." });
  }

  const client = publicClient();
  const single = await attempt(() => client.track(numero));
  const batch = await attempt(() => client.trackBatch([{ custom_id: "sonda", numero }]));

  return NextResponse.json({
    ok: true,
    numero,
    single,
    batch,
    cupo: client.rateLimit,
  });
}
