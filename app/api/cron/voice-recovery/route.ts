// Barrido del agente de voz (MOM §11.8).
//
// Cada cinco minutos, por tienda con el automático encendido y dentro del
// horario: si el agente no está en otra llamada y queda cupo del día, llama al
// primer pedido de la cola. UNA llamada por pasada y por tienda, porque el
// número del agente atiende una a la vez (índice único en `voice_calls`): con
// ~12 pasadas por hora caben de sobra las 20 a 30 del piloto.
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
  sweepStaleCalls,
  type VoiceStoreSettings,
} from "@/lib/voice-recovery-server";
import { isLimaSunday, withinVoiceHours } from "@/lib/voice-recovery-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface StoreReport {
  store: string | null;
  action: string;
  queue?: number;
  excluded?: Record<string, number>;
  called?: string | null;
  error?: string;
}

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
  const busyAgents = new Set((await openCalls(admin)).map((c) => c.agent_number));

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
      if (!agentNumber || !sip) {
        report.action = "sin_configuracion";
        continue;
      }
      if (isLimaSunday(now) || !withinVoiceHours(now, store.voice_recovery_hour_start, store.voice_recovery_hour_end)) {
        report.action = "fuera_de_horario";
        continue;
      }
      if (busyAgents.has(agentNumber)) {
        report.action = "agente_ocupado";
        continue;
      }
      if ((await realCallsToday(admin, store.id, now)) >= store.voice_recovery_daily_cap) {
        report.action = "tope_diario";
        continue;
      }

      const queue = await loadVoiceQueue(admin, store, now);
      report.queue = queue.candidates.length;
      report.excluded = queue.excluded;
      const next = queue.candidates[0];
      if (!next) {
        report.action = "cola_vacia";
        continue;
      }
      const placed = await placeVoiceCall(
        admin,
        {
          storeId: store.id,
          orderId: next.orderId,
          phone: next.phone,
          mode: "real",
          triggeredBy: null,
          agentNumber,
          sip,
        },
        now,
      );
      if (placed.ok) {
        busyAgents.add(agentNumber);
        report.action = "llamada";
        report.called = next.orderName;
      } else {
        report.action = "error";
        report.error = placed.error;
      }
    } catch (err) {
      report.action = "error";
      report.error = (err as Error).message;
    }
  }

  // Vercel no guarda la respuesta del cron: sin esta línea, «no llamó a nadie»
  // no se puede distinguir de «cola vacía» ni de «todos excluidos por X».
  console.log(`[voice-recovery] ${JSON.stringify({ dry, stores: reports })}`);
  return NextResponse.json({ ok: true, dry, at: now.toISOString(), stores: reports });
}

export const GET = run;
export const POST = run;
