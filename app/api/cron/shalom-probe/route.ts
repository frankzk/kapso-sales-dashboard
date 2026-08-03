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
  // Se traen los tres identificadores porque los tres se van a probar.
  const admin = createAdminSupabase();
  const pedido = req.nextUrl.searchParams.get("numero")?.trim() ?? "";
  const query = admin
    .from("shipments")
    .select("guide_code,shalom_codigo,shalom_ose_id")
    .eq("courier", "shalom")
    .not("guide_code", "is", null);
  const { data } = pedido
    ? await query.eq("guide_code", pedido).maybeSingle()
    : await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  const guia = data as {
    guide_code?: string | null;
    shalom_codigo?: string | null;
    shalom_ose_id?: number | null;
  } | null;

  const numero = guia?.guide_code ?? pedido;
  if (!numero) {
    return NextResponse.json({ ok: false, error: "No hay ninguna guía de Shalom que sondear." });
  }

  const client = publicClient();

  // Los tres identificadores, uno a uno.
  //
  // `single` y `batch` fallaron IGUAL —el mismo 422 «Ingrese un código de
  // orden»—, así que el sobre del batch queda descartado: no es cómo montamos la
  // petición. Lo que no se sabe todavía es si `numero` es el parámetro que el
  // rastreo espera. Probar los tres separa las dos únicas explicaciones que
  // quedan: si alguno responde, el nuestro estaba mal; si fallan los tres con el
  // mismo error, es su servicio y no hay nada que arreglar de este lado.
  const porIdentificador: Record<string, unknown> = {
    numero: await attempt(() => client.trackBy("numero", numero)),
  };
  if (guia?.shalom_codigo) {
    porIdentificador.codigo = await attempt(() => client.trackBy("codigo", guia.shalom_codigo!));
  }
  if (guia?.shalom_ose_id) {
    porIdentificador.ose_id = await attempt(() =>
      client.trackBy("ose_id", String(guia.shalom_ose_id)),
    );
  }

  const batch = await attempt(() => client.trackBatch([{ custom_id: "sonda", numero }]));

  return NextResponse.json({
    ok: true,
    guia: { numero, codigo: guia?.shalom_codigo ?? null, ose_id: guia?.shalom_ose_id ?? null },
    porIdentificador,
    batch,
    cupo: client.rateLimit,
  });
}
