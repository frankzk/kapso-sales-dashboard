import { createAdminSupabase, createServerSupabase } from "@/lib/db";

// Suelta la reserva de un lead cuando la pestaña se cierra o se recarga.
//
// Es el gemelo de /api/envios/release-claim y existe por la misma razón: el
// cajón libera al cerrarse (`releaseLead`), pero un F5 o cerrar la pestaña no
// pasan por ahí, y lo único que sobrevive a la descarga de la página es
// `navigator.sendBeacon`, que no puede invocar una acción de servidor.
//
// Medido el 14-09-2026: 459 reservas vencidas sin soltar contra 11 vivas. Sin
// esto no hacía daño visible porque el TTL las ignora al leer. Con el tope de
// MAX_OPEN_LEADS sí lo haría: cerrar dos pestañas sin pasar por «Cerrar»
// dejaría a la asesora bloqueada diez minutos por dos leads que ya no mira.
//
// La guarda es la misma que en la acción: solo se suelta una reserva PROPIA.

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
  let leadId: unknown;
  try {
    leadId = (JSON.parse(raw) as { leadId?: unknown } | null)?.leadId;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof leadId !== "string" || !UUID.test(leadId)) {
    return new Response(null, { status: 400 });
  }

  const admin = createAdminSupabase();
  await admin
    .from("leads")
    .update({ claimed_by: null, claimed_at: null })
    .eq("id", leadId)
    .eq("claimed_by", userId);

  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
