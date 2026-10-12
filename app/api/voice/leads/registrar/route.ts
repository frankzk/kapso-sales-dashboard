// Tool `registrar_resultado_lead` del agente de voz para leads (MOM §33).
//
// El agente la llama UNA vez, al final. Se ata a la llamada de lead EN CURSO
// (la del `voice_call_id` que recibió al conectar, o la única abierta) y
// escribe sobre el LEAD, nunca sobre un pedido: el agente no crea pedidos.
// «Quiere comprar» deja el lead en «Atender ahora» con los datos que tomó, y
// una asesora genera el pedido.
//
// En `mode = 'test'` no se escribe NADA sobre el lead: solo la fila.
//
//   POST https://<kapta>/api/voice/leads/registrar
//   x-voice-secret: <VOICE_LEADS_TOOLS_SECRET>
//   { voice_call_id, conversation_id, resultado, motivo?, distrito?, provincia?,
//     departamento?, direccion?, referencia?, nombre?, promo?, cantidad?,
//     fecha?, hora?, resumen }

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { translateLeadResult } from "@/lib/voice-leads";
import { bindLeadCall, leadToolAuthorized } from "@/lib/voice-leads-server";
import { applyLeadVoiceResult, type LeadApplySkip } from "@/lib/voice-leads-writeback";
import { readToolBody } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!leadToolAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 });
  }
  const body = await readToolBody(req);
  const admin = createAdminSupabase();
  const now = new Date();

  const bound = await bindLeadCall(admin, body.voice_call_id, "in_progress", now);
  if ("error" in bound) return NextResponse.json({ ok: false, error: bound.error });
  const call = bound.call;

  const action = translateLeadResult(body, now);
  if (action.kind === "invalid") {
    return NextResponse.json({ ok: false, error: action.error });
  }

  // Se toma la fila ANTES de escribir sobre el lead: si la línea avisa el
  // corte mientras se registra, el cierre por corte ve el `outcome` y no anota
  // un «no contestó» encima (el mismo pacto que `registrar_gestion`, §11.8).
  const { data: tomada } = await admin
    .from("voice_calls")
    .update({ outcome: action.outcome })
    .eq("id", call.id)
    .eq("status", "in_progress")
    .is("outcome", null)
    .select("id");
  if (!tomada?.length) {
    return NextResponse.json({ ok: false, error: "la llamada ya se registró o se cerró" });
  }

  let applied = false;
  let skipped: LeadApplySkip | null = null;
  let writeError: string | null = null;
  if (call.mode === "real") {
    const r = await applyLeadVoiceResult(admin, call, action, now);
    applied = r.applied;
    skipped = r.skipped;
    writeError = r.error;
  }

  const cierre = {
    status: writeError ? "failed" : "completed",
    outcome: action.outcome,
    // Solo lo traducido, NUNCA el cuerpo entero: un `no_llamar` suelto en
    // lo que mande el agente entraría a la lista «no llamar» de la tienda,
    // que comparten los dos agentes y lee `outcome_payload->>no_llamar`.
    outcome_payload: {
      resultado: action.outcome,
      motivo: action.motivo,
      // Lo que dictó la persona vive aquí y no en `leads.*`: el sync y el
      // reenvío Swayp leen esas columnas. «Generar pedido» la superpone.
      captura: action.captura,
      resumen: action.resumen,
      // En una prueba el teléfono es el de quien prueba: su «no me llamen»
      // no entra a la lista de la tienda.
      no_llamar: call.mode === "real" && action.optOut,
      aplicado: applied,
      omitido: skipped,
      conversation_id: body.conversation_id ?? null,
    },
    ended_at: now.toISOString(),
    error: writeError,
  };
  // El cierre lleva la captura y el «no llamar»: si no llega, el vigilante
  // cerraría la fila sin ellos. Un reintento; si tampoco, se avisa el fallo.
  let { error: closeError } = await admin.from("voice_calls").update(cierre).eq("id", call.id);
  if (closeError) ({ error: closeError } = await admin.from("voice_calls").update(cierre).eq("id", call.id));
  if (closeError) {
    console.error(`[voice-leads] registro sin cerrar (llamada ${call.id}): ${closeError.message}`);
    return NextResponse.json({ ok: false, error: "no se pudo registrar" });
  }

  // El guion ordena no reintentar si falla: la fila queda `failed` y una
  // persona retoma con la nota y la transcripción.
  if (writeError) return NextResponse.json({ ok: false, error: "no se pudo registrar" });
  return NextResponse.json({ ok: true, modo: call.mode });
}
