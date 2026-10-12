// Aviso «post-call» de ElevenLabs (MOM §33): al terminar cada conversación,
// ElevenLabs manda la transcripción, la duración, el costo y su resumen.
// Kapta lo guarda en `voice_calls.transcript` de las llamadas del agente de
// LEADS, para que una asesora lea qué se dijo y para medir el piloto.
//
// Se configura en ElevenLabs (webhooks del workspace, «post-call») con
//   POST https://<kapta>/api/voice/elevenlabs/post-call
// y el secreto HMAC que ElevenLabs genera, en ELEVENLABS_WEBHOOK_SECRET.
// Sin ese secreto Kapta rechaza todo (401): un aviso sin firma podría
// escribir cualquier cosa sobre una llamada.
//
// La llamada se reconoce por la variable `voice_call_id`, que Kapta le dio al
// agente en el inicio de conversación. Las de Reproprovincia no la llevan y
// se ignoran. Responde 200 a todo aviso firmado que no reconoce: ElevenLabs
// desactiva el webhook si falla muchas veces.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { LEAD_VOICE_PURPOSE } from "@/lib/voice-leads";
import { leadTranscriptFrom, verifyElevenLabsSignature } from "@/lib/voice-leads-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const now = new Date();
  if (!verifyElevenLabsSignature(raw, req.headers.get("elevenlabs-signature"), env.elevenLabsWebhookSecret(), now)) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 });
  }

  let body: { type?: unknown; data?: Record<string, unknown> | null } = {};
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ ok: true, ignorado: "cuerpo" });
  }
  if (body.type !== "post_call_transcription") {
    return NextResponse.json({ ok: true, ignorado: String(body.type ?? "sin_tipo") });
  }

  const data = body.data ?? {};
  const vars = (data.conversation_initiation_client_data as { dynamic_variables?: Record<string, unknown> } | undefined)
    ?.dynamic_variables;
  const voiceCallId = String(vars?.voice_call_id ?? "").trim();
  if (!UUID_RE.test(voiceCallId)) return NextResponse.json({ ok: true, ignorado: "sin_llamada" });

  try {
    const admin = createAdminSupabase();
    const { data: row } = await admin.from("voice_calls").select("id, purpose").eq("id", voiceCallId).maybeSingle();
    if ((row as { purpose?: string } | null)?.purpose !== LEAD_VOICE_PURPOSE) {
      return NextResponse.json({ ok: true, ignorado: "no_es_de_leads" });
    }
    const { error } = await admin
      .from("voice_calls")
      .update({ transcript: leadTranscriptFrom(data) })
      .eq("id", voiceCallId)
      .eq("purpose", LEAD_VOICE_PURPOSE);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Sin el texto de la conversación en el log: solo la llamada y el error.
    console.error(`[voice-leads] post-call no guardado (llamada ${voiceCallId}): ${(err as Error).message}`);
    return NextResponse.json({ ok: false, error: "no se pudo guardar" }, { status: 500 });
  }
}
