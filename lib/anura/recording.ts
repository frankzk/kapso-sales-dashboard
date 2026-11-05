// La grabación de una llamada de Anura («Llamar con Anura», fase 1). SERVIDOR.
//
// El enlace que Anura manda en el END (`recordingUrl`, `audio_play_mp3`) VENCE
// a los 30 minutos. Kapta la copia a su Storage privado (`anura-recordings`)
// en cuanto llega el END. Si la copia falla, se reintenta al abrir la ficha
// del pedido (y desde `retryPendingAnuraRecordings`, listo para un cron corto)
// mientras no pasen los 30 minutos y hasta 6 intentos; después queda
// «vencida». Solo baja de hosts de Anura (`allowedRecordingUrl`), también
// después de una redirección, y nunca más de 40 MB.
//
// El enlace de Anura solo vive en la bitácora del servidor
// (`anura_webhook_events.recording_url`); la ficha recibe una URL firmada de
// Storage que dura 5 minutos.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ANURA_RECORDING_TTL_MS, allowedRecordingUrl, type AnuraRecordingStatus } from "@/lib/anura/events";
import { env } from "@/lib/env";

export const ANURA_RECORDING_BUCKET = "anura-recordings";
/** Una grabación más grande que esto no es una llamada normal: no se copia. */
export const ANURA_RECORDING_MAX_BYTES = 40 * 1024 * 1024;
export const ANURA_RECORDING_FETCH_TIMEOUT_MS = 20_000;
/** La URL firmada que recibe la ficha. */
export const ANURA_RECORDING_SIGNED_SECONDS = 300;
/** Intentos de copia antes de dejar de insistir (aunque no haya vencido). */
export const ANURA_RECORDING_MAX_ATTEMPTS = 6;

export interface RecordingCallRow {
  id: string;
  org_id: string;
  requested_at: string;
  recording_status: AnuraRecordingStatus;
  recording_expires_at: string | null;
  recording_attempts: number | null;
}

export const RECORDING_CALL_COLUMNS = "id,org_id,requested_at,recording_status,recording_expires_at,recording_attempts";

export type RecordingOutcome = "guardada" | "pendiente" | "vencida" | "omitida";

export interface RecordingDeps {
  fetchImpl?: typeof fetch;
  now?: Date;
  timeoutMs?: number;
  /** Hosts extra de grabación; por defecto `ANURA_RECORDING_HOSTS`. */
  extraHosts?: readonly string[];
}

/** Cuándo vence el enlace de Anura, contado desde que llegó el END. */
export function recordingExpiresAt(endReceivedAt: Date): string {
  return new Date(endReceivedAt.getTime() + ANURA_RECORDING_TTL_MS).toISOString();
}

/** `<org>/<aaaa-mm>/<id>.mp3`: por org y por mes, para borrar por lotes. */
export function anuraRecordingPath(call: Pick<RecordingCallRow, "id" | "org_id" | "requested_at">): string {
  const month = (call.requested_at ?? "").slice(0, 7) || "sin-fecha";
  return `${call.org_id}/${month}/${call.id}.mp3`;
}

function expired(call: RecordingCallRow, now: Date): boolean {
  return !!call.recording_expires_at && new Date(call.recording_expires_at).getTime() <= now.getTime();
}

/** Los intentos se acabaron o el enlace venció: ya no hay nada que copiar. */
const ANURA_RECORDING_GAVE_UP = "No se pudo copiar la grabación después de 6 intentos.";

/**
 * Una grabación que ya no se va a copiar (guardada, vencida o sin intentos)
 * no necesita el enlace temporal de Anura: se borra de la bitácora.
 */
async function forgetRecordingUrl(admin: SupabaseClient, callId: string): Promise<void> {
  try {
    await admin.from("anura_webhook_events").update({ recording_url: null }).eq("call_id", callId).not("recording_url", "is", null);
  } catch {
    // La bitácora se poda a los 30 días igual.
  }
}

async function markFailure(admin: SupabaseClient, call: RecordingCallRow, error: string): Promise<RecordingOutcome> {
  const attempts = (call.recording_attempts ?? 0) + 1;
  const gaveUp = attempts >= ANURA_RECORDING_MAX_ATTEMPTS;
  await admin
    .from("anura_calls")
    .update({
      recording_attempts: attempts,
      recording_error: (gaveUp ? `${ANURA_RECORDING_GAVE_UP} Último error: ${error}` : error).slice(0, 200),
      ...(gaveUp ? { recording_status: "vencida" } : {}),
    })
    .eq("id", call.id)
    .eq("recording_status", "pendiente");
  if (gaveUp) await forgetRecordingUrl(admin, call.id);
  return gaveUp ? "vencida" : "pendiente";
}

async function markExpired(admin: SupabaseClient, call: RecordingCallRow): Promise<void> {
  await admin
    .from("anura_calls")
    .update({ recording_status: "vencida", recording_error: "El enlace de Anura venció antes de copiar la grabación." })
    .eq("id", call.id)
    .eq("recording_status", "pendiente");
  await forgetRecordingUrl(admin, call.id);
}

async function ensureBucket(admin: SupabaseClient): Promise<void> {
  await admin.storage.createBucket(ANURA_RECORDING_BUCKET, { public: false }).catch(() => {});
}

/** Redirecciones que se siguen, cada una a un host de Anura. */
export const ANURA_RECORDING_MAX_REDIRECTS = 3;

class RecordingRefused extends Error {}

/**
 * Pide la grabación sin seguir redirecciones a ciegas: cada salto se vuelve a
 * comprobar contra los hosts de Anura.
 */
async function fetchRecording(fetchImpl: typeof fetch, url: string, extra: readonly string[], signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= ANURA_RECORDING_MAX_REDIRECTS; hop += 1) {
    const safe = allowedRecordingUrl(current, extra);
    if (!safe) {
      let host = "enlace no válido";
      try {
        host = new URL(current).hostname || host;
      } catch {
        // queda «enlace no válido»
      }
      throw new RecordingRefused(`El enlace de la grabación no es de Anura (${host.slice(0, 80)}).`);
    }
    const res = await fetchImpl(safe, { method: "GET", signal, cache: "no-store", redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) throw new RecordingRefused(`Anura respondió HTTP ${res.status} sin destino al bajar la grabación.`);
      current = new URL(location, safe).toString();
      continue;
    }
    return res;
  }
  throw new RecordingRefused("La grabación redirige demasiadas veces.");
}

/** Lee el cuerpo hasta `max` bytes; más que eso corta la descarga. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > max ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Copia la grabación de `url` al bucket privado. Nunca lanza. No toca una
 * grabación ya guardada; una vencida queda «vencida». Solo baja de hosts de
 * Anura (también tras una redirección) y nunca más de 40 MB. Al sexto intento
 * fallido, o pasados los 30 minutos, queda «vencida».
 */
export async function saveAnuraRecording(
  admin: SupabaseClient,
  call: RecordingCallRow,
  url: string,
  deps: RecordingDeps = {},
): Promise<RecordingOutcome> {
  const now = deps.now ?? new Date();
  if (call.recording_status !== "pendiente") return "omitida";
  if (expired(call, now) || (call.recording_attempts ?? 0) >= ANURA_RECORDING_MAX_ATTEMPTS) {
    await markExpired(admin, call);
    return "vencida";
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const extra = deps.extraHosts ?? env.anuraRecordingHosts();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? ANURA_RECORDING_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchRecording(fetchImpl, url, extra, controller.signal);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return await markFailure(admin, call, `Anura respondió HTTP ${res.status} al bajar la grabación.`);
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > ANURA_RECORDING_MAX_BYTES) {
      await res.body?.cancel().catch(() => {});
      return await markFailure(admin, call, "La grabación es demasiado grande para copiarla.");
    }
    const bytes = await readCapped(res, ANURA_RECORDING_MAX_BYTES);
    if (!bytes || !bytes.byteLength) {
      return await markFailure(admin, call, bytes ? "Anura entregó una grabación vacía." : "La grabación es demasiado grande para copiarla.");
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const path = anuraRecordingPath(call);
    await ensureBucket(admin);
    const { error: uploadError } = await admin.storage
      .from(ANURA_RECORDING_BUCKET)
      .upload(path, bytes, { contentType: contentType.startsWith("audio/") ? contentType : "audio/mpeg", upsert: true });
    if (uploadError) {
      return await markFailure(admin, call, `No se pudo guardar la grabación: ${uploadError.message}`);
    }
    await admin
      .from("anura_calls")
      .update({ recording_status: "guardada", recording_path: path, recording_error: null, recording_attempts: (call.recording_attempts ?? 0) + 1 })
      .eq("id", call.id)
      .eq("recording_status", "pendiente");
    await forgetRecordingUrl(admin, call.id);
    return "guardada";
  } catch (err) {
    if (err instanceof RecordingRefused) return await markFailure(admin, call, err.message);
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    return await markFailure(admin, call, aborted ? "Anura tardó demasiado en entregar la grabación." : "No se pudo bajar la grabación de Anura.");
  } finally {
    clearTimeout(timer);
  }
}

/** El último enlace de grabación que Anura mandó para esta llamada. */
export async function latestRecordingUrl(admin: SupabaseClient, callId: string): Promise<string | null> {
  const { data } = await admin
    .from("anura_webhook_events")
    .select("recording_url")
    .eq("call_id", callId)
    .not("recording_url", "is", null)
    .order("received_at", { ascending: false })
    .limit(1);
  const row = ((data ?? []) as { recording_url: string | null }[])[0];
  return row?.recording_url ?? null;
}

/** Reintenta la copia de una llamada «pendiente». Nunca lanza. */
export async function retryAnuraRecording(admin: SupabaseClient, call: RecordingCallRow, deps: RecordingDeps = {}): Promise<RecordingOutcome> {
  try {
    if (call.recording_status !== "pendiente") return "omitida";
    const now = deps.now ?? new Date();
    if (expired(call, now)) {
      await markExpired(admin, call);
      return "vencida";
    }
    const url = await latestRecordingUrl(admin, call.id);
    if (!url) return "pendiente";
    return await saveAnuraRecording(admin, call, url, deps);
  } catch {
    return "pendiente";
  }
}

/**
 * Las «pendiente» de los últimos 30 minutos, una por una. Para un cron corto
 * (no está programado en la fase 1: la copia se intenta al llegar el END y al
 * abrir la ficha).
 */
export async function retryPendingAnuraRecordings(
  admin: SupabaseClient,
  deps: RecordingDeps & { limit?: number } = {},
): Promise<Record<RecordingOutcome, number>> {
  const counts: Record<RecordingOutcome, number> = { guardada: 0, pendiente: 0, vencida: 0, omitida: 0 };
  const { data } = await admin
    .from("anura_calls")
    .select(RECORDING_CALL_COLUMNS)
    .eq("recording_status", "pendiente")
    .order("requested_at", { ascending: true })
    .limit(deps.limit ?? 20);
  for (const call of (data ?? []) as RecordingCallRow[]) {
    counts[await retryAnuraRecording(admin, call, deps)] += 1;
  }
  return counts;
}

/** URL firmada corta de una grabación guardada, o null. */
export async function signedRecordingUrl(admin: SupabaseClient, path: string | null): Promise<string | null> {
  if (!path) return null;
  try {
    const { data, error } = await admin.storage.from(ANURA_RECORDING_BUCKET).createSignedUrl(path, ANURA_RECORDING_SIGNED_SECONDS);
    return error ? null : data?.signedUrl ?? null;
  } catch {
    return null;
  }
}
