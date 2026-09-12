import { createAdminSupabase, createServerSupabase } from "@/lib/db";

// Suelta la reserva de una guía cuando la pestaña se cierra o se recarga.
//
// POR QUÉ UNA RUTA Y NO LA ACCIÓN DE SERVIDOR. El panel de Envíos libera su
// reserva al cerrarse (`releaseShipment`), pero un F5 o cerrar la pestaña no
// pasan por ahí: la página se descarga y con ella cualquier fetch en vuelo. Lo
// único que sobrevive a la descarga es `navigator.sendBeacon`, y un beacon no
// puede invocar una acción de servidor. Mientras tanto la guía quedaba
// bloqueada para el resto del equipo hasta agotar el TTL de diez minutos.
//
// La guarda es la misma que en la acción: solo se suelta una reserva PROPIA.
// El cuerpo del beacon no se firma, pero tampoco hace falta: quien lo manda es
// la sesión autenticada por cookie, y lo peor que puede hacer es soltar lo suyo.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > 1_024) return new Response(null, { status: 413 });

  const sb = await createServerSupabase();
  const { data } = await sb.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return new Response(null, { status: 401 });

  const raw = await req.text();
  if (raw.length > 1_024) return new Response(null, { status: 413 });
  let shipmentId: unknown;
  try {
    shipmentId = (JSON.parse(raw) as { shipmentId?: unknown } | null)?.shipmentId;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof shipmentId !== "string" || !UUID.test(shipmentId)) {
    return new Response(null, { status: 400 });
  }

  const admin = createAdminSupabase();
  await admin
    .from("shipments")
    .update({ claimed_by: null, claimed_at: null })
    .eq("id", shipmentId)
    .eq("claimed_by", userId);

  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
