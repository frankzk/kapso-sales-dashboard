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

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { confirmationReminderDueAt } from "@/lib/order-confirmation";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { discardRecovery } from "@/lib/recovery-discard";
import {
  VOICE_SOURCE,
  pickOpenCall,
  translateGestion,
  voiceDates,
} from "@/lib/voice-recovery";
import {
  loadCall,
  loadStoreVoiceConfig,
  openCalls,
  readToolBody,
  voiceToolAuthorized,
} from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

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
  };
  let writeError: string | null = null;

  if (call.mode === "real") {
    if (action.kind === "attempt") {
      const reminder =
        action.result === "sin_respuesta" || action.result === "se_deja_mensaje"
          ? confirmationReminderDueAt(now.toISOString())
          : null;
      const { error } = await admin.rpc("register_confirmation_attempt_v2", {
        p_store_id: call.store_id,
        p_order_id: call.order_id,
        p_actor: null,
        p_operation_id: call.id,
        p_result: action.result,
        p_channel: "llamada",
        p_note: action.note,
        p_next_contact_on: action.nextContactOn,
        p_occurred_at: now.toISOString(),
        p_reminder_due_at: reminder,
        p_source: VOICE_SOURCE,
        p_payload_extra: action.extra,
      });
      if (error) writeError = error.message;
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
  return NextResponse.json({ ok: true, modo: call.mode });
}
