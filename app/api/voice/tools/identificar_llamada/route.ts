// Tool `identificar_llamada` del agente de voz (MOM §11.8).
//
// El agente la llama al conectar, antes de hablar. Devuelve la ficha del
// pedido de la llamada ABIERTA —la fila que Kapta escribió antes de pedir el
// callback—, nunca de un pedido buscado por teléfono.
//
// En la consola de xAI, la URL lleva el número del agente, para que la
// elección sea exacta aunque haya más de una tienda llamando:
//   POST https://<kapta>/api/voice/tools/identificar_llamada?agente=17058243
// con `Authorization: Bearer <VOICE_TOOLS_SECRET>` y cuerpo
//   { "numero_cliente": "+51…" }   (opcional; gana si coincide con la fila)
//
// Sin llamada abierta devuelve `{ "encontrada": false }` con estado 200: es la
// señal que el prompt usa para disculparse y colgar sin registrar nada.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { pickOpenCall } from "@/lib/voice-recovery";
import {
  loadCall,
  loadFicha,
  openCalls,
  readToolBody,
  sweepStaleCalls,
  voiceToolAuthorized,
} from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  if (!voiceToolAuthorized(req)) {
    return NextResponse.json({ encontrada: false, error: "no autorizado" }, { status: 401 });
  }
  const body = await readToolBody(req);
  const admin = createAdminSupabase();
  const now = new Date();

  await sweepStaleCalls(admin, now);
  const picked = pickOpenCall(await openCalls(admin), "dialing", {
    now,
    agentNumber: body.agente ?? null,
    customerPhone: body.numero_cliente ?? null,
  });
  if ("error" in picked) {
    return NextResponse.json({ encontrada: false, motivo: picked.error });
  }

  const call = await loadCall(admin, picked.call.id);
  if (!call) return NextResponse.json({ encontrada: false, motivo: "ninguna" });
  const ficha = await loadFicha(admin, call, now);
  if (!ficha) return NextResponse.json({ encontrada: false, motivo: "pedido" });

  // Pasa a «en curso» solo si seguía marcando: una segunda llamada a la tool
  // dentro de la misma conversación no la reabre ni la adelanta.
  await admin
    .from("voice_calls")
    .update({
      status: "in_progress",
      started_at: now.toISOString(),
      outcome_payload: { numero_cliente_recibido: body.numero_cliente ?? null },
    })
    .eq("id", call.id)
    .eq("status", "dialing");

  return NextResponse.json(ficha);
}
