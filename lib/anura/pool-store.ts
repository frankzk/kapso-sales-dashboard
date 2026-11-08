import "server-only";

// «Llamar con Anura»: las líneas compartidas en la base (0313). SERVIDOR.
//
//   · `readPoolLines`: las líneas de la org con el estado de su teléfono de
//     Kapta (nunca la clave).
//   · `reserveAnuraLine`: al pedir la clave, RESERVA una línea libre
//     escribiendo la fila de la llamada para esa línea (`solicitada`, con
//     `reserved_at` y sin `dialed_at`). La base no deja dos llamadas vivas en
//     una línea (`anura_calls_one_active_per_extension`): si otra persona la
//     tomó en el mismo instante, se prueba la siguiente. Devuelve la clave de
//     ESA línea y el id de la reserva; nunca la de otra.
//   · `dialAnuraReservation`: el Click2Dial con la reserva de quien llama, y
//     solo con ella (nunca vuelve a elegir línea).
//   · `releaseAnuraReservation`: el navegador falló antes del Click2Dial
//     (micrófono, registro, colgó): la línea queda libre en el acto. Si nadie
//     la suelta, `releaseStaleAnuraCalls` lo hace a los 60 s.
//
// Reciben el cliente service-role ya autorizado: quién puede lo decide
// lib/anura/server.ts.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ANURA_CALL_COLUMNS,
  activeAnuraCallOf,
  dialAnuraCall,
  releaseStaleAnuraCalls,
  type AnuraCallRow,
  type AnuraStartResult,
  type DialDeps,
} from "@/lib/anura/calls";
import {
  ANURA_NO_POOL_LINES,
  ANURA_RESERVATION_LOST,
  ANURA_UNDIALED_REASON,
  anuraLinesBusyMessage,
  anuraPoolLineUsable,
  orderPoolCandidates,
} from "@/lib/anura/pool";
import type { AnuraKaptaPhoneStatus } from "@/lib/anura/sip";
import { ANURA_KAPTA_START_TEXT, type AnuraPhoneCredentialsResult } from "@/lib/anura/sip-phone";
import {
  isMissingTable,
  kaptaPhoneStatus,
  readSipCredentialMetas,
  readSipSettings,
  sipPhoneCredentials,
  type AnuraSipSettings,
  type SipCredentialMeta,
} from "@/lib/anura/sip-store";

/** Falta una columna (la 0313 no está aplicada). */
export function isMissingColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204" || /column .* does not exist|could not find the .* column/i.test(error.message ?? "");
}

export interface PoolLine {
  id: string;
  extension: string;
  active: boolean;
  /** El teléfono de Kapta de la línea (su clave de la «-websocket»). */
  phoneStatus: AnuraKaptaPhoneStatus;
  /** La clave guardada para ESTE número (sin el cifrado), o null. */
  meta: SipCredentialMeta | null;
}

/** Las líneas compartidas de la org. `missing`: falta la 0313 (o la 0311). */
export async function readPoolLines(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ lines: PoolLine[]; settings: AnuraSipSettings; missing: boolean }> {
  const [extRes, sip, metas] = await Promise.all([
    admin.from("anura_extensions").select("id,extension,active").eq("org_id", orgId).eq("pool", true).order("extension"),
    readSipSettings(admin, orgId),
    readSipCredentialMetas(admin, orgId),
  ]);
  if (extRes.error) return { lines: [], settings: sip.settings, missing: isMissingTable(extRes.error) || isMissingColumn(extRes.error) };
  const lines = ((extRes.data ?? []) as { id: string; extension: string; active: boolean }[]).map((e) => {
    const raw = metas.byExtensionId.get(e.id) ?? null;
    const meta = raw && raw.extension === e.extension ? raw : null;
    return { id: e.id, extension: e.extension, active: e.active, meta, phoneStatus: kaptaPhoneStatus(e, meta, sip.settings) };
  });
  return { lines, settings: sip.settings, missing: sip.missing || metas.missing };
}

/** La línea compartida de la org con ese número, o null. */
export async function poolLineByExtension(admin: SupabaseClient, orgId: string, extension: string): Promise<{ id: string; extension: string } | null> {
  const { data, error } = await admin
    .from("anura_extensions")
    .select("id,extension")
    .eq("org_id", orgId)
    .eq("extension", extension)
    .eq("pool", true)
    .maybeSingle();
  if (error) return null;
  const row = data as { id?: string; extension?: string } | null;
  return row?.id && row.extension ? { id: row.id, extension: row.extension } : null;
}

/** Las llamadas vivas de la org por anexo: quién la tiene. */
export async function liveCallsByExtension(admin: SupabaseClient, orgId: string): Promise<Map<string, { callId: string; userId: string | null }>> {
  const { data } = await admin
    .from("anura_calls")
    .select("id,user_id,extension")
    .eq("org_id", orgId)
    .in("mode", ["pedido", "prueba"])
    .lt("status_rank", 100);
  const out = new Map<string, { callId: string; userId: string | null }>();
  for (const r of (data ?? []) as { id: string; user_id: string | null; extension: string | null }[]) {
    if (r.extension) out.set(r.extension, { callId: r.id, userId: r.user_id });
  }
  return out;
}

/** «Puede llamar con Anura» en la org. Sin la 0313, nadie. */
export async function isAnuraCaller(admin: SupabaseClient, orgId: string, userId: string): Promise<boolean> {
  const { data, error } = await admin.from("anura_callers").select("enabled").eq("org_id", orgId).eq("user_id", userId).maybeSingle();
  if (error) return false;
  return (data as { enabled?: boolean } | null)?.enabled === true;
}

/** Cuándo se usó por última vez cada anexo (la llamada más reciente). */
async function lastUseByExtension(admin: SupabaseClient, orgId: string, extensions: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!extensions.length) return out;
  const { data } = await admin
    .from("anura_calls")
    .select("extension,requested_at")
    .eq("org_id", orgId)
    .in("extension", [...extensions])
    .order("requested_at", { ascending: false })
    .limit(500);
  for (const r of (data ?? []) as { extension: string | null; requested_at: string }[]) {
    if (!r.extension || out.has(r.extension)) continue;
    const at = Date.parse(r.requested_at);
    if (Number.isFinite(at)) out.set(r.extension, at);
  }
  return out;
}

/** Lo que cuenta la ficha: cuántas líneas sirven y cuántas están libres ahora. */
export async function poolAvailability(admin: SupabaseClient, orgId: string): Promise<{ total: number; free: number }> {
  const [{ lines, missing }, live] = await Promise.all([readPoolLines(admin, orgId), liveCallsByExtension(admin, orgId)]);
  if (missing) return { total: 0, free: 0 };
  const usable = lines.filter(anuraPoolLineUsable);
  return { total: usable.length, free: usable.filter((l) => !live.has(l.extension)).length };
}

export interface ReserveLineInput {
  orgId: string;
  userId: string;
  mode: "pedido" | "prueba";
  storeId: string | null;
  orderId: string | null;
  /** 9 dígitos; null en la prueba de Ajustes (el número se escribe al pedirla). */
  phone: string | null;
  /** Solo esa línea (la prueba de una línea concreta desde Ajustes). */
  onlyExtension?: string | null;
}

/** Suelta las reservas SIN pedir de quien llama (una pestaña que falló antes del Click2Dial). */
async function releaseOwnUndialed(admin: SupabaseClient, userId: string, nowIso: string): Promise<void> {
  await admin
    .from("anura_calls")
    .update({ status: "fallida", status_rank: 100, failure_reason: ANURA_UNDIALED_REASON, ended_at: nowIso })
    .eq("user_id", userId)
    .eq("status", "solicitada")
    .in("mode", ["pedido", "prueba"])
    .not("reserved_at", "is", null)
    .is("dialed_at", null)
    .select("id");
}

/**
 * Reserva una línea compartida LIBRE para quien llama y devuelve su clave,
 * con el id de la reserva. Primero la que menos se usó; entre las que
 * empatan, al azar. Si otra persona la tomó en el mismo instante (la base
 * rechaza la segunda fila viva de esa línea), se prueba la siguiente. Sin
 * ninguna libre: «Las N líneas de Anura están ocupadas…».
 */
export async function reserveAnuraLine(
  admin: SupabaseClient,
  input: ReserveLineInput,
  deps: { now?: Date; random?: () => number } = {},
): Promise<AnuraPhoneCredentialsResult> {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  // Lo que Anura nunca avisó, y las reservas de un minuto sin pedir, liberan su línea.
  await releaseStaleAnuraCalls(admin, { orgId: input.orgId }, now);
  await releaseOwnUndialed(admin, input.userId, nowIso);

  const { lines, missing } = await readPoolLines(admin, input.orgId);
  if (missing) return { ok: false, code: "sin_lineas", error: ANURA_NO_POOL_LINES };
  let usable = lines.filter(anuraPoolLineUsable);
  if (input.onlyExtension) usable = usable.filter((l) => l.extension === input.onlyExtension);
  if (!usable.length) return { ok: false, code: "sin_lineas", error: ANURA_NO_POOL_LINES };

  const own = await activeAnuraCallOf(admin, input.userId);
  if (own) return { ok: false, code: "ocupada", error: ANURA_KAPTA_START_TEXT.ocupada ?? "Ya tienes una llamada de Anura abierta." };

  const live = await liveCallsByExtension(admin, input.orgId);
  const free = usable.filter((l) => !live.has(l.extension));
  const lastUsed = await lastUseByExtension(admin, input.orgId, free.map((l) => l.extension));
  for (const line of orderPoolCandidates(free, lastUsed, deps.random)) {
    const id = randomUUID();
    const { error } = await admin.from("anura_calls").insert({
      id,
      org_id: input.orgId,
      store_id: input.storeId,
      order_id: input.orderId,
      user_id: input.userId,
      mode: input.mode,
      direction: "out",
      extension: line.extension,
      phone: input.phone,
      status: "solicitada",
      status_rank: 0,
      requested_at: nowIso,
      reserved_at: nowIso,
      dialed_at: null,
    });
    if (error) {
      if (error.code !== "23505") return { ok: false, code: "base", error: "No se pudo reservar una línea de Anura. Vuelve a intentar." };
      // ¿La viva es de quien llama (otra pestaña u otro navegador)? Si no, otra persona tomó la línea: la siguiente.
      if (await activeAnuraCallOf(admin, input.userId)) {
        return { ok: false, code: "ocupada", error: ANURA_KAPTA_START_TEXT.ocupada ?? "Ya tienes una llamada de Anura abierta." };
      }
      continue;
    }
    const creds = await sipPhoneCredentials(admin, input.orgId, { id: line.id, extension: line.extension });
    if (!creds.ok) {
      // La clave cambió entretanto (la rechazaron o la quitaron): se suelta y se prueba otra.
      await releaseAnuraReservation(admin, { reservationId: id, userId: input.userId }, now);
      continue;
    }
    return { ok: true, phone: { ...creds.phone, reservationId: id } };
  }
  const total = input.onlyExtension ? 1 : usable.length;
  return {
    ok: false,
    code: "lineas_ocupadas",
    error: input.onlyExtension ? `La línea ${input.onlyExtension} de Anura está ocupada. Intenta en un momento.` : anuraLinesBusyMessage(total),
  };
}

export interface DialReservationInput {
  reservationId: string;
  orgId: string;
  userId: string;
  mode: "pedido" | "prueba";
  /** En una llamada de pedido, la reserva tiene que ser de ESTE pedido. */
  orderId: string | null;
  /** Solo esa línea (la prueba de una línea concreta). */
  extension?: string | null;
  phone: string;
  token: string;
}

/**
 * El Click2Dial con la reserva de quien llama. La marca `dialed_at` solo si
 * la reserva sigue viva, sin pedir y es suya (de ese pedido, o de una
 * prueba): así no compite con la pasada que suelta las reservas de más de un
 * minuto. Nunca elige otra línea.
 */
export async function dialAnuraReservation(admin: SupabaseClient, input: DialReservationInput, deps: DialDeps = {}): Promise<AnuraStartResult> {
  const now = deps.now ?? new Date();
  let q = admin
    .from("anura_calls")
    .update({ dialed_at: now.toISOString(), phone: input.phone })
    .eq("id", input.reservationId)
    .eq("org_id", input.orgId)
    .eq("user_id", input.userId)
    .eq("mode", input.mode)
    .eq("status", "solicitada")
    .not("reserved_at", "is", null)
    .is("dialed_at", null);
  if (input.mode === "pedido" && input.orderId) q = q.eq("order_id", input.orderId);
  if (input.extension) q = q.eq("extension", input.extension);
  const { data, error } = await q.select(ANURA_CALL_COLUMNS);
  if (error) return { ok: false, code: "base", error: `No se pudo pedir la llamada: ${error.message}` };
  const row = ((data ?? []) as unknown as AnuraCallRow[])[0];
  if (!row?.extension) return { ok: false, code: "reserva", error: ANURA_RESERVATION_LOST };
  return dialAnuraCall(admin, { id: row.id, mode: input.mode, extension: row.extension, phone: input.phone, token: input.token }, deps);
}

/**
 * Suelta la reserva SIN pedir de quien llama: la línea queda libre en el acto.
 * No es un intento de contacto (no deja hecho). Devuelve si soltó algo.
 */
export async function releaseAnuraReservation(
  admin: SupabaseClient,
  input: { reservationId: string; userId: string },
  now: Date = new Date(),
): Promise<boolean> {
  const { data, error } = await admin
    .from("anura_calls")
    .update({ status: "fallida", status_rank: 100, failure_reason: ANURA_UNDIALED_REASON, ended_at: now.toISOString() })
    .eq("id", input.reservationId)
    .eq("user_id", input.userId)
    .eq("status", "solicitada")
    .not("reserved_at", "is", null)
    .is("dialed_at", null)
    .select("id");
  return !error && (data ?? []).length > 0;
}

/** Cuánto vale una reserva para avisar un rechazo de su clave (la pestaña lo avisa al momento). */
export const ANURA_RESERVATION_REPORT_WINDOW_MS = 10 * 60_000;

/**
 * La línea compartida de una reserva RECIENTE de quien llama (para marcar su
 * clave rechazada). Solo la de su propia reserva: nunca otra línea.
 */
export async function reservedLineOf(
  admin: SupabaseClient,
  input: { reservationId: string; userId: string; orgId: string },
  now: Date = new Date(),
): Promise<{ id: string; extension: string } | null> {
  const { data } = await admin
    .from("anura_calls")
    .select("id,extension,reserved_at")
    .eq("id", input.reservationId)
    .eq("user_id", input.userId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  const row = data as { extension?: string | null; reserved_at?: string | null } | null;
  if (!row?.extension || !row.reserved_at) return null;
  const at = Date.parse(row.reserved_at);
  if (!Number.isFinite(at) || now.getTime() - at > ANURA_RESERVATION_REPORT_WINDOW_MS) return null;
  return poolLineByExtension(admin, input.orgId, row.extension);
}
