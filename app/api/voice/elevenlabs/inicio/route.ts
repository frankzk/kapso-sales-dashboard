// Inicio de conversación del «Agente ElevenLabs» (MOM §11.8).
//
// ElevenLabs llama a este webhook al entrar cada llamada por el SIP trunk,
// antes de que el agente hable. Kapta devuelve la ficha de la llamada ABIERTA
// —la misma que daría `identificar_llamada`— como variables dinámicas, y un
// primer mensaje con el nombre: así el agente saluda «Hola, buenas. ¿Hablo con
// Norma?» al conectar, sin esperar a la clienta ni ida y vuelta a la tool.
//
// Se configura en ElevenLabs (webhook de datos de inicio de conversación) con
//   POST https://<kapta>/api/voice/elevenlabs/inicio?agente=1-11
// y la cabecera `x-voice-secret` (el secreto de las tools).
//
// Responde SIEMPRE 200 con todas las variables: si falta una, ElevenLabs no
// arranca la conversación. Sin ficha, `encontrada = "no"` y el agente cae a
// `identificar_llamada`, que sigue funcionando igual.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { elevenLabsInitiation, pickOpenCall } from "@/lib/voice-recovery";
import {
  loadCall,
  loadFicha,
  openCalls,
  sweepStaleCalls,
  voiceToolAuthorized,
} from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(req: NextRequest) {
  if (!voiceToolAuthorized(req)) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }
  const agente = req.nextUrl.searchParams.get("agente");
  try {
    const admin = createAdminSupabase();
    const now = new Date();
    await sweepStaleCalls(admin, now);
    const picked = pickOpenCall(await openCalls(admin), "dialing", { now, agentNumber: agente });
    if ("error" in picked) return NextResponse.json(elevenLabsInitiation(null));

    const call = await loadCall(admin, picked.call.id);
    const ficha = call ? await loadFicha(admin, call, now) : null;
    if (!call || !ficha) return NextResponse.json(elevenLabsInitiation(null));

    // Lo mismo que hace `identificar_llamada`: la llamada pasa a «en curso».
    await admin
      .from("voice_calls")
      .update({
        status: "in_progress",
        started_at: now.toISOString(),
        outcome_payload: { ficha_precargada: true },
      })
      .eq("id", call.id)
      .eq("status", "dialing");

    return NextResponse.json(elevenLabsInitiation(ficha));
  } catch (err) {
    console.error(`[voice] inicio ElevenLabs sin ficha: ${(err as Error).message}`);
    return NextResponse.json(elevenLabsInitiation(null));
  }
}
