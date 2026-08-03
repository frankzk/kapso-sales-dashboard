import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { loadStoreShalom, publicClient, readWithFreshSession } from "@/lib/shalom/session";
import { describeShalomError } from "@/lib/shalom/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// El modo `?buscar=` consulta la CUENTA, y eso puede pagar el login de ~90 s si
// la sesión está fría. Con los 60 de antes se cortaba justo en ese caso.
export const maxDuration = 300;

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

/**
 * ¿Existen estas guías en la cuenta de Shalom Pro?
 *
 * Cada guía se consulta con las credenciales de SU tienda: son cuentas
 * distintas y preguntar con la equivocada daría un "no existe" que no significa
 * nada. La guía tiene que estar en nuestra base — si no, no sabríamos de qué
 * cuenta preguntar.
 */
async function buscarEnLaCuenta(
  admin: ReturnType<typeof createAdminSupabase>,
  guias: string[],
): Promise<NextResponse> {
  const { data } = await admin
    .from("shipments")
    .select("guide_code,store_id,shalom_codigo,delivery_status")
    .eq("courier", "shalom")
    .in("guide_code", guias);
  const filas = (data ?? []) as {
    guide_code: string;
    store_id: string;
    shalom_codigo: string | null;
    delivery_status: string;
  }[];

  const resultado: Record<string, unknown> = {};
  for (const guia of guias) {
    const fila = filas.find((f) => f.guide_code === guia);
    if (!fila) {
      resultado[guia] = { enKapta: false, nota: "No está en nuestra base." };
      continue;
    }
    const store = await loadStoreShalom(admin, fila.store_id);
    if (!store?.shalom_pro_email) {
      resultado[guia] = { enKapta: true, error: "La tienda no tiene cuenta de Shalom Pro." };
      continue;
    }
    try {
      const orden = await readWithFreshSession(admin, fila.store_id, store, (client) =>
        client.findOrderByGuia(guia),
      );
      resultado[guia] = {
        enKapta: true,
        codigo: fila.shalom_codigo,
        estadoEnKapta: fila.delivery_status,
        // `existe: false` con la consulta hecha de verdad es un dato, no un
        // hueco: la guía NO está en la cuenta.
        existeEnShalom: Boolean(orden),
        orden: orden
          ? {
              id: (orden as { id?: number }).id,
              guia: (orden as { guia?: string }).guia,
              codigo: (orden as { codigo?: string }).codigo,
              status: (orden as { status?: number }).status,
              delivered: (orden as { delivered?: boolean }).delivered,
              created_at: (orden as { created_at?: string }).created_at,
            }
          : null,
      };
    } catch (err) {
      resultado[guia] = { enKapta: true, error: describeShalomError(err) };
    }
  }
  return NextResponse.json({ ok: true, buscadas: guias.length, resultado });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });
  if (!env.shalomConfigured()) {
    return NextResponse.json({ ok: false, error: "SHALOM_API_KEY no configurada" }, { status: 400 });
  }

  const admin = createAdminSupabase();

  // Modo `?buscar=guia1,guia2`: ¿existen esas guías EN LA CUENTA de Shalom Pro?
  //
  // Es la pregunta que el rastreo deja abierta. Un `not_found` del rastreo puede
  // ser "la borraron", "nunca llegó a emitirse" o "el rastreo todavía no la ve",
  // y cada una pide una acción distinta: rehacer la guía, buscar el paquete, o
  // esperar. Consultar el listado de la cuenta es lo mismo que haría una persona
  // entrando a pro.shalom.pe, y contesta de una.
  const buscar = (req.nextUrl.searchParams.get("buscar") ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (buscar.length) return buscarEnLaCuenta(admin, buscar);

  // Sin `numero` se toma una guía real de la base: la gracia de la sonda es que
  // se pueda lanzar desde el navegador sin tener que buscar un número antes.
  // Se traen los tres identificadores porque los tres se van a probar.
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

  // El batch, con las mismas combinaciones. En el endpoint de una sola quedó
  // claro que `numero` y `codigo` se reclaman el uno al otro y que `ose_id`
  // resuelve solo; falta confirmar que el batch se comporta igual, porque es el
  // que usa el cron y el que tuvo las 93 guías paradas.
  const batch: Record<string, unknown> = {
    solo_numero: await attempt(() => client.trackBatch([{ custom_id: "sonda", numero }])),
  };
  if (guia?.shalom_codigo) {
    batch.numero_y_codigo = await attempt(() =>
      client.trackBatch([{ custom_id: "sonda", numero, codigo: guia.shalom_codigo! }]),
    );
  }
  if (guia?.shalom_ose_id) {
    batch.solo_ose_id = await attempt(() =>
      // STRING, no el bigint de la base: como número devuelve 400 y tumba el lote.
      client.trackBatch([{ custom_id: "sonda", ose_id: String(guia.shalom_ose_id) }]),
    );
  }

  return NextResponse.json({
    ok: true,
    guia: { numero, codigo: guia?.shalom_codigo ?? null, ose_id: guia?.shalom_ose_id ?? null },
    porIdentificador,
    batch,
    cupo: client.rateLimit,
  });
}
