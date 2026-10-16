// Barrido del agente de voz para leads (MOM §33).
//
// Cada cinco minutos, desfasado dos del de Reproprovincia para que no caigan
// en el mismo minuto ni se mezclen sus logs. Por tienda con el agente de leads
// encendido repone los «Atender ahora» que el sync pisó; si además está en
// automático, dentro del horario, con cupo del día y con el carril libre (hay
// UNA llamada de leads abierta a la vez, índice único), arma la cola, guarda
// el sorteo de los que se vuelven elegibles y llama al primero que salga,
// probando hasta tres.
//
//   ?dry=1          arma la cola y cuenta exclusiones, sin llamar ni escribir
//                   (ni sorteo, ni barrido, ni reposición de «Atender ahora»).
//                   Mira las tiendas con el agente encendido aunque no estén
//                   en automático: así se mide la cola antes de soltarla.
//   ?storeId=<uuid> solo esa tienda.
//
// Fuera de producción no llama (un preview no marca a leads de verdad); con
// ?dry=1 sí corre, para probar.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import {
  VOICE_LEAD_STORE_COLUMNS,
  leadVoiceSettingsFrom,
  type LeadVoiceCallKind,
  type VoiceLeadStoreRow,
} from "@/lib/voice-leads";
import {
  buildLeadContext,
  leadVoiceConfigured,
  loadLeadVoiceQueue,
  placeLeadCall,
  reflagAgentHandoffs,
  type LeadVoiceQueue,
  type LeadVoiceStore,
} from "@/lib/voice-leads-server";
import { withinVoiceHours } from "@/lib/voice-recovery-queue";
import { internalAuthorized, openCalls, realCallsToday, sweepStaleCalls } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Candidatos que se prueban por pasada antes de rendirse (un número que Telnyx rechaza, etc.). */
const MAX_TRIES_PER_PASS = 3;
/**
 * Tope de tiempo para probar candidatos: cada uno puede gastar 4 s de Kapso y
 * 15 s de Telnyx, y la función tiene 60 s en total.
 */
const TRY_BUDGET_MS = 30_000;

interface StoreReport {
  store: string | null;
  action: string;
  queue?: number;
  excluded?: Record<string, number>;
  /** Brazos del sorteo guardados en esta pasada. */
  assigned?: number;
  /** «Atender ahora» del agente que el sync había pisado y se repusieron. */
  reflagged?: number;
  /** Sin datos de la persona: solo qué tipo de llamada e intento. */
  called?: { kind: LeadVoiceCallKind; attempt: number } | null;
  tries?: number;
  error?: string;
}

function excludedCounts(queue: LeadVoiceQueue): Record<string, number> {
  const out: Record<string, number> = {};
  for (const reason of Object.values(queue.reasons)) out[reason] = (out[reason] ?? 0) + 1;
  return out;
}

/** El log no lleva teléfonos: un error de Telnyx puede citar el número marcado. */
function sinNumeros(text: string): string {
  return text.replace(/\+?\d[\d\s-]{6,}\d/g, "[número]");
}

async function run(req: NextRequest) {
  // Vercel Cron manda `Authorization: Bearer <CRON_SECRET>`.
  if (!internalAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const single = req.nextUrl.searchParams.get("storeId");
  if (process.env.VERCEL_ENV !== "production" && !dry) {
    return NextResponse.json({ skipped: "not_production" });
  }
  const admin = createAdminSupabase();
  const now = new Date();

  let storesQuery = admin.from("stores").select(VOICE_LEAD_STORE_COLUMNS).eq("status", "active");
  // Encendidas aunque no estén en automático: sus llamadas a mano también
  // dejan «Atender ahora» que el sync puede pisar (y el dry mide su cola).
  if (single) storesQuery = storesQuery.eq("id", single);
  else storesQuery = storesQuery.eq("voice_lead_enabled", true);
  const { data, error } = await storesQuery;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const stores: LeadVoiceStore[] = ((data ?? []) as unknown as VoiceLeadStoreRow[]).map((row) => ({
    ...row,
    settings: leadVoiceSettingsFrom(row),
  }));

  if (!dry) await sweepStaleCalls(admin, now);
  // Un carril para todas las tiendas: si hay una llamada de lead abierta, en
  // esta pasada nadie más llama.
  let laneBusy = !dry && (await openCalls(admin, "lead")).length > 0;

  const reports: StoreReport[] = [];
  for (const store of stores) {
    const s = store.settings;
    const report: StoreReport = { store: store.name, action: "" };
    reports.push(report);
    try {
      if (dry) {
        // Se mira la cola como si el agente estuviera encendido: es el paso
        // previo a encenderlo, y con él apagado todo saldría `agente_apagado`.
        const queue = await loadLeadVoiceQueue(admin, { ...store, settings: { ...s, enabled: true } }, now);
        report.action = "dry";
        report.queue = queue.candidates.length;
        report.excluded = excludedCounts(queue);
        continue;
      }
      // Con ?storeId la tienda llega aunque esté apagada: el interruptor manda.
      if (!s.enabled) {
        report.action = "apagado";
        continue;
      }
      // Siempre, también fuera de horario y sin automático: el sync puede
      // pisar a cualquier hora un «Atender ahora» del agente.
      report.reflagged = await reflagAgentHandoffs(admin, store.id, now);
      if (!s.auto) {
        report.action = "manual";
        continue;
      }

      if (!withinVoiceHours(now, s.hourStart, s.hourEnd)) {
        report.action = "fuera_de_horario";
        continue;
      }
      // Su propio tope: las llamadas a leads no gastan el de Reproprovincia.
      const used = await realCallsToday(admin, store.id, now, "lead");
      if (used === null) {
        report.action = "error";
        report.error = "No se pudo leer el tope del día: no se llama hasta poder contarlo.";
        continue;
      }
      if (used >= s.dailyCap) {
        report.action = "tope_diario";
        continue;
      }
      if (laneBusy) {
        report.action = "agente_ocupado";
        continue;
      }
      // Sin la línea lista no se sortea: un brazo se guarda solo cuando la
      // tienda de verdad puede llamar (MOM §33.3).
      if (!leadVoiceConfigured()) {
        report.action = "sin_configurar";
        continue;
      }
      // Recién aquí se sortea: el brazo se guarda solo en pasadas en que la
      // tienda de verdad está llamando (MOM §33, el grupo de control).
      const queue = await loadLeadVoiceQueue(admin, store, now, { assign: true });
      report.queue = queue.candidates.length;
      report.excluded = excludedCounts(queue);
      report.assigned = queue.assigned;
      if (!queue.candidates.length) {
        report.action = "cola_vacia";
        continue;
      }

      report.tries = 0;
      let lastError: string | null = null;
      const tryStart = Date.now();
      for (const entry of queue.candidates.slice(0, MAX_TRIES_PER_PASS)) {
        if (Date.now() - tryStart > TRY_BUDGET_MS) break;
        report.tries += 1;
        const context = await buildLeadContext(admin, store, entry, now, "real");
        const placed = await placeLeadCall(
          admin,
          {
            storeId: store.id,
            leadId: entry.lead.id,
            phone: entry.lead.phone ?? "",
            mode: "real",
            triggeredBy: null,
            context,
          },
          now,
        );
        if (placed.ok) {
          laneBusy = true;
          report.called = { kind: entry.kind, attempt: entry.attempt };
          break;
        }
        lastError = placed.error;
        // Telnyx no respondió: esa llamada puede estar sonando. Nadie más
        // marca en esta pasada, tampoco otra tienda.
        if (placed.status === 504) laneBusy = true;
        // Carril ocupado o falta configuración: el siguiente lead tendría el
        // mismo problema. Telnyx sin respuesta (504): la anterior puede estar
        // sonando. Solo un número malo o un rechazo de Telnyx pasa al siguiente.
        if (placed.status === 409 || placed.status === 500 || placed.status === 504) break;
      }
      if (report.called) report.action = "llamada";
      else {
        report.action = "error";
        report.error = sinNumeros(lastError ?? "Ningún lead de la cola se pudo llamar en esta pasada.");
      }
    } catch (err) {
      report.action = "error";
      report.error = sinNumeros((err as Error).message);
    }
  }

  // Vercel no guarda la respuesta del cron: sin esta línea, «no llamó a nadie»
  // no se distingue de «cola vacía» ni de «todos excluidos por X». Sin nombres
  // ni teléfonos de los leads.
  console.log(`[voice-leads] ${JSON.stringify({ dry, stores: reports })}`);
  return NextResponse.json({ ok: true, dry, at: now.toISOString(), stores: reports });
}

export const GET = run;
export const POST = run;
