// Agente de voz para leads — base de datos y telefonía (MOM §33).
//
// Lo que decide está en `lib/voice-leads.ts` (puro). Aquí se lee la cola, se
// guarda el sorteo, se arma lo que el agente escucha y se marca por Telnyx.
// El tramo al agente lo abre el aviso `call.answered` (app/api/webhooks/telnyx)
// hacia TELNYX_LEADS_SIP_URI: el agente de leads es OTRO agente de ElevenLabs.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptOrNull } from "@/lib/crypto";
import { env } from "@/lib/env";
import { fetchConversationTranscript } from "@/lib/kapso";
import type { ExperimentArm } from "@/lib/lead-experiment";
import { categoryOf } from "@/lib/leads";
import { clienteDialBody, dialTelnyx, telnyxPeruE164 } from "@/lib/telnyx";
import { pickOpenCall, voiceDates } from "@/lib/voice-recovery";
import {
  drain,
  loadDoNotCallPhones,
  openCalls,
  sweepStaleCalls,
  telnyxConfig,
  voiceToolSecretMatches,
} from "@/lib/voice-recovery-server";
import { voiceCallAnswered } from "@/lib/voice-scoreboard";
import { loadLeadCall, type LeadCallRow } from "@/lib/voice-leads-writeback";
import { zadarmaLocalPeru } from "@/lib/zadarma";
import {
  LEAD_VOICE_EXPERIMENT,
  LEAD_VOICE_HANDOFF_REASON,
  LEAD_VOICE_LANE,
  LEAD_VOICE_PURPOSE,
  VOICE_LEAD_STORE_COLUMNS,
  attemptCounts,
  buildLeadFicha,
  chatParaAgente,
  coberturaParaAgente,
  leadVoiceEligible,
  leadVoicePhone,
  leadVoiceSettingsFrom,
  sortLeadVoiceQueue,
  type CoberturaParaAgente,
  type LeadContext,
  type LeadVoiceAttempt,
  type LeadVoiceCallKind,
  type LeadVoiceEligibility,
  type LeadVoiceExclusion,
  type LeadVoiceLead,
  type LeadVoiceSettings,
  type VoiceLeadStoreRow,
} from "@/lib/voice-leads";

const HOUR = 3_600_000;

/**
 * El secreto del agente de leads, o "" si no sirve: vacío, o igual a uno de
 * Reproprovincia. Un secreto compartido dejaría que una tool de un agente
 * entrara por la puerta del otro (y la de Reproprovincia escribe sobre pedidos).
 */
function leadSecret(): string {
  const lead = env.voiceLeadsToolsSecret();
  if (!lead) return "";
  let main = "";
  try {
    main = env.voiceToolsSecret();
  } catch {
    // Sin VOICE_TOOLS_SECRET no hay agente de pedidos con quien chocar.
  }
  if (lead === main || lead === env.voiceToolsSecretElevenLabs()) return "";
  return lead;
}

/**
 * ¿La petición viene del agente de leads? Solo `VOICE_LEADS_TOOLS_SECRET`, y
 * cerrado si está vacío o si es igual a uno de los secretos de Reproprovincia:
 * un secreto compartido dejaría al agente de leads escribir sobre pedidos.
 */
export function leadToolAuthorized(req: Pick<NextRequest, "headers">): boolean {
  const secret = leadSecret();
  return secret ? voiceToolSecretMatches(req.headers, [secret]) : false;
}

/** La línea del agente de leads está lista en Vercel: Telnyx, su puerta SIP y su secreto. */
export function leadVoiceConfigured(): boolean {
  return !("error" in telnyxConfig()) && Boolean(env.telnyxLeadsSipUri()) && Boolean(leadSecret());
}

export interface LeadVoiceStore extends VoiceLeadStoreRow {
  settings: LeadVoiceSettings;
}

export async function loadLeadVoiceStore(admin: SupabaseClient, storeId: string): Promise<LeadVoiceStore | null> {
  const { data, error } = await admin.from("stores").select(VOICE_LEAD_STORE_COLUMNS).eq("id", storeId).maybeSingle();
  // Sin las columnas de 0247 la lectura falla: el agente de leads queda apagado.
  if (error || !data) return null;
  const row = data as unknown as VoiceLeadStoreRow;
  return { ...row, settings: leadVoiceSettingsFrom(row) };
}

/** El lead tal como lo necesitan la cola y la ficha. */
export type LeadVoiceQueueLead = LeadVoiceLead & {
  first_inbound_text: string | null;
  district: string | null;
  ad_headline: string | null;
  kapso_conversation_id: string | null;
};

export interface LeadVoiceQueueEntry {
  lead: LeadVoiceQueueLead;
  kind: LeadVoiceCallKind;
  arm: ExperimentArm;
  /** Número del intento que toca, desde 1. */
  attempt: number;
  campaignId: string | null;
}

export interface LeadVoiceQueue {
  /** En el orden en que se llaman (`sortLeadVoiceQueue`). */
  candidates: LeadVoiceQueueEntry[];
  /** Por qué no entra cada lead mirado que no entra. */
  reasons: Record<string, LeadVoiceExclusion>;
  /** El brazo de cada lead mirado que ya lo tenía o lo recibió en esta pasada. */
  arms: Record<string, ExperimentArm>;
  /** Brazos nuevos guardados en esta pasada (solo con `assign`). */
  assigned: number;
  seen: number;
}

const QUEUE_LEAD_COLUMNS =
  "id, store_id, phone, name, status, category, has_order, order_id, source, ad_id, inbound_count, first_seen_at, " +
  "last_inbound_at, claimed_at, next_followup_at, contact_opt_out_at, first_inbound_text, district, ad_headline, " +
  "kapso_conversation_id";

/** Lo que el agente toca de una persona: llamada, mensaje o venta con firma. */
const HUMAN_TOUCH_KINDS = ["call", "message", "sale"];

/** Valores por `in (…)`: PostgREST con URLs largas falla, así que de a 200. */
const IN_CHUNK = 200;

type PageResult = PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** `select … in (valores)` por trozos, cada trozo drenado por páginas. LANZA si una lectura falla. */
async function selectIn<T>(
  table: string,
  values: readonly string[],
  page: (chunk: string[], from: number, to: number) => PageResult,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK);
    out.push(...(await drain<T>(table, (from, to) => page(chunk, from, to))));
  }
  return out;
}

const groupBy = <T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
};

/** Guarda el brazo de un lead. Devuelve el que quedó guardado, o null si no se pudo. */
async function storeArm(
  admin: SupabaseClient,
  row: { lead_id: string; store_id: string; experiment: string; arm: ExperimentArm },
): Promise<ExperimentArm | null> {
  const { error } = await admin.from("lead_experiments").insert(row);
  if (!error) return row.arm;
  // 23505 = otra pasada lo sorteó a la vez. La tabla es append-only y la
  // primera manda: se lee la que quedó.
  if (error.code !== "23505") return null;
  const { data } = await admin
    .from("lead_experiments")
    .select("arm")
    .eq("lead_id", row.lead_id)
    .eq("experiment", row.experiment)
    .maybeSingle();
  return ((data as { arm?: ExperimentArm } | null)?.arm ?? null) as ExperimentArm | null;
}

/**
 * La cola del agente de leads de una tienda. Con `leadId`, solo ese lead (el
 * panel del drawer). Con `assign`, guarda en `lead_experiments` el brazo de los
 * que se vuelven elegibles; sin él no escribe nada (prueba en seco, panel).
 *
 * Falla CERRADO: si una lectura falla, LANZA. Una cola armada con la lista «no
 * llamar» o los toques de las asesoras a medias llamaría a quien no debe.
 */
export async function loadLeadVoiceQueue(
  admin: SupabaseClient,
  store: LeadVoiceStore,
  now: Date,
  opts?: { leadId?: string; assign?: boolean },
): Promise<LeadVoiceQueue> {
  const settings = store.settings;
  const nowIso = now.toISOString();
  const oldest = new Date(now.getTime() - settings.maxAgeHours * HOUR).toISOString();
  const newest = new Date(now.getTime() - settings.waitMinutes * 60_000).toISOString();

  // La ventana va en la consulta solo para no leer la tienda entera; quien
  // decide es `leadVoiceEligible`. Con un lead, ninguna ventana: el panel
  // tiene que poder decir por qué ESE lead no entra.
  const leads = await drain<LeadVoiceQueueLead>("leads", (from, to) => {
    let q = admin.from("leads").select(QUEUE_LEAD_COLUMNS).eq("store_id", store.id);
    if (opts?.leadId) q = q.eq("id", opts.leadId);
    else {
      q = q
        .eq("source", "meta_ad")
        .in("category", ["open", "hot"])
        .in("status", ["nuevo", "volver_a_llamar"])
        .gte("inbound_count", 2)
        .not("phone", "is", null)
        .or(
          `and(status.eq.nuevo,last_inbound_at.gte.${oldest},last_inbound_at.lte.${newest}),` +
            `and(status.eq.volver_a_llamar,next_followup_at.lte.${nowIso},next_followup_at.gte.${oldest})`,
        );
    }
    return q.order("id").range(from, to);
  });
  const empty: LeadVoiceQueue = { candidates: [], reasons: {}, arms: {}, assigned: 0, seen: leads.length };
  if (!leads.length) return empty;

  const ids = leads.map((l) => l.id);
  const adIds = [...new Set(leads.map((l) => l.ad_id).filter((a): a is string => Boolean(a)))];

  const [ads, touches, attempts, dnc, stored] = await Promise.all([
    // `meta_ads` no tiene lectura por RLS: va con la llave de servicio.
    selectIn<{ ad_id: string; campaign_id: string | null }>("meta_ads", adIds, (chunk, from, to) =>
      admin.from("meta_ads").select("ad_id, campaign_id").in("ad_id", chunk).order("ad_id").range(from, to),
    ),
    selectIn<{ lead_id: string; occurred_at: string }>("lead_calls", ids, (chunk, from, to) =>
      admin
        .from("lead_calls")
        .select("id, lead_id, occurred_at")
        .in("lead_id", chunk)
        .in("kind", HUMAN_TOUCH_KINDS)
        .not("vendedora", "is", null)
        .order("id")
        .range(from, to),
    ),
    selectIn<LeadVoiceAttempt & { lead_id: string }>("voice_calls", ids, (chunk, from, to) =>
      admin
        .from("voice_calls")
        .select("id, lead_id, queued_at, status, outcome")
        .in("lead_id", chunk)
        .eq("purpose", LEAD_VOICE_PURPOSE)
        .eq("mode", "real")
        .order("id")
        .range(from, to),
    ),
    // La lista «no llamar» es una sola por tienda para los dos agentes (§33).
    loadDoNotCallPhones(admin, store.id),
    selectIn<{ lead_id: string; arm: ExperimentArm }>("lead_experiments", ids, (chunk, from, to) =>
      admin
        .from("lead_experiments")
        .select("lead_id, arm")
        .eq("experiment", LEAD_VOICE_EXPERIMENT)
        .in("lead_id", chunk)
        .order("lead_id")
        .range(from, to),
    ),
  ]);

  const campaignByAd = new Map(ads.map((a) => [a.ad_id, a.campaign_id ? String(a.campaign_id) : null]));
  const touchesBy = groupBy(touches, (t) => t.lead_id);
  const attemptsBy = groupBy(attempts, (a) => a.lead_id);
  const armBy = new Map(stored.map((r) => [r.lead_id, r.arm]));

  const verdictFor = (lead: LeadVoiceQueueLead, arm: ExperimentArm | null): LeadVoiceEligibility => {
    const firstSeen = Date.parse(lead.first_seen_at ?? "");
    return leadVoiceEligible({
      lead,
      now,
      settings,
      campaignId: lead.ad_id ? (campaignByAd.get(lead.ad_id) ?? null) : null,
      // Desde que llegó: lo que una asesora hizo antes con ese teléfono era otra conversación.
      humanTouched: (touchesBy.get(lead.id) ?? []).some(
        (t) => !Number.isFinite(firstSeen) || Date.parse(t.occurred_at) >= firstSeen,
      ),
      doNotCall: dnc.has(zadarmaLocalPeru(lead.phone) ?? "-"),
      attempts: attemptsBy.get(lead.id) ?? [],
      arm,
    });
  };

  const verdicts = new Map(leads.map((l) => [l.id, verdictFor(l, armBy.get(l.id) ?? null)]));
  const arms: Record<string, ExperimentArm> = Object.fromEntries(armBy);
  let assigned = 0;
  const unstored = new Set<string>();

  if (opts?.assign) {
    // El brazo se guarda la primera vez que el lead es elegible, sea cual sea:
    // el control también, o el análisis por intención de tratar no lo vería.
    const toStore = leads.filter((l) => {
      const v = verdicts.get(l.id)!;
      return v.assignNow && v.arm !== null;
    });
    const rows = toStore.map((l) => ({
      lead_id: l.id,
      store_id: store.id,
      experiment: LEAD_VOICE_EXPERIMENT,
      arm: verdicts.get(l.id)!.arm as ExperimentArm,
    }));
    if (rows.length) {
      const { error } = await admin.from("lead_experiments").insert(rows);
      if (!error) {
        for (const r of rows) arms[r.lead_id] = r.arm;
        assigned = rows.length;
      } else {
        // Un lote con un solo choque falla entero: se reintenta de a uno.
        for (const r of rows) {
          const kept = await storeArm(admin, r);
          if (!kept) {
            // Sin brazo guardado no se llama: el piloto no podría medirlo.
            unstored.add(r.lead_id);
            continue;
          }
          arms[r.lead_id] = kept;
          if (kept === r.arm) assigned += 1;
          // Otra pasada lo guardó con otro brazo (cambió el porcentaje): manda el guardado.
          else {
            const lead = leads.find((l) => l.id === r.lead_id)!;
            verdicts.set(r.lead_id, verdictFor(lead, kept));
          }
        }
        if (unstored.size) {
          console.error(`[voice-leads] ${unstored.size} brazo(s) sin guardar: ${error.message}`);
        }
      }
    }
  }

  const reasons: Record<string, LeadVoiceExclusion> = {};
  const candidates: LeadVoiceQueueEntry[] = [];
  for (const lead of leads) {
    const v = verdicts.get(lead.id)!;
    if (!v.ok) {
      reasons[lead.id] = v.reason;
      continue;
    }
    if (unstored.has(lead.id)) continue;
    candidates.push({
      lead,
      kind: v.kind,
      arm: v.arm,
      attempt: (attemptsBy.get(lead.id) ?? []).filter(attemptCounts).length + 1,
      campaignId: lead.ad_id ? (campaignByAd.get(lead.ad_id) ?? null) : null,
    });
  }
  return { candidates: sortLeadVoiceQueue(candidates), reasons, arms, assigned, seen: leads.length };
}

/** Tope de Kapso al marcar: la persona no puede esperar a que conteste. */
const KAPSO_BUDGET_MS = 4_000;

/** La conversación del lead para el agente, o null si Kapso no respondió a tiempo. */
async function chatDelLead(admin: SupabaseClient, storeId: string, conversationId: string): Promise<string | null> {
  const { data, error } = await admin.from("stores").select("kapso_api_key_enc").eq("id", storeId).maybeSingle();
  if (error) return null;
  let apiKey: string | null = null;
  try {
    // Solo la llave de Kapso: `getStoreCreds` descifra todas las de la tienda.
    apiKey = decryptOrNull((data as { kapso_api_key_enc?: string | null } | null)?.kapso_api_key_enc);
  } catch {
    return null;
  }
  if (!apiKey) return null;
  // Una sola señal para todos los intentos: `kapsoGet` reintenta, y cada
  // reintento con su propio tope sumaría varias veces los 4 s.
  const signal = AbortSignal.timeout(KAPSO_BUDGET_MS);
  const fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, { ...init, signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Kapso no respondió a tiempo")), KAPSO_BUDGET_MS);
  });
  try {
    const msgs = await Promise.race([fetchConversationTranscript({ apiKey, fetchImpl }, conversationId, 1), deadline]);
    return chatParaAgente(msgs);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lo que el agente va a escuchar: la ficha y la conversación de WhatsApp,
 * leída de Kapso con un tope de tiempo. Si Kapso no responde, se llama igual
 * con el primer mensaje del lead (`chat_ok = false`).
 */
export async function buildLeadContext(
  admin: SupabaseClient,
  store: LeadVoiceStore,
  entry: LeadVoiceQueueEntry,
  now: Date,
  mode: "real" | "test",
): Promise<LeadContext> {
  const convId = entry.lead.kapso_conversation_id;
  const chat = convId ? await chatDelLead(admin, store.id, convId) : null;
  const ficha = buildLeadFicha({
    lead: entry.lead,
    storeName: store.name,
    settings: store.settings,
    chat: chat ?? "",
    now,
    attempt: entry.attempt,
    kind: entry.kind,
    mode,
  });
  return {
    ficha,
    estado_al_marcar: entry.lead.status,
    tipo: entry.kind,
    intento: entry.attempt,
    max_intentos: store.settings.maxAttempts,
    campaign_id: entry.campaignId,
    chat_ok: chat !== null,
  };
}

export interface PlaceLeadCallInput {
  storeId: string;
  leadId: string;
  /** A quién se marca: el lead, o el teléfono del probador en modo prueba. */
  phone: string;
  mode: "real" | "test";
  triggeredBy: string | null;
  context: LeadContext;
}

export type PlaceLeadCallResult =
  | { ok: true; callId: string; from: string }
  | { ok: false; status: number; error: string; callId?: string };

/**
 * Fila primero (`purpose = 'lead'`, carril `LEAD_VOICE_LANE`), después el
 * tramo a la persona por Telnyx. Nunca pasa por `placeVoiceCall`: no hay pedido
 * ni candado Swayp.
 */
export async function placeLeadCall(
  admin: SupabaseClient,
  input: PlaceLeadCallInput,
  now: Date,
): Promise<PlaceLeadCallResult> {
  // Solo celulares: un fijo no es de quien escribió por WhatsApp. La fila
  // guarda el número como las demás (`zadarmaLocalPeru`) y Telnyx marca E.164.
  const phone = leadVoicePhone(input.phone) ? zadarmaLocalPeru(input.phone) : null;
  const to = phone ? telnyxPeruE164(phone) : null;
  if (!phone || !to) return { ok: false, status: 400, error: "El teléfono no es un celular peruano válido." };

  // La configuración se mira ANTES de escribir la fila: si falta, se dice así,
  // en vez de dejar una fila «marcando» que ocupa el carril del agente.
  const cfg = telnyxConfig();
  if ("error" in cfg) return { ok: false, status: 500, error: cfg.error };
  if (!env.telnyxLeadsSipUri()) {
    return {
      ok: false,
      status: 500,
      error: "Falta TELNYX_LEADS_SIP_URI en Vercel: la puerta SIP del agente de leads.",
    };
  }
  // Sin su secreto el agente no recibe la ficha ni puede registrar: sería una
  // llamada pagada que no deja nada.
  if (!leadSecret()) {
    return {
      ok: false,
      status: 500,
      error: "Falta VOICE_LEADS_TOOLS_SECRET en Vercel (propio, distinto de los de Reproprovincia).",
    };
  }

  await sweepStaleCalls(admin, now);

  const { data: inserted, error: insertError } = await admin
    .from("voice_calls")
    .insert({
      store_id: input.storeId,
      lead_id: input.leadId,
      order_id: null,
      purpose: LEAD_VOICE_PURPOSE,
      mode: input.mode,
      telephony: "telnyx",
      provider: "elevenlabs",
      agent_number: LEAD_VOICE_LANE,
      phone,
      // `dialing` ANTES de pedir la llamada: el inicio de conversación puede
      // llegar en cuanto la persona contesta, y la fila tiene que estar.
      status: "dialing",
      dialed_at: now.toISOString(),
      triggered_by: input.triggeredBy,
      lead_context: input.context,
    })
    .select("id")
    .single();
  if (insertError) {
    // Un solo carril para el agente de leads: el índice de una abierta por número.
    const busy = insertError.code === "23505";
    return {
      ok: false,
      status: busy ? 409 : 500,
      error: busy ? "El agente de leads ya está en otra llamada." : insertError.message,
    };
  }
  const callId = (inserted as { id: string }).id;

  // El número que ve el lead es el suyo (o el del Agente Telnyx si no hay).
  const legCfg = { ...cfg, fromNumber: env.telnyxLeadsFromNumber() };
  const dialed = await dialTelnyx(legCfg, clienteDialBody(legCfg, callId, to));
  if (!dialed.ok) {
    // `cancelled`: a la persona no le sonó nada, así que no gasta intento
    // (`attemptCounts`). `failed` queda para lo que sí marcó y se cayó.
    await admin
      .from("voice_calls")
      .update({
        status: "cancelled",
        outcome: "sin_resultado",
        error: dialed.error ?? "Telnyx no marcó.",
        telephony_response: dialed.response ?? null,
        ended_at: new Date().toISOString(),
      })
      .eq("id", callId);
    return { ok: false, status: 502, error: dialed.error ?? "Telnyx no marcó.", callId };
  }
  await admin
    .from("voice_calls")
    .update({
      provider_call_id: dialed.callControlId,
      telephony_response: { cliente: dialed.callControlId, eventos: [] },
    })
    .eq("id", callId);
  return { ok: true, callId, from: legCfg.fromNumber };
}

/**
 * La llamada de lead a la que se ata una tool: la del `voice_call_id` que el
 * agente recibió al conectar o, sin él, la ÚNICA de lead en el estado pedido.
 * Solo filas `purpose = 'lead'`: una tool de leads nunca toca una de pedido.
 */
export async function bindLeadCall(
  admin: SupabaseClient,
  voiceCallId: string | null | undefined,
  wanted: "in_progress" | "open",
  now: Date,
): Promise<{ call: LeadCallRow } | { error: string }> {
  const open = new Set(["queued", "dialing", "in_progress"]);
  const fits = (status: string) => (wanted === "open" ? open.has(status) : status === wanted);
  const id = String(voiceCallId ?? "").trim();
  if (id) {
    const call = await loadLeadCall(admin, id);
    return call && fits(call.status) ? { call } : { error: "sin llamada en curso" };
  }
  const calls = await openCalls(admin, "lead");
  let picked = pickOpenCall(calls, "in_progress", { now });
  // Si el inicio de conversación no llegó, la fila sigue «marcando».
  if ("error" in picked && wanted === "open") picked = pickOpenCall(calls, "dialing", { now });
  if ("error" in picked) return { error: `sin llamada en curso (${picked.error})` };
  const call = await loadLeadCall(admin, picked.call.id);
  return call ? { call } : { error: "sin llamada en curso" };
}

/**
 * La sincronización de conversaciones puede pisar un «Atender ahora» recién
 * escrito por el agente con lo que leyó antes (lib/leads-ingest, carrera
 * conocida). Se reponen los del agente de las últimas 24 h que quedaron en
 * `nuevo` sin atención. Devuelve cuántos repuso.
 */
export async function reflagAgentHandoffs(admin: SupabaseClient, storeId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 24 * HOUR).toISOString();
  const { data, error } = await admin
    .from("leads")
    .update({ status: "casi_cierra", category: categoryOf("casi_cierra"), needs_attention: true })
    .eq("store_id", storeId)
    .eq("handoff_reason", LEAD_VOICE_HANDOFF_REASON)
    .gt("handoff_at", since)
    .eq("status", "nuevo")
    .eq("needs_attention", false)
    .select("id");
  if (error) throw new Error(`leads: ${error.message}`);
  return (data ?? []).length;
}

/** La cobertura que el agente explica (`order_coverage_for`, la del Master). */
export async function leadVoiceCoverage(
  admin: SupabaseClient,
  storeId: string,
  place: { distrito?: string | null; provincia?: string | null; departamento?: string | null },
  now: Date,
): Promise<CoberturaParaAgente> {
  const text = (v: string | null | undefined) => String(v ?? "").trim() || null;
  const { data, error } = await admin.rpc("order_coverage_for", {
    p_store_id: storeId,
    p_region: text(place.departamento),
    p_province: text(place.provincia),
    p_district: text(place.distrito),
    p_day: voiceDates(now).hoy,
  });
  // Sin respuesta, «por revisar»: el agente pregunta y una asesora confirma.
  if (error) return coberturaParaAgente(null);
  return coberturaParaAgente(typeof data === "string" ? data : null);
}

// ── Aviso «post-call» de ElevenLabs ─────────────────────────────────────────

/** Tolerancia de la firma: la que recomienda ElevenLabs. */
const ELEVENLABS_SIGNATURE_TOLERANCE_S = 30 * 60;

/**
 * Firma del aviso de ElevenLabs: cabecera `elevenlabs-signature` con
 * `t=<unix>,v0=<hex>`, donde hex = HMAC-SHA256(secreto, `${t}.${cuerpo}`).
 * Un secreto vacío nunca autoriza; una firma de hace más de 30 min tampoco
 * (un aviso grabado no se puede volver a mandar).
 */
export function verifyElevenLabsSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  now: Date,
): boolean {
  if (!secret || !header) return false;
  let t = "";
  const firmas: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v0") firmas.push(v.toLowerCase());
  }
  if (!/^\d{1,12}$/.test(t) || !firmas.length) return false;
  if (Math.abs(now.getTime() / 1000 - Number(t)) > ELEVENLABS_SIGNATURE_TOLERANCE_S) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), "utf8");
  return firmas.some((f) => {
    const got = Buffer.from(f, "utf8");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export interface LeadTranscript {
  conversation_id: string | null;
  agent_id: string | null;
  duracion_s: number | null;
  /** `metadata.cost` de ElevenLabs, tal cual lo manda. */
  costo: number | null;
  turnos: { rol: string; texto: string; t: number | null }[];
  resumen: string | null;
}

const MAX_TURNOS = 80;
const MAX_TEXTO = 500;

/**
 * Lo que se guarda en `voice_calls.transcript` de una llamada de lead. PURA.
 * Con más de 80 turnos se quedan los ÚLTIMOS: ahí está lo que decidió la
 * persona y lo que el agente registró.
 */
export function leadTranscriptFrom(data: unknown): LeadTranscript {
  const d = (data ?? {}) as {
    conversation_id?: unknown;
    agent_id?: unknown;
    transcript?: unknown;
    metadata?: { call_duration_secs?: unknown; cost?: unknown } | null;
    analysis?: { transcript_summary?: unknown } | null;
  };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const turnos = (Array.isArray(d.transcript) ? d.transcript : [])
    .map((raw) => {
      const tu = (raw ?? {}) as { role?: unknown; message?: unknown; time_in_call_secs?: unknown };
      const texto = String(tu.message ?? "").replace(/\s+/g, " ").trim();
      const rol = tu.role === "agent" ? "agente" : tu.role === "user" ? "cliente" : String(tu.role ?? "");
      return { rol, texto: texto.slice(0, MAX_TEXTO), t: num(tu.time_in_call_secs) };
    })
    // Los turnos sin texto son llamadas a tools: no dicen nada a quien lee.
    .filter((tu) => tu.texto)
    .slice(-MAX_TURNOS);
  const resumen = str(d.analysis?.transcript_summary);
  return {
    conversation_id: str(d.conversation_id),
    agent_id: str(d.agent_id),
    duracion_s: num(d.metadata?.call_duration_secs),
    costo: num(d.metadata?.cost),
    turnos,
    resumen: resumen ? resumen.slice(0, 2000) : null,
  };
}

// ── El piloto: lo que se mide ───────────────────────────────────────────────

export interface LeadVoicePilotArm {
  arm: ExperimentArm;
  /** Leads sorteados a este brazo. */
  leads: number;
  /** Leads a los que el agente llamó al menos una vez (modo real). */
  llamados: number;
  /** Leads que contestaron al agente. */
  contestaron: number;
  /** Leads que el agente pasó a «Atender ahora». */
  atenderAhora: number;
  /** Leads que una asesora tocó después del sorteo (llamada, mensaje o venta). */
  tocadosPorAsesora: number;
  /** Leads con pedido (ganados), del canal que sea. */
  ventas: number;
  /** ventas / leads, en %; null sin leads. */
  conversion: number | null;
}

export interface LeadVoicePilotReport {
  /** Primera asignación del piloto en la tienda; null si todavía no hay. */
  since: string | null;
  arms: LeadVoicePilotArm[];
  agente: {
    llamadas: number;
    contestadas: number;
    atenderAhora: number;
    volverALlamar: number;
    noCompra: number;
    noLlamar: number;
    noContesta: number;
    /** Contestó y se cortó sin que el agente registrara nada. */
    sinGestion: number;
    /** Lo que cobró Telnyx (US$), solo de las llamadas con costo avisado. */
    costoLinea: number;
    conCosto: number;
  };
  /** Por qué no compran, de los «no compra» del agente. */
  motivos: { motivo: string; n: number }[];
}

/** Los resultados que el agente registra él mismo (lo demás, contestado, es «sin gestión»). */
const LEAD_GESTION = new Set(["atender_ahora", "volver_a_llamar", "no_compra", "no_llamar"]);

/**
 * El tablero del piloto, por brazo y por intención de tratar: un lead del
 * tratamiento cuenta aunque el agente no haya llegado a llamarlo. Se compara
 * la conversión del tratamiento contra la del control (MOM §33).
 */
export async function loadLeadVoicePilotReport(
  admin: SupabaseClient,
  storeId: string,
  now: Date,
): Promise<LeadVoicePilotReport> {
  // La firma lleva `now` como las demás lecturas del agente; el tablero mira
  // todo el piloto, sin corte de fecha.
  void now;
  const assignments = await drain<{ lead_id: string; arm: ExperimentArm; assigned_at: string }>(
    "lead_experiments",
    (from, to) =>
      admin
        .from("lead_experiments")
        .select("lead_id, arm, assigned_at")
        .eq("experiment", LEAD_VOICE_EXPERIMENT)
        .eq("store_id", storeId)
        .order("lead_id")
        .range(from, to),
  );
  const ids = assignments.map((a) => a.lead_id);

  type Call = {
    lead_id: string;
    status: string;
    queued_at: string;
    started_at: string | null;
    outcome: string | null;
    error: string | null;
    motivo: string | null;
    costo: number | null;
  };
  const [leads, calls, touches] = await Promise.all([
    selectIn<{ id: string; category: string | null; has_order: boolean | null; order_id: string | null }>(
      "leads",
      ids,
      (chunk, from, to) =>
        admin.from("leads").select("id, category, has_order, order_id").in("id", chunk).order("id").range(from, to),
    ),
    selectIn<Call>("voice_calls", ids, (chunk, from, to) =>
      admin
        .from("voice_calls")
        .select(
          "id, lead_id, status, queued_at, started_at, outcome, error, motivo:outcome_payload->>motivo, costo:telephony_response->costo->total",
        )
        .in("lead_id", chunk)
        .eq("purpose", LEAD_VOICE_PURPOSE)
        .eq("mode", "real")
        .order("id")
        .range(from, to),
    ),
    selectIn<{ lead_id: string; occurred_at: string }>("lead_calls", ids, (chunk, from, to) =>
      admin
        .from("lead_calls")
        .select("id, lead_id, occurred_at")
        .in("lead_id", chunk)
        .in("kind", HUMAN_TOUCH_KINDS)
        .not("vendedora", "is", null)
        .order("id")
        .range(from, to),
    ),
  ]);

  const leadBy = new Map(leads.map((l) => [l.id, l]));
  // Solo las que de verdad marcaron: una que Telnyx rechazó (`cancelled`) no es una llamada.
  const callsBy = groupBy(
    calls.filter((c) => attemptCounts(c)),
    (c) => c.lead_id,
  );
  const touchesBy = groupBy(touches, (t) => t.lead_id);

  const arms: LeadVoicePilotArm[] = (["tratamiento", "control"] as const).map((arm) => {
    const row: LeadVoicePilotArm = {
      arm,
      leads: 0,
      llamados: 0,
      contestaron: 0,
      atenderAhora: 0,
      tocadosPorAsesora: 0,
      ventas: 0,
      conversion: null,
    };
    for (const a of assignments) {
      if (a.arm !== arm) continue;
      row.leads += 1;
      const own = callsBy.get(a.lead_id) ?? [];
      if (own.length) row.llamados += 1;
      if (own.some((c) => voiceCallAnswered(c))) row.contestaron += 1;
      if (own.some((c) => c.outcome === "atender_ahora")) row.atenderAhora += 1;
      const assignedMs = Date.parse(a.assigned_at);
      if ((touchesBy.get(a.lead_id) ?? []).some((t) => Date.parse(t.occurred_at) > assignedMs)) {
        row.tocadosPorAsesora += 1;
      }
      const l = leadBy.get(a.lead_id);
      if (l && (l.has_order === true || l.order_id || l.category === "won")) row.ventas += 1;
    }
    row.conversion = row.leads ? Math.round((row.ventas / row.leads) * 1000) / 10 : null;
    return row;
  });

  const agente: LeadVoicePilotReport["agente"] = {
    llamadas: 0,
    contestadas: 0,
    atenderAhora: 0,
    volverALlamar: 0,
    noCompra: 0,
    noLlamar: 0,
    noContesta: 0,
    sinGestion: 0,
    costoLinea: 0,
    conCosto: 0,
  };
  const motivos = new Map<string, number>();
  for (const own of callsBy.values()) {
    for (const c of own) {
      agente.llamadas += 1;
      const answered = voiceCallAnswered(c);
      if (answered) {
        agente.contestadas += 1;
        if (!LEAD_GESTION.has(c.outcome ?? "")) agente.sinGestion += 1;
      }
      if (c.outcome === "atender_ahora") agente.atenderAhora += 1;
      if (c.outcome === "volver_a_llamar") agente.volverALlamar += 1;
      if (c.outcome === "no_llamar") agente.noLlamar += 1;
      if (c.outcome === "no_contesta") agente.noContesta += 1;
      if (c.outcome === "no_compra") {
        agente.noCompra += 1;
        const m = c.motivo || "otro";
        motivos.set(m, (motivos.get(m) ?? 0) + 1);
      }
      if (typeof c.costo === "number" && Number.isFinite(c.costo)) {
        agente.costoLinea += c.costo;
        agente.conCosto += 1;
      }
    }
  }
  agente.costoLinea = Math.round(agente.costoLinea * 10_000) / 10_000;

  const since = assignments.reduce<string | null>(
    (min, a) => (!min || Date.parse(a.assigned_at) < Date.parse(min) ? a.assigned_at : min),
    null,
  );
  return {
    since,
    arms,
    agente,
    motivos: [...motivos.entries()]
      .map(([motivo, n]) => ({ motivo, n }))
      .sort((a, b) => b.n - a.n || a.motivo.localeCompare(b.motivo)),
  };
}
