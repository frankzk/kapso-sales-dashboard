// Barrido del agente de voz (MOM §11.8).
//
// Cada cinco minutos, por tienda con el automático encendido y dentro del
// horario: por cada número de agente libre, y mientras quede cupo del día,
// llama al siguiente pedido de la cola. Un número atiende una llamada a la vez
// (índice único en `voice_calls`); los agentes con número propio llaman en
// paralelo (`planVoiceSlots`, MOM §11.8).
//
//   ?dry=1          arma la cola y cuenta exclusiones, sin llamar ni escribir.
//                   Funciona aunque el automático esté apagado: sirve para
//                   medir la cola antes de encenderla (§11.8, pendientes).
//   ?storeId=<uuid> solo esa tienda.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import {
  VOICE_STORE_COLUMNS,
  internalAuthorized,
  loadVoiceQueue,
  openCalls,
  placeVoiceCall,
  realCallsToday,
  salidasSwaypPendientes,
  sweepStaleCalls,
  telnyxConfig,
  voiceLanes,
  type VoiceStoreSettings,
} from "@/lib/voice-recovery-server";
import { planVoiceSlots } from "@/lib/voice-recovery";
import { agentSipUriFor } from "@/lib/telnyx";
import { withinVoiceHours } from "@/lib/voice-recovery-queue";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface PassCall {
  called: string | null;
  agent: string;
  telephony: "zadarma" | "telnyx";
  engine: "grok" | "elevenlabs";
}

interface StoreReport {
  store: string | null;
  action: string;
  queue?: number;
  excluded?: Record<string, number>;
  called?: string | null;
  /** Una por agente libre: con los agentes en paralelo, hasta tres por pasada. */
  calls?: PassCall[];
  /** Agentes que seguían en otra llamada. */
  busy?: string[];
  /** Pedidos saltados en esta pasada por ser del reintento automático. */
  skipped?: number;
  error?: string;
}

/**
 * Cuántos pedidos de la cola se prueban por pasada antes de rendirse. Los del
 * reintento automático son cierres recientes y se juntan al frente: con 10, el
 * 04-10-2026 (cola de 261) las pasadas se rendían sin llamar a nadie.
 */
const MAX_TRIES_PER_PASS = 60;
/** Tope de tiempo para probar candidatos: la función tiene 60 s en total. */
const TRY_BUDGET_MS = 30_000;

async function run(req: NextRequest) {
  // Vercel Cron manda `Authorization: Bearer <CRON_SECRET>`.
  if (!internalAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const single = req.nextUrl.searchParams.get("storeId");
  const admin = createAdminSupabase();
  const now = new Date();

  let storesQuery = admin.from("stores").select(VOICE_STORE_COLUMNS).eq("status", "active");
  if (single) storesQuery = storesQuery.eq("id", single);
  else if (!dry) storesQuery = storesQuery.eq("voice_recovery_enabled", true).eq("voice_recovery_auto", true);
  const { data, error } = await storesQuery;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const stores = (data ?? []) as VoiceStoreSettings[];

  if (!dry) await sweepStaleCalls(admin, now);
  // Los aceptados sin salida Swayp pedida (MOM §11.8). Fuera del horario de
  // llamadas también: la salida no molesta a nadie y la fecha ya está pactada.
  const salidas = dry ? [] : await salidasSwaypPendientes(admin, now);
  const busyAgents = new Set((await openCalls(admin)).map((c) => c.agent_number));
  const telnyxShare = env.voiceTelnyxShare();
  const elevenShare = env.voiceElevenLabsShare();
  const telnyxCfg = telnyxConfig();
  const telnyxReady = !("error" in telnyxCfg);
  const elevenReady = !("error" in telnyxCfg) && agentSipUriFor(telnyxCfg, "elevenlabs") !== null;
  const lanes = voiceLanes();

  const reports: StoreReport[] = [];
  for (const store of stores) {
    const report: StoreReport = { store: store.name, action: "" };
    reports.push(report);
    try {
      if (dry) {
        const queue = await loadVoiceQueue(admin, store, now);
        report.action = "dry";
        report.queue = queue.candidates.length;
        report.excluded = queue.excluded;
        report.called = queue.candidates[0]?.orderName ?? null;
        continue;
      }

      const agentNumber = store.voice_recovery_agent_number?.trim() ?? "";
      const sip = store.voice_recovery_zadarma_sip?.trim() ?? "";
      if (!agentNumber) {
        report.action = "sin_configuracion";
        continue;
      }
      if (!withinVoiceHours(now, store.voice_recovery_hour_start, store.voice_recovery_hour_end)) {
        report.action = "fuera_de_horario";
        continue;
      }
      // Agente Daaph (Zadarma + Grok), Agente Telnyx (Telnyx + Grok) y Agente
      // ElevenLabs (Telnyx + ElevenLabs). Una llamada por número de agente
      // libre: los que tienen número propio llaman a la vez (MOM §11.8).
      const slots = planVoiceSlots({ base: agentNumber, telnyxShare, elevenShare, telnyxReady, elevenReady, lanes })
        .filter((sl) => sl.route.telephony !== "zadarma" || sip);
      const free = slots.filter((sl) => !busyAgents.has(sl.agentNumber));
      report.busy = slots.filter((sl) => busyAgents.has(sl.agentNumber)).map((sl) => sl.agentNumber);
      if (!slots.length) {
        report.action = "sin_configuracion";
        continue;
      }
      if (!free.length) {
        report.action = "agente_ocupado";
        continue;
      }
      let left = store.voice_recovery_daily_cap - (await realCallsToday(admin, store.id, now));
      if (left <= 0) {
        report.action = "tope_diario";
        continue;
      }

      const queue = await loadVoiceQueue(admin, store, now);
      report.queue = queue.candidates.length;
      report.excluded = queue.excluded;
      if (!queue.candidates.length) {
        report.action = "cola_vacia";
        continue;
      }
      // El reintento automático Aliclik → Swayp tiene prioridad (no se llama):
      // ese pedido se salta y se prueba el siguiente. Sin esto, un solo pedido
      // en reintento al frente de la cola bloqueaba el día entero (04-10-2026).
      // Cada agente toma el siguiente pedido que nadie tomó en esta pasada.
      report.skipped = 0;
      report.calls = [];
      const pending = queue.candidates.slice(0, MAX_TRIES_PER_PASS);
      const tryStart = Date.now();
      let lastError: string | null = null;
      for (const sl of free) {
        if (left <= 0 || !pending.length) break;
        while (pending.length) {
          if (Date.now() - tryStart > TRY_BUDGET_MS) break;
          const next = pending.shift()!;
          const placed = await placeVoiceCall(
            admin,
            {
              storeId: store.id,
              orderId: next.orderId,
              phone: next.phone,
              mode: "real",
              triggeredBy: null,
              agentNumber: sl.agentNumber,
              sip,
              telephony: sl.route.telephony,
              engine: sl.route.engine,
            },
            now,
          );
          if (placed.ok) {
            busyAgents.add(sl.agentNumber);
            left -= 1;
            report.calls.push({ called: next.orderName, agent: sl.agentNumber, ...sl.route });
            break;
          }
          if (placed.reason === "reintento_automatico") {
            report.skipped += 1;
            continue;
          }
          lastError = placed.error;
          break;
        }
      }
      if (report.calls.length) {
        report.action = "llamada";
        report.called = report.calls[0]!.called;
      } else {
        report.action = "error";
        report.error = lastError ?? "Ningún pedido de la cola se pudo llamar en esta pasada.";
      }
    } catch (err) {
      report.action = "error";
      report.error = (err as Error).message;
    }
  }

  // Vercel no guarda la respuesta del cron: sin esta línea, «no llamó a nadie»
  // no se puede distinguir de «cola vacía» ni de «todos excluidos por X».
  console.log(`[voice-recovery] ${JSON.stringify({ dry, stores: reports, salidas })}`);
  return NextResponse.json({ ok: true, dry, at: now.toISOString(), stores: reports, salidas });
}

export const GET = run;
export const POST = run;
