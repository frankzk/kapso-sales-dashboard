// Avisos de Telnyx del «Agente Telnyx» (MOM §11.8).
//
// Telnyx avisa cada paso de cada tramo. Aquí se hace lo que en Zadarma hacía
// la centralita:
//   · la clienta contesta → se abre el tramo a xAI, unido al de ella;
//   · la línea detecta contestadora → se cuelga y se registra «no contesta»;
//   · la clienta cuelga sin haber llegado al agente → «no contesta» al momento,
//     con la causa (timbró, ocupado, rechazó), sin esperar al barrido;
//   · un tramo cuelga → se cuelga el otro.
// Cada aviso queda en `voice_calls.telephony_response.eventos`: con eso se ve
// por qué se cortó cada llamada, que es lo que el piloto quiere medir.
//
// Solo se acepta lo que viene firmado por Telnyx (Ed25519, TELNYX_PUBLIC_KEY).

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import {
  agenteDialBody,
  dialTelnyx,
  hangupTelnyx,
  noAnswerResumen,
  parseTelnyxEvent,
  verifyTelnyxSignature,
  type TelnyxEvent,
} from "@/lib/telnyx";
import { closeAsNoAnswer, telnyxConfig } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const OPEN = new Set(["queued", "dialing", "in_progress"]);
const MAX_EVENTOS = 40;

interface Row {
  id: string;
  store_id: string;
  order_id: string;
  mode: "real" | "test";
  status: string;
  telephony: string;
  telephony_response: { cliente?: string; agente?: string; eventos?: unknown[] } | null;
}

/** Solo se llama con una fila abierta (`OPEN.has(status)`). */
function asOpen(row: Row) {
  return { ...row, status: row.status as "queued" | "dialing" | "in_progress" };
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  let publicKey: string;
  try {
    publicKey = env.telnyxPublicKey();
  } catch {
    return NextResponse.json({ ok: false, error: "TELNYX_PUBLIC_KEY sin configurar" }, { status: 500 });
  }
  const signed = verifyTelnyxSignature({
    rawBody: raw,
    signature: req.headers.get("telnyx-signature-ed25519"),
    timestamp: req.headers.get("telnyx-timestamp"),
    publicKey,
  });
  if (!signed) return NextResponse.json({ ok: false, error: "firma inválida" }, { status: 401 });

  let ev: TelnyxEvent | null = null;
  try {
    ev = parseTelnyxEvent(JSON.parse(raw));
  } catch {
    ev = null;
  }
  // Sin client_state no es un tramo de Kapta: se responde 200 para que
  // Telnyx no reintente.
  if (!ev?.state) return NextResponse.json({ ok: true, ignored: "sin client_state" });

  const admin = createAdminSupabase();
  const now = new Date();
  const { data } = await admin
    .from("voice_calls")
    .select("id, store_id, order_id, mode, status, telephony, telephony_response")
    .eq("id", ev.state.vc)
    .maybeSingle();
  const row = data as Row | null;
  if (!row || row.telephony !== "telnyx") return NextResponse.json({ ok: true, ignored: "llamada desconocida" });

  const telephony = { ...(row.telephony_response ?? {}) };
  const eventos = Array.isArray(telephony.eventos) ? telephony.eventos : [];
  eventos.push({
    t: ev.occurredAt ?? now.toISOString(),
    tipo: ev.type,
    tramo: ev.state.leg,
    ...(ev.hangupCause ? { causa: ev.hangupCause } : {}),
    ...(ev.hangupSource ? { origen: ev.hangupSource } : {}),
    ...(ev.sipHangupCause ? { sip: ev.sipHangupCause } : {}),
    ...(ev.amdResult ? { amd: ev.amdResult } : {}),
  });
  telephony.eventos = eventos.slice(-MAX_EVENTOS);
  if (ev.state.leg === "agente" && ev.callControlId) telephony.agente = ev.callControlId;
  const update: Record<string, unknown> = { telephony_response: telephony };
  if (ev.type === "call.recording.saved" && ev.recordingUrl) update.recording_url = ev.recordingUrl;
  await admin.from("voice_calls").update(update).eq("id", row.id);

  const cfg = telnyxConfig();
  if ("error" in cfg) return NextResponse.json({ ok: false, error: cfg.error }, { status: 500 });
  const hangup = async (ccid: string | undefined | null) => {
    if (ccid) await hangupTelnyx(cfg, ccid);
  };
  const open = OPEN.has(row.status);
  const leg = ev.state.leg;

  if (ev.type === "call.answered" && leg === "cliente") {
    if (!open || !ev.callControlId) {
      await hangup(ev.callControlId);
      return NextResponse.json({ ok: true, action: "colgada: la llamada ya estaba cerrada" });
    }
    const dialed = await dialTelnyx(cfg, agenteDialBody(cfg, row.id, ev.callControlId));
    if (!dialed.ok) {
      await hangup(ev.callControlId);
      await admin
        .from("voice_calls")
        .update({
          status: "failed",
          outcome: "sin_resultado",
          error: `No se pudo conectar con el agente: ${dialed.error}`,
          ended_at: now.toISOString(),
        })
        .eq("id", row.id)
        .in("status", [...OPEN]);
      return NextResponse.json({ ok: true, action: "agente_no_conecta" });
    }
    telephony.agente = dialed.callControlId;
    await admin.from("voice_calls").update({ telephony_response: telephony }).eq("id", row.id);
    return NextResponse.json({ ok: true, action: "agente_marcado" });
  }

  if (ev.type === "call.machine.detection.ended" && leg === "cliente" && ev.amdResult === "machine") {
    await hangup(ev.callControlId);
    await hangup(telephony.agente);
    if (open) {
      await closeAsNoAnswer(admin, asOpen(row), "No contestó: contestó un buzón de voz (lo detectó la línea).", now);
    }
    return NextResponse.json({ ok: true, action: "buzon" });
  }

  if (ev.type === "call.hangup" && leg === "cliente") {
    await hangup(telephony.agente);
    // Solo si nunca llegó al agente: una conversación en curso la cierra
    // `registrar_gestion` o, si se cortó sin gestión, el barrido.
    if (row.status === "dialing") {
      const contesto = eventos.some(
        (e) => (e as { tipo?: string; tramo?: string }).tipo === "call.answered" && (e as { tramo?: string }).tramo === "cliente",
      );
      const resumen = contesto ? "No contestó: colgó antes de hablar con el agente." : noAnswerResumen(ev);
      await closeAsNoAnswer(admin, asOpen(row), resumen, now);
    }
    return NextResponse.json({ ok: true, action: "cliente_colgo" });
  }

  if (ev.type === "call.hangup" && leg === "agente") {
    await hangup(telephony.cliente);
    return NextResponse.json({ ok: true, action: "agente_colgo" });
  }

  return NextResponse.json({ ok: true });
}
