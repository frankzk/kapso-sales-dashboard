import { createAdminSupabase, createServerSupabase } from "@/lib/db";

// Suelta el candado de un caso de Repro Lima cuando la pestaña se cierra o se
// recarga (MOM §9.5, D10).
//
// POR QUÉ UNA RUTA Y NO LA ACCIÓN DE SERVIDOR. La hoja suelta su candado al
// cerrarse (`releaseReproCase`), pero un F5 o cerrar la pestaña no pasan por
// ahí: lo único que sobrevive a la descarga es `navigator.sendBeacon`, y un
// beacon no puede invocar una acción de servidor. Es la misma ruta que la de
// Envíos (app/api/envios/release-claim/route.ts).
//
// La guarda es la misma que en la acción: solo se suelta un candado PROPIO de
// un caso abierto. El cuerpo no se firma, pero tampoco hace falta: quien lo
// manda es la sesión autenticada por cookie, y lo peor que puede hacer es
// soltar lo suyo.

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
  let caseId: unknown;
  try {
    caseId = (JSON.parse(raw) as { caseId?: unknown } | null)?.caseId;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof caseId !== "string" || !UUID.test(caseId)) {
    return new Response(null, { status: 400 });
  }

  const admin = createAdminSupabase();
  await admin
    .from("lima_repro_cases")
    .update({ claimed_by: null, claimed_until: null })
    .eq("id", caseId)
    .eq("claimed_by", userId)
    .is("closed_at", null);

  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
