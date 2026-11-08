// La fila del rastreo de Shalom y la guía que Shalom ya no reconoce (MOM §12,
// «La fila del rastreo y la guía que Shalom no reconoce», 08-11-2026; 0321).
//
// EL CASO. Cada pasada de media hora preguntaba por unas 250 de ~367 guías
// vivas, en el orden de `last_report_at` —cuándo CONTESTÓ Shalom—. Una guía que
// Shalom rechaza con `not_found` («No se encontró la orden de servicio») nunca
// contesta, así que nunca se movía: las mismas 71 encabezaban la fila en cada
// pasada y gastaban un tercio del cupo. Entre ellas, guías de agosto a octubre
// y 38 guías recreadas el 03-11-2026 tras el corte de luz de Shalom Breña cuyas
// cajas nunca se dejaron en la agencia: Shalom las venció.
//
// LO QUE CAMBIA.
//   * `shalom_checked_at` es cuándo PREGUNTAMOS, contestara Shalom o no. La fila
//     va por esa columna: toda guía preguntada vuelve al final. `last_report_at`
//     sigue diciendo cuándo contestó (lo leen Cotejar Shalom y la ficha).
//   * `shalom_not_found_since` / `shalom_not_found_count`: la racha de
//     `not_found` seguidos. Una respuesta de verdad la borra. Pasadas las dos
//     marcas (`SHALOM_UNRECOGNIZED_PASSES` y `SHALOM_UNRECOGNIZED_HOURS`) la guía
//     es «Guía Shalom no reconocida» y se ve en Almacén, en la Mesa de despacho
//     y en la línea de tiempo. Nada se anula solo: solo al registrar la guía
//     que la reemplaza (lib/shalom/dead-guide.ts, Cotejar Shalom o el drawer).
//
// Lógica pura, sin base: lo prueba test/shalom-check-queue.test.ts.

import type { SupabaseClient } from "@supabase/supabase-js";

/** El código con que Shalom rechaza una guía que no conoce o que ya venció. */
export const SHALOM_NOT_FOUND_CODE = "not_found";

/**
 * Consultas `not_found` seguidas desde las que una guía deja de ser un tropiezo.
 * Con la fila rotando, cada guía se pregunta cada ~45 min: seis son unas 4-5 h
 * de rechazos sin una sola respuesta entre medio.
 */
export const SHALOM_UNRECOGNIZED_PASSES = 6;

/**
 * Y al menos estas horas desde el primer `not_found`. Las dos marcas a la vez:
 * seis pasadas seguidas en una caída de Shalom de una tarde no bastan, y una
 * sola pasada tras días sin preguntar tampoco.
 */
export const SHALOM_UNRECOGNIZED_HOURS = 24;

/** El nombre del motivo, tal como se lee en las pantallas (MOM §12). */
export const SHALOM_UNRECOGNIZED_REASON = "Guía Shalom no reconocida";

/** El `payload.motivo` del `guide_check` que lo deja en la línea de tiempo. */
export const SHALOM_UNRECOGNIZED_MOTIVO = "rastreo_no_reconoce";

/** Las columnas de la 0321. Sin ellas, el rastreo vuelve a la fila de antes. */
export const SHALOM_CHECK_COLUMNS = ["shalom_checked_at", "shalom_not_found_since", "shalom_not_found_count"] as const;

/** Qué pasó con una guía preguntada. */
export type ShalomCheckAnswer =
  /** Shalom contestó con su estado, haya cambiado o no. */
  | "contesto"
  /** Shalom dice que no la conoce (`not_found`). */
  | "no_encontrada"
  /** Otro rechazo, el lote caído o la guía que no volvió en la respuesta. */
  | "otro";

export interface ShalomTrackReply {
  ok?: boolean | null;
  error?: { code?: string | null; message?: string | null } | null;
}

/** Lee la respuesta de una guía. Sin respuesta para ella, «otro». */
export function shalomCheckAnswer(reply: ShalomTrackReply | null | undefined): ShalomCheckAnswer {
  if (!reply) return "otro";
  if (reply.ok) return "contesto";
  const code = (reply.error?.code ?? "").trim().toLowerCase();
  return code === SHALOM_NOT_FOUND_CODE ? "no_encontrada" : "otro";
}

/** La racha de `not_found` que guarda la guía. */
export interface ShalomNotFoundState {
  shalom_not_found_since: string | null;
  shalom_not_found_count: number | null;
}

export interface ShalomCheckPatch {
  shalom_checked_at: string;
  shalom_not_found_since?: string | null;
  shalom_not_found_count?: number;
}

/**
 * Lo que se escribe en la guía tras preguntar por ella. Siempre el sello de
 * cuándo se preguntó; la racha solo cuando la respuesta dice algo de ella:
 * contestó (se borra) o no la encontró (suma una). Un rechazo de otra clase no
 * la toca: «falta codigo» no dice si Shalom conoce la guía.
 */
export function nextShalomCheck(
  prev: ShalomNotFoundState,
  answer: ShalomCheckAnswer,
  nowIso: string,
): ShalomCheckPatch {
  if (answer === "contesto") {
    return { shalom_checked_at: nowIso, shalom_not_found_since: null, shalom_not_found_count: 0 };
  }
  if (answer === "no_encontrada") {
    return {
      shalom_checked_at: nowIso,
      shalom_not_found_since: prev.shalom_not_found_since ?? nowIso,
      shalom_not_found_count: Math.max(0, prev.shalom_not_found_count ?? 0) + 1,
    };
  }
  return { shalom_checked_at: nowIso };
}

/**
 * Agrupa las escrituras iguales: un update por grupo en vez de uno por guía.
 * Las que contestaron son un solo grupo; las `not_found`, uno por racha.
 */
export function groupShalomCheckWrites<P extends object = ShalomCheckPatch>(
  rows: readonly { id: string; patch: P }[],
): { patch: P; ids: string[] }[] {
  const groups = new Map<string, { patch: P; ids: string[] }>();
  for (const row of rows) {
    const key = JSON.stringify(row.patch, Object.keys(row.patch).sort());
    const group = groups.get(key);
    if (group) group.ids.push(row.id);
    else groups.set(key, { patch: row.patch, ids: [row.id] });
  }
  return [...groups.values()];
}

/** Si la guía ya es «Guía Shalom no reconocida». */
export function shalomUnrecognized(state: ShalomNotFoundState, now: number = Date.now()): boolean {
  const count = state.shalom_not_found_count ?? 0;
  if (count < SHALOM_UNRECOGNIZED_PASSES || !state.shalom_not_found_since) return false;
  const since = Date.parse(state.shalom_not_found_since);
  if (Number.isNaN(since)) return false;
  return now - since >= SHALOM_UNRECOGNIZED_HOURS * 3_600_000;
}

/** «03-11-2026», en la hora de Lima. */
function limaDay(iso: string): string {
  const parts = new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")}`;
}

/**
 * La línea que lee operaciones: qué pasa y qué hacer. Nunca «se anuló»: Kapta
 * no anula ni recrea la guía por su cuenta; solo la anula al registrar la guía
 * que la reemplaza (lib/shalom/dead-guide.ts).
 */
export function shalomUnrecognizedLine(state: ShalomNotFoundState, guideCode: string | null): string {
  const since = state.shalom_not_found_since ? ` desde el ${limaDay(state.shalom_not_found_since)}` : "";
  const count = state.shalom_not_found_count ?? 0;
  const guide = guideCode ? ` ${guideCode}` : "";
  return (
    `${SHALOM_UNRECOGNIZED_REASON}: el rastreo no encuentra la guía${guide}${since} ` +
    `(${count} consultas seguidas). Si la caja salió con otra guía hecha en Shalom Pro, regístrala en ` +
    "«Ya la creé en Shalom Pro» (Cotejar Shalom también la busca); si no salió, Shalom la venció: " +
    "genera una guía nueva antes de llevarla. Kapta solo la anula al registrar la que la reemplaza."
  );
}

/** La nota del `guide_check` que lo deja en la línea de tiempo, una vez por racha. */
export function shalomUnrecognizedNote(state: ShalomNotFoundState, guideCode: string | null): string {
  return `Rastreo de Shalom: ${lowerFirst(shalomUnrecognizedLine(state, guideCode))}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase("es") + text.slice(1);
}

/** «La columna no existe» y es de la 0321: la migración todavía no se aplicó. */
export function shalomCheckColumnsMissing(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code !== "42703" && error.code !== "PGRST204") return false;
  const message = error.message ?? "";
  return SHALOM_CHECK_COLUMNS.some((column) => message.includes(column));
}

/**
 * La línea «Guía Shalom no reconocida» de cada salida que lo es, por id. Para
 * Almacén y la Mesa de despacho. Sin la 0321, o si la lectura falla, devuelve
 * vacío: la pantalla queda como antes, sin el motivo, y nunca se cae por él.
 */
export async function loadShalomUnrecognized(
  sb: SupabaseClient,
  shipmentIds: readonly string[],
  now: number = Date.now(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(shipmentIds)];
  for (let start = 0; start < ids.length; start += 200) {
    const { data, error } = await sb
      .from("shipments")
      .select("id,guide_code,shalom_not_found_since,shalom_not_found_count")
      .eq("courier", "shalom")
      .gte("shalom_not_found_count", SHALOM_UNRECOGNIZED_PASSES)
      .in("id", ids.slice(start, start + 200));
    if (error) {
      if (!shalomCheckColumnsMissing(error)) console.error("[shalom] guías no reconocidas:", error.message);
      return new Map();
    }
    for (const row of (data ?? []) as ({ id: string; guide_code: string | null } & ShalomNotFoundState)[]) {
      if (shalomUnrecognized(row, now)) out.set(row.id, shalomUnrecognizedLine(row, row.guide_code));
    }
  }
  return out;
}
