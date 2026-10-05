// «Cotejar Olva › Correos de Olva» (MOM §12): cada rótulo que Olva mandó por
// correo y si encontró su pedido. PURO Y TESTEADO; lo que lee la base vive en
// lib/olva/email-log-access.ts.
//
// Se cuentan dos cosas distintas y la pantalla no las mezcla:
//   - lo que hizo el correo AL LLEGAR (`outcome`, la 0226), que no cambia;
//   - dónde está HOY su tracking. Un correo que llegó «sin pareja» puede estar
//     vinculado después —a mano, por el cotejo del portal o por otro correo—,
//     y uno que vinculó puede haberse corregido en el Master. Lo de hoy manda
//     sobre la bitácora, como en el resto de «Cotejar Olva».

import { LABEL_OUTCOMES, type LabelOutcome } from "@/lib/olva/email-label";
import { formatOlvaTracking } from "@/lib/olva/tracking";

/** Una fila de `olva_email_labels`, lo que la pestaña necesita. */
export interface EmailLabelRow {
  id: string;
  message_id: string;
  file_name: string;
  received_at: string | null;
  created_at: string;
  subject: string | null;
  registro: string | null;
  olva_tracking: string | null;
  olva_emision: string | null;
  sender_doc: string | null;
  recipient_name: string | null;
  address: string | null;
  parse_error: string | null;
  linked_shipment_id: string | null;
  suggested_order_name: string | null;
  match_note: string | null;
  /** `null` en filas guardadas sin la 0226. */
  outcome?: string | null;
}

/** Una salida que hoy tiene el tracking (o la que vinculó el correo). */
export interface EmailLogShipment {
  id: string;
  order_id: string | null;
  order_name: string | null;
  olva_tracking: string | null;
  olva_emision: string | null;
}

/** El evento `olva_tracking_linked` de una salida (quién y cómo puso el tracking). */
export interface EmailLogLinkEvent {
  shipment_id: string;
  occurred_at: string;
  actor: string | null;
  payload: { olvaTracking?: string | null; via?: string | null } | null;
}

/** Lo que se muestra de cada correo. */
export type EmailLogState = "vinculado" | "ya_vinculado" | "despues" | "pendiente" | "ilegible";

export const EMAIL_LOG_STATES: EmailLogState[] = ["vinculado", "ya_vinculado", "despues", "pendiente", "ilegible"];

export interface EmailLogOrder {
  /** `null` si el pedido no está en las tiendas de quien mira (no se enlaza). */
  id: string | null;
  name: string;
}

export interface EmailLogEntry {
  id: string;
  /** Cuándo llegó al buzón (o, sin ese dato, cuándo lo recibió Kapta). */
  receivedAt: string;
  /** YYYY-MM-DD en Lima. */
  day: string;
  tracking: string | null;
  registro: string | null;
  subject: string | null;
  recipient: string | null;
  address: string | null;
  senderDoc: string | null;
  outcome: LabelOutcome;
  state: EmailLogState;
  /** La frase que dejó el correo al llegar. */
  note: string | null;
  /** El pedido que hoy tiene el tracking. */
  order: EmailLogOrder | null;
  /** Lo que propuso el rótulo, mientras espera a una persona. */
  suggested: EmailLogOrder | null;
  /** Cómo llegó el tracking a la salida cuando no fue este correo. */
  how: string | null;
  /** El correo vinculó, pero hoy el tracking está en otro sitio. */
  later: string | null;
  /** La organización cuyo RUC envía, si es una de las de quien mira. */
  orgId: string | null;
}

export interface EmailLogDay {
  day: string;
  entries: EmailLogEntry[];
}

export interface EmailLog {
  entries: EmailLogEntry[];
  counts: Record<EmailLogState, number>;
  lastReceivedAt: string | null;
  firstReceivedAt: string | null;
  truncated: boolean;
}

// Lima es UTC−5 todo el año (sin horario de verano desde 1994). Las fechas se
// escriben a mano y no con Intl: el ICU del servidor y el del navegador no
// abrevian igual («sep», «sept», «set») y la página se hidrata con los dos.
const LIMA_OFFSET_MS = 5 * 3_600_000;
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "setiembre", "octubre", "noviembre", "diciembre"];
const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"];

function lima(iso: string): Date {
  return new Date(Date.parse(iso) - LIMA_OFFSET_MS);
}

/** YYYY-MM-DD en Lima. */
export function limaDay(iso: string): string {
  return lima(iso).toISOString().slice(0, 10);
}

/** «19:20» en Lima. */
export function limaClock(iso: string): string {
  return lima(iso).toISOString().slice(11, 16);
}

function shiftDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** «2 oct» de un YYYY-MM-DD. */
function shortDate(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/** «Hoy · lunes 5 de octubre», «Ayer · …» o «Sábado 3 de octubre». */
export function emailLogDayLabel(day: string, now: Date = new Date()): string {
  const today = limaDay(now.toISOString());
  const d = new Date(`${day}T12:00:00Z`);
  const name = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`;
  if (day === today) return `Hoy · ${name}`;
  if (day === shiftDay(today, -1)) return `Ayer · ${name}`;
  const year = day.slice(0, 4) === today.slice(0, 4) ? "" : ` de ${day.slice(0, 4)}`;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}${year}`;
}

/** «hoy, 19:20», «ayer, 08:05» o «3 oct, 10:15». */
export function emailLogMoment(iso: string, now: Date = new Date()): string {
  const day = limaDay(iso);
  const today = limaDay(now.toISOString());
  if (day === today) return `hoy, ${limaClock(iso)}`;
  if (day === shiftDay(today, -1)) return `ayer, ${limaClock(iso)}`;
  return `${shortDate(day)}, ${limaClock(iso)}`;
}

/** «a las 17:30» si es el mismo día que `sameDayAs`; si no, «hoy a las…», «ayer a las…» o «el 2 oct a las…». */
export function emailLogWhen(iso: string, sameDayAs: string, now: Date = new Date()): string {
  const day = limaDay(iso);
  const clock = `a las ${limaClock(iso)}`;
  if (day === limaDay(sameDayAs)) return clock;
  const today = limaDay(now.toISOString());
  if (day === today) return `hoy ${clock}`;
  if (day === shiftDay(today, -1)) return `ayer ${clock}`;
  return `el ${shortDate(day)} ${clock}`;
}

/** «desde hoy», «desde ayer» o «desde el 6 set». */
export function emailLogSince(iso: string, now: Date = new Date()): string {
  const day = limaDay(iso);
  const today = limaDay(now.toISOString());
  if (day === today) return "desde hoy";
  if (day === shiftDay(today, -1)) return "desde ayer";
  return `desde el ${shortDate(day)}`;
}

function isOutcome(value: unknown): value is LabelOutcome {
  return typeof value === "string" && (LABEL_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Qué hizo el correo al llegar. Con la 0226 lo dice `outcome`; una fila sin él
 * se lee de las frases que escribe el webhook, con la misma regla que el
 * relleno de la migración.
 */
export function labelOutcome(row: Pick<EmailLabelRow, "outcome" | "olva_tracking" | "parse_error" | "linked_shipment_id" | "suggested_order_name" | "match_note">): LabelOutcome {
  if (isOutcome(row.outcome)) return row.outcome;
  if (!row.olva_tracking || row.parse_error) return "ilegible";
  const note = row.match_note ?? "";
  if (row.linked_shipment_id) return /^ya estaba/i.test(note) ? "ya_vinculado" : "vinculado";
  if (row.suggested_order_name) return "sugerido";
  if (/^coincide con varias/i.test(note)) return "ambiguo";
  return "sin_pareja";
}

const VIA: Record<string, string> = {
  cotejo_doc_externo: "el cotejo del portal (Doc. externo)",
  cotejo_nombre_direccion: "el cotejo del portal (nombre y dirección)",
  cotejo_dni: "el cotejo del portal (DNI)",
  cotejo_telefono: "el cotejo del portal, con el teléfono de este rótulo",
  rotulo_telefono: "otro correo de Olva (mismo teléfono)",
  rotulo_dni: "otro correo de Olva (mismo DNI)",
};

/** «el cotejo del portal (DNI)», «una persona a mano», o nada si no se sabe. PURA. */
export function linkedBy(event: EmailLogLinkEvent | undefined): string | null {
  if (!event) return null;
  const via = event.payload?.via ?? null;
  if (via && VIA[via]) return VIA[via];
  if (via?.startsWith("cotejo_")) return "el cotejo del portal";
  return event.actor ? "una persona a mano" : null;
}

export function buildEmailLog(input: {
  labels: EmailLabelRow[];
  /** Las salidas que hoy tienen alguno de los trackings, y las que vinculó cada correo. */
  shipments: EmailLogShipment[];
  events: EmailLogLinkEvent[];
  /** Los pedidos sugeridos que están en las tiendas de quien mira. */
  suggestedOrders: { order_id: string; order_name: string }[];
  /** Pedidos de las tiendas de quien mira: los demás se nombran sin enlace. */
  visibleOrderIds: Set<string>;
  /** RUC → organización de quien mira. */
  orgByRuc: Map<string, string>;
  truncated: boolean;
  now?: Date;
}): EmailLog {
  const now = input.now ?? new Date();
  const byId = new Map(input.shipments.map((s) => [s.id, s]));
  const byTracking = new Map<string, EmailLogShipment>();
  for (const s of input.shipments) {
    if (s.olva_tracking && s.olva_emision) {
      byTracking.set(formatOlvaTracking({ tracking: s.olva_tracking, emision: s.olva_emision }), s);
    }
  }
  const suggestedId = new Map(input.suggestedOrders.map((o) => [o.order_name, o.order_id]));
  const order = (s: EmailLogShipment | undefined): EmailLogOrder | null =>
    s?.order_name
      ? { id: s.order_id && input.visibleOrderIds.has(s.order_id) ? s.order_id : null, name: s.order_name }
      : null;

  /** El último evento que puso ESTE tracking en esa salida. */
  const eventFor = (shipmentId: string, tracking: string) =>
    input.events
      .filter((e) => e.shipment_id === shipmentId && (!e.payload?.olvaTracking || e.payload.olvaTracking === tracking))
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))[0];

  const entries = input.labels.map((row): EmailLogEntry => {
    const receivedAt = row.received_at ?? row.created_at;
    const outcome = labelOutcome(row);
    const tracking =
      row.olva_tracking && row.olva_emision ? formatOlvaTracking({ tracking: row.olva_tracking, emision: row.olva_emision }) : null;
    const current = tracking ? byTracking.get(tracking) : undefined;

    let state: EmailLogState;
    if (outcome === "ilegible" || !tracking) state = "ilegible";
    else if (outcome === "vinculado") state = "vinculado";
    else if (outcome === "ya_vinculado") state = "ya_vinculado";
    else state = current ? "despues" : "pendiente";

    let how: string | null = null;
    let later: string | null = null;
    if (state === "vinculado") {
      const mine = row.linked_shipment_id;
      if (!current) later = "Hoy el tracking ya no está en ninguna salida.";
      else if (mine && current.id !== mine) later = `Hoy el tracking está en ${current.order_name ?? "otra salida"}.`;
    } else if ((state === "ya_vinculado" || state === "despues") && current && tracking) {
      const event = eventFor(current.id, tracking);
      const by = linkedBy(event);
      if (by && event) how = `Lo puso ${by} ${emailLogWhen(event.occurred_at, receivedAt, now)}.`;
    } else if (state === "ya_vinculado" && !current) {
      later = "Hoy el tracking ya no está en ninguna salida.";
    }

    // El pedido de la fila: el que vinculó el correo (aunque después se
    // corrigiera, y `later` lo dice) o el que tiene hoy el tracking.
    const own = row.linked_shipment_id ? byId.get(row.linked_shipment_id) : undefined;
    const shown =
      state === "vinculado" ? (own ?? current) : state === "ya_vinculado" || state === "despues" ? (current ?? own) : undefined;

    return {
      id: row.id,
      receivedAt,
      day: limaDay(receivedAt),
      tracking,
      registro: row.registro,
      subject: row.subject,
      recipient: row.recipient_name,
      address: row.address,
      senderDoc: row.sender_doc,
      outcome,
      state,
      note: row.match_note ?? row.parse_error,
      order: order(shown),
      suggested:
        state === "pendiente" && row.suggested_order_name
          ? { id: suggestedId.get(row.suggested_order_name) ?? null, name: row.suggested_order_name }
          : null,
      how,
      later,
      orgId: row.sender_doc ? (input.orgByRuc.get(row.sender_doc) ?? null) : null,
    };
  });

  entries.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const counts = Object.fromEntries(EMAIL_LOG_STATES.map((s) => [s, 0])) as Record<EmailLogState, number>;
  for (const e of entries) counts[e.state] += 1;
  return {
    entries,
    counts,
    lastReceivedAt: entries[0]?.receivedAt ?? null,
    firstReceivedAt: entries.at(-1)?.receivedAt ?? null,
    truncated: input.truncated,
  };
}

/** Los correos de una lista, por día de llegada (el más reciente primero). PURA. */
export function groupEmailLogByDay(entries: EmailLogEntry[]): EmailLogDay[] {
  const days: EmailLogDay[] = [];
  for (const entry of entries) {
    const last = days.at(-1);
    if (last?.day === entry.day) last.entries.push(entry);
    else days.push({ day: entry.day, entries: [entry] });
  }
  return days;
}
