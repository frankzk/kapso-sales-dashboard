// Inicio de conversación del agente de voz para LEADS (MOM §33).
//
// ElevenLabs llama a este webhook al entrar la llamada por el SIP trunk, antes
// de que el agente hable. El webhook de inicio es POR AGENTE (en la config del
// agente, `conversation_initiation_client_data_webhook`): el de leads apunta
// aquí y el de Reproprovincia a /api/voice/elevenlabs/inicio. Se configura con
//   POST https://<kapta>/api/voice/leads/inicio
// y la cabecera `x-voice-secret` = VOICE_LEADS_TOOLS_SECRET.
//
// Kapta devuelve la ficha que guardó al marcar (`voice_calls.lead_context`):
// nombre, producto, oferta y la conversación de WhatsApp. NO se llama a Kapso
// aquí: hay 10 s y la persona ya está en línea; el chat se leyó al marcar.
//
// Responde SIEMPRE 200 con todas las variables (salvo sin secreto: 401): si
// falta una, ElevenLabs no arranca la conversación. Sin llamada abierta,
// `encontrada = "no"` y el agente se despide.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { callerIdDeKapta, leadVoiceInitiation } from "@/lib/voice-leads";
import { leadToolAuthorized } from "@/lib/voice-leads-server";
import { loadLeadCall } from "@/lib/voice-leads-writeback";
import { pickOpenCall } from "@/lib/voice-recovery";
import { openCalls, sweepStaleCalls } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(req: NextRequest) {
  if (!leadToolAuthorized(req)) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }
  // El tramo que Kapta abre al agente sale con el número de leads
  // (`agenteDialBody` con TELNYX_LEADS_FROM_NUMBER). Una conversación que entra
  // con otro caller ID es alguien llamando al número del agente —típicamente
  // un lead que devuelve la perdida— mientras el agente marca a otra persona:
  // no recibe la ficha ajena (la regla de §11.8 tras el 24-09-2026).
  let body: { caller_id?: unknown } = {};
  try {
    body = (await req.json()) as { caller_id?: unknown };
  } catch {
    body = {};
  }
  if (!callerIdDeKapta(body.caller_id, env.telnyxLeadsFromNumber())) {
    return NextResponse.json(leadVoiceInitiation(null, null));
  }
  try {
    const admin = createAdminSupabase();
    const now = new Date();
    await sweepStaleCalls(admin, now);
    // Un solo carril de leads: la llamada que está marcando es la que entra.
    const picked = pickOpenCall(await openCalls(admin, "lead"), "dialing", { now });
    if ("error" in picked) return NextResponse.json(leadVoiceInitiation(null, null));

    const row = await loadLeadCall(admin, picked.call.id);
    if (!row) return NextResponse.json(leadVoiceInitiation(null, null));

    // La llamada pasa a «en curso» aquí: el registro la toma con
    // `.eq("status", "in_progress")`, y una fila que siguiera «marcando» la
    // cerraría el barrido a los 3 minutos, con la persona todavía hablando.
    await admin
      .from("voice_calls")
      .update({ status: "in_progress", started_at: now.toISOString() })
      .eq("id", row.id)
      .eq("status", "dialing");

    return NextResponse.json(leadVoiceInitiation(row.id, row.lead_context?.ficha ?? null));
  } catch (err) {
    console.error(`[voice-leads] inicio sin ficha: ${(err as Error).message}`);
    return NextResponse.json(leadVoiceInitiation(null, null));
  }
}
