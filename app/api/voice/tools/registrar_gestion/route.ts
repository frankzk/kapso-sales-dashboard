// Tool `registrar_gestion` del agente de voz (MOM §11.8).
//
// El agente la llama UNA vez, al final. Se atribuye a la llamada EN CURSO de
// ese número de agente —la que `identificar_llamada` abrió—, y escribe los
// mismos hechos que una asesora, por la misma función (§6.1), con
// `source = 'agente_voz'` y el id de la llamada como operation_id: un
// reintento del agente devuelve lo ya escrito y no gasta otro día.
//
// En `mode = 'test'` no se escribe NADA sobre el pedido: solo la fila.
//
//   POST https://<kapta>/api/voice/tools/registrar_gestion?agente=17058243
//   Authorization: Bearer <VOICE_TOOLS_SECRET>
//   { disposition, fecha?, rango?, direccion_confirmada?, referencia?, motivo?, resumen }
//
// Un «confirma» con fecha crea además la salida Swayp (`crearSalidaSwaypDelAgente`).

import { after, NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { discardRecovery } from "@/lib/recovery-discard";
import { pickOpenCall, translateGestion, voiceDates } from "@/lib/voice-recovery";
import {
  crearSalidaSwaypDelAgente,
  loadCall,
  loadStoreVoiceConfig,
  openCalls,
  readToolBody,
  voiceToolAuthorized,
  writeVoiceAttempt,
} from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// La salida Swayp se pide después de responder (`after`) y cuenta contra este
// tope: la API de Swayp puede tardar varios segundos.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!voiceToolAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 });
  }
  const body = await readToolBody(req);
  const admin = createAdminSupabase();
  const now = new Date();

  const picked = pickOpenCall(await openCalls(admin), "in_progress", {
    now,
    agentNumber: body.agente ?? null,
    customerPhone: body.numero_cliente ?? null,
  });
  if ("error" in picked) {
    return NextResponse.json({ ok: false, error: `sin llamada en curso (${picked.error})` });
  }
  const call = await loadCall(admin, picked.call.id);
  if (!call) return NextResponse.json({ ok: false, error: "sin llamada en curso" });

  const store = await loadStoreVoiceConfig(admin, call.store_id);
  const action = translateGestion(body, {
    today: voiceDates(now).hoy,
    canDiscard: Boolean(store?.voice_recovery_can_discard),
    voiceCallId: call.id,
  });
  if (action.kind === "invalid") {
    return NextResponse.json({ ok: false, error: action.error });
  }

  const outcomePayload = {
    ...body,
    accion: action.kind,
    resultado: action.kind === "attempt" ? action.result : null,
    // El barrido lo lee para no volver a llamar a este teléfono (§11.8, cond. 9).
    no_llamar: action.extra.no_llamar === true,
  };
  let writeError: string | null = null;

  if (call.mode === "real") {
    if (action.kind === "attempt") {
      writeError = await writeVoiceAttempt(admin, call, action, now);
    } else if (action.kind === "discard") {
      const { error } = await discardRecovery(admin, {
        storeId: call.store_id,
        orderId: call.order_id,
        actor: null,
        reason: action.reason,
        source: "agente_voz",
        payload: action.extra,
      });
      if (error) writeError = error;
    }
    // `propose_discard`: nada sobre el pedido. La propuesta vive en la fila y
    // el descarte lo ejecuta una persona con la ceremonia de §11.5.
    if (!writeError) await recomputeOrderMasterSafe(admin, [call.order_id]);
  }

  await admin
    .from("voice_calls")
    .update({
      status: writeError ? "failed" : "completed",
      outcome: action.disposition,
      outcome_payload: outcomePayload,
      ended_at: now.toISOString(),
      error: writeError,
    })
    .eq("id", call.id);

  // El prompt ordena no reintentar si falla: se responde el fallo tal cual y
  // la fila queda `failed` con la transcripción para que una persona retome.
  if (writeError) return NextResponse.json({ ok: false, error: "no se pudo registrar" });

  // Aceptó el reenvío con fecha: el agente crea la salida Swayp por el mismo
  // camino que «Reenviar por Swayp» (MOM §11.8, decisión del 25-09-2026).
  // Va DESPUÉS de responder: la clienta sigue en línea y la API de Swayp puede
  // tardar. Si una reja dice que no, el motivo queda en la llamada y en el log.
  if (call.mode === "real" && action.kind === "attempt" && action.result === "confirmado") {
    const fecha = String(action.extra.fecha_entrega ?? "");
    after(() =>
      crearSalidaSwaypDelAgente(admin, call, {
        fecha,
        direccionConfirmada: (action.extra.direccion_confirmada as string | null) ?? null,
        resumen: String(body.resumen ?? ""),
      }).then(() => undefined),
    );
  }
  return NextResponse.json({ ok: true, modo: call.mode });
}
