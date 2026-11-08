// Los avisos de Anura («Llamar con Anura», fase 1). SERVIDOR.
//
// Anura manda START, TALK y END de cada llamada de los anexos con la
// plantilla de `ANURA_EVENT_TEMPLATE`, sin autenticación propia: el token va
// en la URL (`?org=<orgId>&t=<token>`, lib/anura/token.ts; también se acepta
// `Authorization: Bearer`).
//
//   · Token malo → 401. TODO lo demás → 200, aunque se ignore o falle: si no,
//     Anura reintenta. Lo ocurrido queda en `anura_webhook_events`.
//   · La llamada se encuentra primero por `custom1` (`kapta-<id>`) y después
//     por `callId` (el `cdrid`, que se guarda con el primer aviso).
//   · El rango solo sube; un aviso repetido no cambia nada (idempotente).
//   · Entrante sin fila: se registra como hecho informativo (`entrante`),
//     con el número enmascarado.
//     Saliente que no se pidió desde Kapta: se ignora (como Rentabilify).
//   · Al terminar una llamada de pedido, el hecho va al historial del pedido;
//     si trae grabación de un host de Anura, se copia a Storage después de
//     responder (cualquier otro enlace se descarta y queda en la bitácora).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ANURA_EVENT_RETENTION_DAYS,
  applyAnuraEvent,
  callIdFromCustom1,
  eventTarget,
  maskPhone,
  maskedEventPayload,
  normalizeAnuraExtension,
  parseAnuraEvent,
  type AnuraEvent,
  type AnuraTransition,
} from "@/lib/anura/events";
import { anuraWebhookTokenValid } from "@/lib/anura/token";
import { env } from "@/lib/env";
import { ANURA_CALL_COLUMNS, recordAnuraOrderFact, type AnuraCallRow } from "@/lib/anura/calls";
import { RECORDING_CALL_COLUMNS, recordingExpiresAt, saveAnuraRecording, type RecordingCallRow } from "@/lib/anura/recording";

/** El cuerpo de un aviso es pequeño; más que esto no es de Anura. */
export const ANURA_WEBHOOK_MAX_BYTES = 32 * 1024;

export type AnuraWebhookOutcome = "aplicado" | "repetido" | "ignorado" | "error";

export interface AnuraWebhookInput {
  org: string | null;
  token: string | null;
  authorization?: string | null;
  body: string;
}

export interface AnuraWebhookDeps {
  admin: SupabaseClient;
  now?: Date;
  /** ENCRYPTION_KEY; por defecto la del entorno. */
  key?: string;
  /** Trabajo después de responder (`after` en la ruta). Sin él, se espera. */
  defer?: (work: () => Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
  /** Hosts extra de grabación; por defecto `ANURA_RECORDING_HOSTS`. */
  extraRecordingHosts?: readonly string[];
}

export interface AnuraWebhookResult {
  status: 200 | 401;
  body: { ok: boolean; outcome?: AnuraWebhookOutcome; error?: string };
}

interface Processed {
  outcome: AnuraWebhookOutcome;
  detail: string;
  callId: string | null;
  recording?: { callId: string; url: string };
}

function bearer(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec((header ?? "").trim());
  return m ? m[1]!.trim() : null;
}

/**
 * Los anexos activos de la org que son de una persona: anexo → persona. Una
 * línea compartida (0313) no tiene dueña: una entrante a ella no la «toma
 * una asesora» (Kapta no recibe llamadas).
 */
async function advisorExtensions(admin: SupabaseClient, orgId: string): Promise<Map<string, string>> {
  const { data } = await admin.from("anura_extensions").select("extension,user_id").eq("org_id", orgId).eq("active", true);
  const out = new Map<string, string>();
  for (const r of (data ?? []) as { extension: string; user_id: string | null }[]) if (r.user_id) out.set(r.extension, r.user_id);
  return out;
}

async function findCall(admin: SupabaseClient, orgId: string, ev: AnuraEvent): Promise<{ row: AnuraCallRow | null; ours: boolean }> {
  const own = callIdFromCustom1(ev.custom1);
  if (own) {
    const { data } = await admin.from("anura_calls").select(ANURA_CALL_COLUMNS).eq("id", own).eq("org_id", orgId).maybeSingle();
    if (data) return { row: data as unknown as AnuraCallRow, ours: true };
  }
  if (ev.callId) {
    const { data } = await admin
      .from("anura_calls")
      .select(ANURA_CALL_COLUMNS)
      .eq("org_id", orgId)
      .eq("anura_call_id", ev.callId)
      .maybeSingle();
    if (data) return { row: data as unknown as AnuraCallRow, ours: true };
  }
  return { row: null, ours: own !== null };
}

/** Lo que el aviso escribe en la fila, además del estado. */
function patchFor(row: AnuraCallRow, ev: AnuraEvent, t: AnuraTransition | null, exts: Map<string, string>, now: Date): Record<string, unknown> {
  const nowIso = now.toISOString();
  const patch: Record<string, unknown> = { last_event_at: nowIso };
  if (!row.anura_call_id && ev.callId) patch.anura_call_id = ev.callId;
  if (!t) return patch;
  patch.status = t.status;
  patch.status_rank = t.rank;
  patch.closed_by_timeout = false;
  patch.failure_reason = t.failureReason;
  if (!row.started_at) patch.started_at = nowIso;
  if ((t.status === "en_curso" || t.status === "contestada") && !row.answered_at) patch.answered_at = nowIso;
  if (t.final) {
    patch.ended_at = nowIso;
    patch.bill_seconds = ev.billSeconds;
    patch.anura_status = ev.status;
    patch.answer_extension = normalizeAnuraExtension(ev.answerExtension);
    patch.was_recorded = ev.wasRecorded;
    if (row.direction === "in" && !row.user_id && ev.answerExtension && exts.has(ev.answerExtension)) {
      patch.user_id = exts.get(ev.answerExtension);
    }
    if (ev.recordingUrl && row.recording_status !== "guardada") {
      patch.recording_status = "pendiente";
      patch.recording_expires_at = recordingExpiresAt(now);
      patch.recording_attempts = 0;
      patch.recording_error = null;
    }
  }
  return patch;
}

/** Aplica el aviso a una fila conocida, con concurrencia optimista sobre el estado. */
async function applyToRow(
  admin: SupabaseClient,
  initial: AnuraCallRow,
  ev: AnuraEvent,
  exts: Map<string, string>,
  now: Date,
): Promise<Processed> {
  let row = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const t = applyAnuraEvent({ status: row.status, closedByTimeout: row.closed_by_timeout }, ev, row.direction, new Set(exts.keys()));
    const patch = patchFor(row, ev, t, exts, now);
    const { data, error } = await admin
      .from("anura_calls")
      .update(patch)
      .eq("id", row.id)
      .eq("status", row.status)
      .select(ANURA_CALL_COLUMNS);
    if (error) return { outcome: "error", detail: `No se pudo actualizar la llamada: ${error.message}`.slice(0, 200), callId: row.id };
    const updated = ((data ?? []) as unknown as AnuraCallRow[])[0];
    if (!updated) {
      // Otro aviso la movió entre la lectura y la escritura: se vuelve a leer.
      const { data: fresh } = await admin.from("anura_calls").select(ANURA_CALL_COLUMNS).eq("id", row.id).maybeSingle();
      if (!fresh) return { outcome: "ignorado", detail: "La llamada ya no existe.", callId: null };
      row = fresh as unknown as AnuraCallRow;
      continue;
    }
    if (!t) return { outcome: "repetido", detail: "Sin cambio: aviso repetido o fuera de orden.", callId: row.id };
    let detail = `${row.status} → ${t.status}`;
    if (t.final) {
      const factError = await recordAnuraOrderFact(admin, updated, now);
      if (factError) detail += ` (historial del pedido: ${factError.slice(0, 120)})`;
    }
    return {
      outcome: "aplicado",
      detail,
      callId: row.id,
      ...(t.final && ev.recordingUrl && updated.recording_status === "pendiente" ? { recording: { callId: row.id, url: ev.recordingUrl } } : {}),
    };
  }
  return { outcome: "error", detail: "La llamada cambió tres veces mientras se aplicaba el aviso.", callId: row.id };
}

/** Una entrante que Kapta no conoce: se registra como hecho informativo. */
async function createInbound(admin: SupabaseClient, orgId: string, ev: AnuraEvent, exts: Map<string, string>, now: Date): Promise<Processed> {
  if (!ev.callId) return { outcome: "ignorado", detail: "Entrante sin callId.", callId: null };
  const t = eventTarget(ev, "in", new Set(exts.keys()));
  if (!t) return { outcome: "ignorado", detail: "Aviso que Kapta no usa.", callId: null };
  const nowIso = now.toISOString();
  const answerExt = normalizeAnuraExtension(ev.answerExtension);
  const accountExt = normalizeAnuraExtension(ev.accountExtension);
  const ext = answerExt ?? accountExt;
  const withRecording = t.final && !!ev.recordingUrl;
  const { data, error } = await admin
    .from("anura_calls")
    .insert({
      org_id: orgId,
      mode: "entrante",
      direction: "in",
      extension: ext,
      user_id: ext ? exts.get(ext) ?? null : null,
      // Nadie la pidió ni la ve en la fase 1: se guarda enmascarado.
      phone: maskPhone(ev.calling) || null,
      status: t.status,
      status_rank: t.rank,
      anura_call_id: ev.callId,
      requested_at: nowIso,
      started_at: nowIso,
      answered_at: t.status === "en_curso" || t.status === "contestada" ? nowIso : null,
      ended_at: t.final ? nowIso : null,
      last_event_at: nowIso,
      bill_seconds: t.final ? ev.billSeconds : null,
      anura_status: t.final ? ev.status : null,
      answer_extension: answerExt,
      was_recorded: t.final ? ev.wasRecorded : null,
      recording_status: withRecording ? "pendiente" : "sin_grabacion",
      recording_expires_at: withRecording ? recordingExpiresAt(now) : null,
    })
    .select(ANURA_CALL_COLUMNS);
  if (error) {
    if (error.code === "23505") {
      // Otro aviso de la misma llamada la creó a la vez: se aplica sobre esa.
      const { data: existing } = await admin
        .from("anura_calls")
        .select(ANURA_CALL_COLUMNS)
        .eq("org_id", orgId)
        .eq("anura_call_id", ev.callId)
        .maybeSingle();
      if (existing) return applyToRow(admin, existing as unknown as AnuraCallRow, ev, exts, now);
    }
    return { outcome: "error", detail: `No se pudo registrar la entrante: ${error.message}`.slice(0, 200), callId: null };
  }
  const row = ((data ?? []) as unknown as AnuraCallRow[])[0];
  return {
    outcome: "aplicado",
    detail: `Entrante: ${t.status}`,
    callId: row?.id ?? null,
    ...(withRecording && row ? { recording: { callId: row.id, url: ev.recordingUrl! } } : {}),
  };
}

/** Qué hace un aviso ya autenticado. Puede lanzar: quien llama lo anota. */
export async function processAnuraEvent(admin: SupabaseClient, orgId: string, ev: AnuraEvent, now: Date): Promise<Processed> {
  if (ev.hook === "OTRO") return { outcome: "ignorado", detail: `Aviso que Kapta no usa (${ev.rawEvent ?? "sin evento"}).`, callId: null };
  const exts = await advisorExtensions(admin, orgId);
  const { row, ours } = await findCall(admin, orgId, ev);
  if (row) return applyToRow(admin, row, ev, exts, now);
  if (ours) return { outcome: "ignorado", detail: "La llamada de custom1 no existe en esta organización.", callId: null };
  const direction = ev.direction;
  if (direction === "in") return createInbound(admin, orgId, ev, exts, now);
  if (direction === "out") return { outcome: "ignorado", detail: "Llamada saliente que no se pidió desde Kapta.", callId: null };
  return { outcome: "ignorado", detail: "Aviso sin dirección ni llamada de Kapta.", callId: null };
}

async function logEvent(admin: SupabaseClient, orgId: string, ev: AnuraEvent | null, p: Processed, now: Date): Promise<void> {
  try {
    await admin.from("anura_webhook_events").insert({
      org_id: orgId,
      received_at: now.toISOString(),
      event: ev?.rawEvent ?? null,
      direction: ev?.direction ?? null,
      anura_status: ev?.status ?? null,
      anura_call_id: ev?.callId ?? null,
      custom1: ev?.custom1 ?? null,
      call_id: p.callId,
      outcome: p.outcome,
      detail: p.detail.slice(0, 300),
      payload: ev ? maskedEventPayload(ev) : {},
      recording_url: ev?.recordingUrl ?? null,
    });
  } catch {
    // La bitácora no puede tumbar el aviso.
  }
}

/** Borra la bitácora de más de 30 días de la org. */
export async function pruneAnuraEvents(admin: SupabaseClient, orgId: string, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - ANURA_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  await admin.from("anura_webhook_events").delete().eq("org_id", orgId).lt("received_at", cutoff);
}

/** El aviso entero: token, cuerpo, proceso, bitácora y trabajo diferido. */
export async function handleAnuraWebhook(input: AnuraWebhookInput, deps: AnuraWebhookDeps): Promise<AnuraWebhookResult> {
  const orgId = (input.org ?? "").trim().toLowerCase();
  const token = (input.token ?? "").trim() || bearer(input.authorization);
  if (!anuraWebhookTokenValid(orgId, token, deps.key)) {
    return { status: 401, body: { ok: false, error: "token" } };
  }
  const now = deps.now ?? new Date();
  const admin = deps.admin;
  const extraHosts = deps.extraRecordingHosts ?? env.anuraRecordingHosts();

  let ev: AnuraEvent | null = null;
  let processed: Processed;
  if (input.body.length > ANURA_WEBHOOK_MAX_BYTES) {
    processed = { outcome: "ignorado", detail: "El aviso es demasiado grande.", callId: null };
  } else {
    let json: unknown = null;
    try {
      json = JSON.parse(input.body);
    } catch {
      json = null;
    }
    ev = parseAnuraEvent(json, { extraRecordingHosts: extraHosts });
    if (!ev) {
      processed = { outcome: "ignorado", detail: "El aviso no es un JSON con la plantilla de Kapta.", callId: null };
    } else {
      try {
        processed = await processAnuraEvent(admin, orgId, ev, now);
      } catch (err) {
        processed = {
          outcome: "error",
          detail: `Error al procesar el aviso: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
          callId: null,
        };
      }
    }
  }
  if (ev?.recordingRejectedHost) {
    processed = { ...processed, detail: `${processed.detail} · Grabación descartada: el enlace no es de Anura (${ev.recordingRejectedHost}).` };
  }
  await logEvent(admin, orgId, ev, processed, now);

  const work = async () => {
    if (processed.recording) {
      const { data } = await admin.from("anura_calls").select(RECORDING_CALL_COLUMNS).eq("id", processed.recording.callId).maybeSingle();
      if (data) {
        await saveAnuraRecording(admin, data as unknown as RecordingCallRow, processed.recording.url, {
          fetchImpl: deps.fetchImpl,
          now,
          extraHosts,
        });
      }
    }
    if (ev?.hook === "END") await pruneAnuraEvents(admin, orgId, now).catch(() => {});
  };
  if (deps.defer) deps.defer(() => work().catch(() => {}));
  else await work().catch(() => {});

  return { status: 200, body: { ok: true, outcome: processed.outcome } };
}

