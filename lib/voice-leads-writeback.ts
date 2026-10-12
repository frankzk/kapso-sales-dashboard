// Agente de voz para leads — lo que se escribe sobre el lead (MOM §33).
//
// Módulo aparte de `voice-leads-server` para que el vigilante de llamadas de
// Reproprovincia (`closeAsNoAnswer`, en `voice-recovery-server`) pueda cerrar
// una llamada de lead sin importar todo el servidor del agente de leads.
//
// NUNCA escribe sobre un pedido: ni `register_confirmation_attempt_v2`, ni
// `order_master`, ni `shipment_calls`.

import type { SupabaseClient } from "@supabase/supabase-js";
import { defaultFollowupAt } from "@/lib/leads";
import {
  LEAD_VOICE_KIND,
  LEAD_VOICE_PURPOSE,
  attemptCounts,
  leadPatchFor,
  leadVoiceSettingsFrom,
  noAnswerNote,
  type LeadContext,
  type LeadResultAction,
  type LeadVoiceAttempt,
} from "@/lib/voice-leads";

/** La fila de una llamada de lead, con lo que el registro necesita. */
export interface LeadCallRow {
  id: string;
  store_id: string;
  lead_id: string;
  mode: "real" | "test";
  status: string;
  outcome: string | null;
  dialed_at: string | null;
  started_at: string | null;
  lead_context: LeadContext | null;
}

export type LeadApplySkip = "gestion_humana_posterior" | "estado_cambio" | "ganado" | "sin_lead";

/** Lo que dice la nota del historial cuando el resultado no se aplicó al lead. */
const SKIP_TEXT: Record<LeadApplySkip, string> = {
  gestion_humana_posterior: "una asesora lo gestionó durante la llamada",
  estado_cambio: "el lead cambió de estado durante la llamada",
  ganado: "el lead ya tiene pedido",
  sin_lead: "el lead ya no existe",
};

/** Estados en los que el agente todavía puede mover un lead: ni ganado ni perdido. */
const OPEN_CATEGORIES = ["open", "hot"];

/** La fila de la llamada si es de lead (`purpose = 'lead'` con `lead_id`); si no, null. */
export async function loadLeadCall(admin: SupabaseClient, id: string): Promise<LeadCallRow | null> {
  const { data, error } = await admin
    .from("voice_calls")
    .select("id, store_id, lead_id, mode, status, outcome, dialed_at, started_at, lead_context, purpose")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Omit<LeadCallRow, "lead_id"> & { lead_id: string | null; purpose: string | null };
  // Una fila de pedido nunca llega a las tools de leads, aunque alguien pase su id.
  if (row.purpose !== LEAD_VOICE_PURPOSE || !row.lead_id) return null;
  return {
    id: row.id,
    store_id: row.store_id,
    lead_id: row.lead_id,
    mode: row.mode,
    status: row.status,
    outcome: row.outcome,
    dialed_at: row.dialed_at,
    started_at: row.started_at,
    lead_context: row.lead_context ?? null,
  };
}

interface NoteInput {
  lead_id: string;
  store_id: string;
  new_status: string | null;
  note: string;
  next_followup_at: string | null;
  occurred_at: string;
}

/**
 * La nota del agente en el historial del lead. `kind = voice_agent` y SIN
 * vendedora: `call` con firma es una persona, y así la leen los experimentos,
 * la cobertura y Productividad.
 */
async function insertAgentNote(admin: SupabaseClient, n: NoteInput): Promise<string | null> {
  const { error } = await admin.from("lead_calls").insert({ ...n, vendedora: null, kind: LEAD_VOICE_KIND });
  return error ? error.message : null;
}

/**
 * Aplica sobre el lead un resultado que registró el agente (modo real). Siempre
 * deja la nota en el historial (`lead_calls`, kind `voice_agent`, sin firma de
 * persona); el `update` del lead solo si nadie lo movió durante la llamada.
 */
export async function applyLeadVoiceResult(
  admin: SupabaseClient,
  call: LeadCallRow,
  action: Extract<LeadResultAction, { kind: "apply" }>,
  now: Date,
): Promise<{ applied: boolean; skipped: LeadApplySkip | null; error: string | null }> {
  // Modo prueba: el teléfono era el de quien probaba. Nada sobre el lead.
  if (call.mode !== "real") return { applied: false, skipped: null, error: null };
  const nowIso = now.toISOString();
  const ctx = call.lead_context;
  // Lo de una asesora que pasó DESPUÉS de marcar gana: la llamada no lo sabía.
  const since = call.dialed_at ?? call.started_at ?? nowIso;

  const [leadRes, storeRes, humanRes] = await Promise.all([
    admin
      .from("leads")
      .select("id, status, category, has_order, order_id, next_followup_at")
      .eq("id", call.lead_id)
      .eq("store_id", call.store_id)
      .maybeSingle(),
    admin.from("stores").select("timezone, voice_lead_max_attempts").eq("id", call.store_id).maybeSingle(),
    admin
      .from("lead_calls")
      .select("id")
      .eq("lead_id", call.lead_id)
      .not("vendedora", "is", null)
      .gt("occurred_at", since)
      .limit(1),
  ]);
  if (!leadRes.error && !leadRes.data) return { applied: false, skipped: "sin_lead", error: null };
  const lead = leadRes.data as {
    status: string;
    category: string;
    has_order: boolean | null;
    order_id: string | null;
    next_followup_at: string | null;
  } | null;
  const store = storeRes.data as { timezone?: string | null; voice_lead_max_attempts?: number | null } | null;

  let error: string | null = null;

  // No contactar va SIEMPRE, aunque la guarda de estado diga que no: es la
  // voluntad de la persona, no una disposición que una asesora pueda pisar.
  // Update aparte y solo de esa columna; la primera fecha se conserva.
  if (action.optOut) {
    const { error: optErr } = await admin
      .from("leads")
      .update({ contact_opt_out_at: nowIso })
      .eq("id", call.lead_id)
      .eq("store_id", call.store_id)
      .is("contact_opt_out_at", null);
    if (optErr) error = optErr.message;
  }

  // No contestó (lo registró el agente al oír un buzón): el lead no cambia, ni
  // `last_interaction_at`, que mueve el archivado y el orden de la cola.
  if (!action.status) {
    const max = ctx?.max_intentos ?? leadVoiceSettingsFrom({ id: call.store_id, name: null, ...store }).maxAttempts;
    const noteErr = await insertAgentNote(admin, {
      lead_id: call.lead_id,
      store_id: call.store_id,
      new_status: null,
      note:
        action.outcome === "no_contesta" ? noAnswerNote(action.resumen, ctx?.intento ?? 1, max) : action.note,
      next_followup_at: null,
      occurred_at: nowIso,
    });
    return { applied: false, skipped: null, error: error ?? noteErr };
  }

  let applied = false;
  let skipped: LeadApplySkip | null = null;
  let patch: Record<string, unknown> | null = null;
  const readError = leadRes.error?.message ?? humanRes.error?.message ?? null;
  if (readError || !lead) {
    // Sin poder comprobar las guardas no se escribe: falla cerrado.
    error = error ?? readError ?? "no se pudo leer el lead";
  } else if (lead.has_order === true || lead.order_id || lead.category === "won") {
    skipped = "ganado";
  } else if ((humanRes.data ?? []).length > 0) {
    skipped = "gestion_humana_posterior";
  } else if (!ctx?.estado_al_marcar || lead.status !== ctx.estado_al_marcar || !OPEN_CATEGORIES.includes(lead.category)) {
    skipped = "estado_cambio";
  } else {
    patch = leadPatchFor(action, {
      nowIso,
      defaultFollowup: defaultFollowupAt(nowIso, store?.timezone ?? "America/Lima"),
      currentFollowup: lead.next_followup_at,
    });
    if (patch) {
      // Ya va en su propio update, arriba.
      delete patch.contact_opt_out_at;
      // La guarda de verdad es este update condicional: la lectura de arriba
      // solo explica por qué no se aplicó.
      const { data: updated, error: updErr } = await admin
        .from("leads")
        .update(patch)
        .eq("id", call.lead_id)
        .eq("store_id", call.store_id)
        .eq("status", ctx.estado_al_marcar)
        .in("category", OPEN_CATEGORIES)
        .eq("has_order", false)
        .select("id");
      if (updErr) error = updErr.message;
      else if ((updated ?? []).length) applied = true;
      else skipped = "estado_cambio";
    }
  }

  const why = skipped ? SKIP_TEXT[skipped] : error ? "no se pudo comprobar el lead" : null;
  const noteErr = await insertAgentNote(admin, {
    lead_id: call.lead_id,
    store_id: call.store_id,
    new_status: applied ? action.status : null,
    // La evidencia queda aunque no se aplique: la asesora ve qué dijo la persona.
    note: applied || !why ? action.note : `(no aplicado: ${why}) ${action.note}`,
    next_followup_at: applied ? ((patch?.next_followup_at as string | null | undefined) ?? null) : null,
    occurred_at: nowIso,
  });
  return { applied, skipped, error: error ?? noteErr };
}

/**
 * Nadie contestó (lo registró la línea o el vigilante). El lead NO cambia —ni
 * estado, ni `last_interaction_at`, que mueve el archivado y el orden de la
 * cola—; solo queda la nota del intento. Modo prueba: nada.
 */
export async function writeLeadNoAnswer(
  admin: SupabaseClient,
  call: { id: string; store_id: string; lead_id: string | null; mode: "real" | "test" },
  resumen: string,
  now: Date,
): Promise<void> {
  if (call.mode !== "real" || !call.lead_id) return;
  const [ctxRes, attemptsRes] = await Promise.all([
    admin.from("voice_calls").select("lead_context").eq("id", call.id).maybeSingle(),
    admin
      .from("voice_calls")
      .select("queued_at, status, outcome")
      .eq("lead_id", call.lead_id)
      .eq("purpose", LEAD_VOICE_PURPOSE)
      .eq("mode", "real"),
  ]);
  if (attemptsRes.error) throw new Error(`voice_calls: ${attemptsRes.error.message}`);
  // Esta llamada ya quedó cerrada como «no contesta» y cuenta como intento.
  const attempt = Math.max(1, ((attemptsRes.data ?? []) as LeadVoiceAttempt[]).filter(attemptCounts).length);
  let max = (ctxRes.data as { lead_context?: LeadContext | null } | null)?.lead_context?.max_intentos ?? null;
  if (!max) {
    const { data: store } = await admin.from("stores").select("voice_lead_max_attempts").eq("id", call.store_id).maybeSingle();
    max = leadVoiceSettingsFrom({ id: call.store_id, name: null, ...(store as { voice_lead_max_attempts?: number | null } | null) })
      .maxAttempts;
  }
  const noteErr = await insertAgentNote(admin, {
    lead_id: call.lead_id,
    store_id: call.store_id,
    new_status: null,
    note: noAnswerNote(resumen, attempt, max),
    next_followup_at: null,
    occurred_at: now.toISOString(),
  });
  if (noteErr) throw new Error(`lead_calls: ${noteErr}`);
}
