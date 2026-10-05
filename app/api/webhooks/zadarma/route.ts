// Avisos de la centralita de Zadarma para el «Agente Daaph» (MOM §11.8).
//
// Zadarma no le avisaba a Kapta cuándo se cortaba una llamada: una
// conversación de Daaph que terminaba sin `registrar_gestion` quedaba «en
// curso» hasta el barrido (~10 min), con el número del agente ocupado y la cola
// parada (05-10-2026). Telnyx ya cerraba al momento; con este aviso, Daaph
// también:
//
//   · fin de llamada (NOTIFY_OUT_END / NOTIFY_END) de una llamada «en curso»
//     sin gestión → «no contesta» al momento (tras 3 s por si el registro venía
//     en camino), igual que el corte de Telnyx;
//   · fin de una llamada que seguía «marcando» → «no contesta», con la causa
//     que dio Zadarma (ocupado, sin respuesta…).
//
// La llamada se encuentra por el teléfono de la clienta entre las llamadas
// abiertas de Zadarma: el callback no devuelve un id. Cada aviso que toca una
// llamada queda en `telephony_response.eventos`.
//
// Solo se acepta lo firmado con la clave de la API (`ZADARMA_SECRET`). Al
// guardar la URL en el panel, Zadarma la verifica con `?zd_echo=`.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { closeAsNoAnswer, closeCutWithoutGestion } from "@/lib/voice-recovery-server";
import { ZADARMA_END_EVENTS, zadarmaLocalPeru, zadarmaNotifyPhones, zadarmaNotifyValid } from "@/lib/zadarma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MAX_EVENTOS = 40;
/** Una llamada marcada hace más que esto ya no es la de este aviso. */
const MATCH_WINDOW_MS = 30 * 60_000;

/** Cómo se dice en el historial lo que Zadarma contestó de una llamada que no llegó al agente. */
function noAnswerResumen(disposition: string | undefined): string {
  switch ((disposition ?? "").toLowerCase()) {
    case "busy":
      return "No contestó: la línea estaba ocupada.";
    case "no answer":
      return "No contestó: timbró sin respuesta.";
    case "cancel":
      return "No contestó: la llamada se canceló antes de que contestara.";
    case "answered":
      return "No contestó: colgó antes de hablar con el agente.";
    case "unallocated number":
      return "No contestó: el número no existe.";
    default:
      return `No contestó: la llamada no se completó (${disposition || "sin causa"}).`;
  }
}

function echo(req: NextRequest, form?: Record<string, string>) {
  const value = req.nextUrl.searchParams.get("zd_echo") ?? form?.zd_echo;
  return value ? new NextResponse(value, { status: 200, headers: { "content-type": "text/plain" } }) : null;
}

export async function GET(req: NextRequest) {
  return echo(req) ?? NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const form: Record<string, string> = {};
  new URLSearchParams(raw).forEach((v, k) => {
    form[k] = v;
  });
  const echoed = echo(req, form);
  if (echoed) return echoed;

  let secret: string;
  try {
    secret = env.zadarmaSecret();
  } catch {
    return NextResponse.json({ ok: false, error: "ZADARMA_SECRET sin configurar" }, { status: 500 });
  }
  // Un evento que no se maneja (respuesta, IVR, interna) no se firma con las
  // cadenas conocidas: se contesta 200 para que Zadarma no reintente.
  if (!ZADARMA_END_EVENTS.has(form.event ?? "") && form.event !== "NOTIFY_OUT_START" && form.event !== "NOTIFY_START") {
    return NextResponse.json({ ok: true, ignored: form.event ?? "sin evento" });
  }
  if (!zadarmaNotifyValid(form, req.headers.get("signature"), secret)) {
    return NextResponse.json({ ok: false, error: "firma inválida" }, { status: 401 });
  }

  const phones = new Set(zadarmaNotifyPhones(form));
  if (!phones.size) return NextResponse.json({ ok: true, ignored: "sin teléfono" });

  const admin = createAdminSupabase();
  const now = new Date();
  const { data } = await admin
    .from("voice_calls")
    .select("id, store_id, order_id, mode, status, phone, dialed_at, telephony_response")
    .eq("telephony", "zadarma")
    .in("status", ["dialing", "in_progress"])
    .gte("dialed_at", new Date(now.getTime() - MATCH_WINDOW_MS).toISOString())
    .order("dialed_at", { ascending: false });
  type Row = {
    id: string;
    store_id: string;
    order_id: string;
    mode: "real" | "test";
    status: "dialing" | "in_progress";
    phone: string;
    telephony_response: Record<string, unknown> | null;
  };
  const row = ((data ?? []) as Row[]).find((r) => phones.has(zadarmaLocalPeru(r.phone) ?? ""));
  if (!row) return NextResponse.json({ ok: true, ignored: "sin llamada abierta de ese teléfono" });

  const telephony = { ...(row.telephony_response ?? {}) };
  const eventos = Array.isArray(telephony.eventos) ? [...(telephony.eventos as unknown[])] : [];
  eventos.push({
    t: now.toISOString(),
    tipo: form.event,
    ...(form.disposition ? { causa: form.disposition } : {}),
    ...(form.duration ? { segundos: Number(form.duration) } : {}),
    ...(form.status_code ? { q931: form.status_code } : {}),
    ...(form.pbx_call_id ? { pbx_call_id: form.pbx_call_id } : {}),
  });
  telephony.eventos = eventos.slice(-MAX_EVENTOS);
  await admin.from("voice_calls").update({ telephony_response: telephony }).eq("id", row.id);

  if (!ZADARMA_END_EVENTS.has(form.event ?? "")) return NextResponse.json({ ok: true, action: "anotado" });

  if (row.status === "in_progress") {
    await closeCutWithoutGestion(admin, row, now);
    return NextResponse.json({ ok: true, action: "corte_sin_gestion" });
  }
  await closeAsNoAnswer(admin, row, noAnswerResumen(form.disposition), now);
  return NextResponse.json({ ok: true, action: "no_contesta" });
}
