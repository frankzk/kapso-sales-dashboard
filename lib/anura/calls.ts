// Las llamadas de Anura en la base («Llamar con Anura», fase 1). SERVIDOR.
//
// Pedir la llamada (`placeAnuraCall`), soltar las que Anura nunca avisó
// (`releaseStaleAnuraCalls`), dejar el hecho en el historial del pedido
// (`recordAnuraOrderFact`) y la vista que recibe la ficha (`anuraCallLive`).
// Reciben el cliente service-role ya autorizado: quién puede lo decide la
// acción que los llama.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requestClick2Dial, type Click2DialErrorKind } from "@/lib/anura/click2dial";
import {
  ANURA_STALE_REASON,
  ANURA_STALE_REQUEST_MS,
  ANURA_STATUS_HINT,
  ANURA_STATUS_LABEL,
  ANURA_STUCK_CALL_MS,
  ANURA_STUCK_REASON,
  anuraBusyError,
  anuraCallNote,
  anuraReachedHistory,
  anuraCustoms,
  isAnuraActive,
  maskPhone,
  type AnuraCallMode,
  type AnuraCallStatus,
  type AnuraDirection,
  type AnuraRecordingStatus,
} from "@/lib/anura/events";

/** Lo que se lee de `anura_calls`. */
export interface AnuraCallRow {
  id: string;
  org_id: string;
  store_id: string | null;
  order_id: string | null;
  user_id: string | null;
  mode: AnuraCallMode;
  direction: AnuraDirection;
  extension: string | null;
  phone: string | null;
  status: AnuraCallStatus;
  status_rank: number;
  anura_call_id: string | null;
  anura_status: string | null;
  bill_seconds: number | null;
  answer_extension: string | null;
  was_recorded: boolean | null;
  failure_reason: string | null;
  closed_by_timeout: boolean;
  recording_status: AnuraRecordingStatus;
  recording_path: string | null;
  recording_expires_at: string | null;
  recording_attempts: number | null;
  requested_at: string;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  last_event_at: string | null;
}

export const ANURA_CALL_COLUMNS =
  "id,org_id,store_id,order_id,user_id,mode,direction,extension,phone,status,status_rank,anura_call_id,anura_status," +
  "bill_seconds,answer_extension,was_recorded,failure_reason,closed_by_timeout,recording_status,recording_path," +
  "recording_expires_at,recording_attempts,requested_at,started_at,answered_at,ended_at,last_event_at";

// ---------------------------------------------------------------------------
// Lo que recibe la ficha
// ---------------------------------------------------------------------------

/** El estado de una llamada para la ficha (sondeo y tarjeta). Sin el número entero. */
export interface AnuraCallLive {
  id: string;
  mode: AnuraCallMode;
  /** El pedido de la llamada (null en una prueba o una entrante). */
  orderId: string | null;
  /**
   * Ya dejó su hecho en el historial del pedido: terminó con un aviso de fin
   * de Anura (`anuraReachedHistory`). Una petición rechazada o cerrada sola
   * por Kapta no.
   */
  inHistory: boolean;
  status: AnuraCallStatus;
  statusLabel: string;
  /** Ayuda mientras está viva; null al terminar. */
  hint: string | null;
  active: boolean;
  extension: string | null;
  toMasked: string;
  billSeconds: number | null;
  failureReason: string | null;
  requestedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  recordingStatus: AnuraRecordingStatus;
  /**
   * Kapta la cerró sola por su plazo (sin avisos de Anura), no Anura. Con el
   * teléfono de Kapta ya en la llamada, la ficha no cuelga por esto.
   */
  closedByTimeout: boolean;
}

export function anuraCallLive(row: AnuraCallRow): AnuraCallLive {
  return {
    id: row.id,
    mode: row.mode,
    orderId: row.order_id,
    inHistory: anuraReachedHistory(row),
    status: row.status,
    statusLabel: ANURA_STATUS_LABEL[row.status],
    hint: ANURA_STATUS_HINT[row.status] ?? null,
    active: isAnuraActive(row.status),
    extension: row.extension,
    toMasked: maskPhone(row.phone),
    billSeconds: row.bill_seconds,
    failureReason: row.failure_reason,
    requestedAt: row.requested_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at,
    recordingStatus: row.recording_status,
    closedByTimeout: Boolean(row.closed_by_timeout),
  };
}

// ---------------------------------------------------------------------------
// Soltar lo que Anura nunca avisó
// ---------------------------------------------------------------------------

/**
 * Cierra como `fallida` (a) las `solicitada` sin ningún aviso a los 60 s
 * («Anura no llegó a hacer la llamada») y (b) las vivas sin END a las 2 h.
 * Se marcan `closed_by_timeout`: si el END llega después, todavía cuenta.
 * Acotado a una persona o a una llamada; `{ all: true }` (solo el cron
 * `/api/cron/anura-recordings`) suelta las de todas las organizaciones, con
 * las mismas reglas. Sin alcance no hace nada. Devuelve cuántas cerró.
 */
export async function releaseStaleAnuraCalls(
  admin: SupabaseClient,
  scope: { userId?: string; callId?: string; all?: true },
  now: Date = new Date(),
): Promise<number> {
  return (await releaseStaleAnuraCallsReport(admin, scope, now)).closed;
}

/**
 * Lo mismo, diciendo además si alguna de las dos pasadas falló en la base
 * (`failed`). La ficha no lo necesita (vuelve a intentarlo al abrirse); el
 * cron sí, para no reportar «0 liberadas» cuando en verdad no pudo escribir.
 */
export async function releaseStaleAnuraCallsReport(
  admin: SupabaseClient,
  scope: { userId?: string; callId?: string; all?: true },
  now: Date = new Date(),
): Promise<{ closed: number; failed: boolean }> {
  if (!scope.userId && !scope.callId && scope.all !== true) return { closed: 0, failed: false };
  const nowIso = now.toISOString();
  let closed = 0;
  let failed = false;
  const pass = async (statuses: AnuraCallStatus[], column: "requested_at" | "last_event_at", ms: number, reason: string) => {
    let q = admin
      .from("anura_calls")
      .update({ status: "fallida", status_rank: 100, failure_reason: reason, closed_by_timeout: true, ended_at: nowIso })
      .in("status", statuses)
      .in("mode", ["pedido", "prueba"])
      .lt(column, new Date(now.getTime() - ms).toISOString());
    if (scope.userId) q = q.eq("user_id", scope.userId);
    if (scope.callId) q = q.eq("id", scope.callId);
    const { data, error } = await q.select("id");
    if (error) failed = true;
    else closed += (data ?? []).length;
  };
  await pass(["solicitada"], "requested_at", ANURA_STALE_REQUEST_MS, ANURA_STALE_REASON);
  await pass(["sonando", "en_curso"], "last_event_at", ANURA_STUCK_CALL_MS, ANURA_STUCK_REASON);
  return { closed, failed };
}

/** La llamada viva de una persona (la más reciente), o null. */
export async function activeAnuraCallOf(admin: SupabaseClient, userId: string): Promise<AnuraCallRow | null> {
  const { data } = await admin
    .from("anura_calls")
    .select(ANURA_CALL_COLUMNS)
    .eq("user_id", userId)
    .in("mode", ["pedido", "prueba"])
    .lt("status_rank", 100)
    .order("requested_at", { ascending: false })
    .limit(1);
  return (((data ?? []) as unknown) as AnuraCallRow[])[0] ?? null;
}

// ---------------------------------------------------------------------------
// Pedir la llamada
// ---------------------------------------------------------------------------

export type AnuraStartErrorCode = "ocupada" | "base" | Click2DialErrorKind;

export type AnuraStartResult =
  | { ok: true; callId: string; extension: string; toMasked: string }
  | { ok: false; error: string; code?: AnuraStartErrorCode; activeCallId?: string };

/**
 * Click2Dial no respondió (12 s) o se cortó la red: Anura pudo haber pedido la
 * llamada igual. La fila queda `solicitada` (la asesora no puede pedir otra
 * encima) y, si Anura no avisa nada, se cierra sola al minuto marcada
 * `closed_by_timeout`, así un fin que llegue tarde todavía se aplica.
 */
const AMBIGUOUS_CLICK2DIAL: readonly Click2DialErrorKind[] = ["tiempo", "red"];

export interface PlaceAnuraCallInput {
  orgId: string;
  storeId: string | null;
  orderId: string | null;
  userId: string;
  mode: "pedido" | "prueba";
  extension: string;
  /** 9 dígitos (`anuraPeruCalled`). */
  phone: string;
  token: string;
}

/**
 * Escribe la fila `solicitada` y pide el Click2Dial. Una sola llamada viva
 * por persona: la base lo sostiene con un índice único, y antes se sueltan
 * las que Anura nunca avisó. Si Anura rechaza, la fila queda `fallida` con el
 * motivo (no es un intento de contacto: no entra al historial del pedido).
 * Si Anura no respondió o se cortó la red, no se sabe si llamó: la fila sigue
 * `solicitada` y se devuelve su id para seguirla.
 */
export async function placeAnuraCall(
  admin: SupabaseClient,
  input: PlaceAnuraCallInput,
  deps: { fetchImpl?: typeof fetch; now?: Date; timeoutMs?: number } = {},
): Promise<AnuraStartResult> {
  const now = deps.now ?? new Date();
  await releaseStaleAnuraCalls(admin, { userId: input.userId }, now);
  const id = randomUUID();
  const { error: insertError } = await admin.from("anura_calls").insert({
    id,
    org_id: input.orgId,
    store_id: input.storeId,
    order_id: input.orderId,
    user_id: input.userId,
    mode: input.mode,
    direction: "out",
    extension: input.extension,
    phone: input.phone,
    status: "solicitada",
    status_rank: 0,
    requested_at: now.toISOString(),
  });
  if (insertError) {
    if (insertError.code === "23505") {
      const active = await activeAnuraCallOf(admin, input.userId);
      return { ok: false, code: "ocupada", error: anuraBusyError(active?.status), ...(active ? { activeCallId: active.id } : {}) };
    }
    return { ok: false, code: "base", error: `No se pudo pedir la llamada: ${insertError.message}` };
  }
  const placed = await requestClick2Dial(
    { token: input.token, called: input.phone, extension: input.extension, customs: anuraCustoms(id) },
    { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs },
  );
  if (!placed.ok && AMBIGUOUS_CLICK2DIAL.includes(placed.kind)) {
    return { ok: false, code: placed.kind, error: placed.error, activeCallId: id };
  }
  if (!placed.ok) {
    await admin
      .from("anura_calls")
      .update({ status: "fallida", status_rank: 100, failure_reason: placed.error, ended_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "solicitada");
    return { ok: false, code: placed.kind, error: placed.error };
  }
  return { ok: true, callId: id, extension: input.extension, toMasked: maskPhone(input.phone) };
}

// ---------------------------------------------------------------------------
// El hecho en el historial del pedido
// ---------------------------------------------------------------------------

export const ANURA_ORDER_EVENT_KIND = "anura_call";

/**
 * Deja `anura_call` en `order_events` cuando una llamada de un pedido termina
 * (igual que `browser_call`, MOM §8.5): quién, a qué número (enmascarado en
 * la nota), con qué anexo, si contestó y cuánto se habló. Una sola vez por
 * llamada. Es un hecho, no la gestión: no recalcula el pedido.
 */
export async function recordAnuraOrderFact(admin: SupabaseClient, row: AnuraCallRow, now: Date = new Date()): Promise<string | null> {
  if (row.mode !== "pedido" || !row.order_id || !row.store_id || isAnuraActive(row.status)) return null;
  const { data: existing, error: readError } = await admin
    .from("order_events")
    .select("id")
    .eq("order_id", row.order_id)
    .eq("kind", ANURA_ORDER_EVENT_KIND)
    .eq("payload->>anura_call_id", row.id)
    .limit(1);
  if (readError) return readError.message;
  if (existing?.length) return null;
  const { error } = await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: row.order_id,
    kind: ANURA_ORDER_EVENT_KIND,
    occurred_at: (row.ended_at ?? now.toISOString()),
    actor: row.user_id,
    source: "anura",
    note: anuraCallNote({
      status: row.status,
      billSeconds: row.bill_seconds,
      phone: row.phone,
      extension: row.extension,
      failureReason: row.failure_reason,
    }),
    payload: {
      anura_call_id: row.id,
      cdr_id: row.anura_call_id,
      status: row.status,
      answered: row.status === "contestada",
      bill_seconds: row.bill_seconds ?? 0,
      anura_status: row.anura_status,
      extension: row.extension,
      to: row.phone,
    },
  });
  return error ? error.message : null;
}
