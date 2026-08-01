// Reglas de los pedidos por agencia Shalom. Puro + testeado.
//
// Aliclik valida estas reglas en su servidor; replicarlas aquí no es
// desconfianza, es que la operadora vea la fecha REAL de despacho en la pantalla
// en vez de enviar una y que el servidor la cambie por detrás sin avisar.

import { limaDateKey, parseHHMM, limaTimeHHMM } from "@/lib/aliclik-geo";

// ---------------------------------------------------------------------------
// Tamaño predeterminado
// ---------------------------------------------------------------------------

export const DEFAULT_AGENCY_PACKAGE_SIZE = "Caja Paquete XXS";

/**
 * Aliclik devuelve los tamaños en su propio orden, que actualmente comienza en
 * SOBRE. Para la operación de Kapta, la caja XXS es la medida habitual y debe
 * quedar elegida al abrir el formulario. Se devuelve el texto original del
 * catálogo para que la validación de Aliclik siga siendo exacta.
 */
export function selectDefaultAgencyPackageSize(sizes: readonly string[]): string {
  const available = sizes.filter((size) => size.trim());
  const wanted = DEFAULT_AGENCY_PACKAGE_SIZE.toLocaleLowerCase("es-PE");
  return (
    available.find((size) => size.trim().toLocaleLowerCase("es-PE") === wanted) ??
    available[0] ??
    ""
  );
}

// ---------------------------------------------------------------------------
// Fecha de despacho
// ---------------------------------------------------------------------------

export interface AgencyScheduleResult {
  /** La fecha que se enviará, ya ajustada. YYYY-MM-DD. */
  date: string;
  /** ¿Se movió respecto a lo que pidió la operadora? */
  adjusted: boolean;
  reason: "ok" | "after_cutoff" | "sunday" | "too_early" | "invalid_request";
  /** Explicación para enseñar debajo del selector de fecha. */
  message: string | null;
}

const DAY_MS = 86_400_000;

/** Suma días a una fecha "YYYY-MM-DD" sin tocar zonas horarias. */
function addDays(dateKey: string, days: number): string {
  const ms = Date.parse(`${dateKey}T00:00:00Z`);
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/** Día de la semana de una fecha "YYYY-MM-DD" (0 = domingo). */
function dayOfWeek(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

export function isValidDateKey(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Fecha mínima de despacho que Aliclik aceptará, según la hora de corte del
 * almacén (`formatTimeAgency` del catálogo):
 *   - antes del corte → hoy mismo
 *   - después del corte → mañana
 *   - si cae domingo → lunes
 *
 * Sin hora de corte conocida se asume "hoy": es Aliclik quien tiene la última
 * palabra, y no conviene retrasar un despacho por un dato que nos falta.
 */
export function minAgencyScheduleDate(
  formatTimeAgency: string | null | undefined,
  now: Date = new Date(),
): string {
  const today = limaDateKey(now);
  const cutoff = parseHHMM(formatTimeAgency);
  const nowMin = parseHHMM(limaTimeHHMM(now));

  let date = today;
  if (cutoff !== null && nowMin !== null && nowMin > cutoff) {
    date = addDays(date, 1);
  }
  if (dayOfWeek(date) === 0) date = addDays(date, 1); // domingo → lunes
  return date;
}

/**
 * Resuelve la fecha de despacho definitiva.
 *
 * Aliclik AJUSTA en silencio una fecha demasiado temprana (no falla). Que la
 * operadora vea el ajuste aquí evita que prometa a la clienta un día que el
 * courier nunca aceptó.
 */
export function resolveAgencyScheduleDate(input: {
  requested?: string | null;
  formatTimeAgency?: string | null;
  now?: Date;
}): AgencyScheduleResult {
  const now = input.now ?? new Date();
  const min = minAgencyScheduleDate(input.formatTimeAgency, now);
  const requested = (input.requested ?? "").trim();

  if (!requested) {
    const cutoff = parseHHMM(input.formatTimeAgency);
    const nowMin = parseHHMM(limaTimeHHMM(now));
    const afterCutoff = cutoff !== null && nowMin !== null && nowMin > cutoff;
    return {
      date: min,
      adjusted: false,
      reason: afterCutoff ? "after_cutoff" : dayOfWeek(min) === 1 && dayOfWeek(limaDateKey(now)) === 0 ? "sunday" : "ok",
      message: afterCutoff
        ? `Ya pasó la hora de corte del almacén (${input.formatTimeAgency}); el despacho más próximo es el ${min}.`
        : null,
    };
  }

  if (!isValidDateKey(requested)) {
    return {
      date: min,
      adjusted: true,
      reason: "invalid_request",
      message: `La fecha no tiene el formato YYYY-MM-DD; se usará ${min}.`,
    };
  }

  if (requested < min) {
    return {
      date: min,
      adjusted: true,
      reason: "too_early",
      message: `Aliclik no acepta despachar el ${requested}; la fecha más próxima es ${min}.`,
    };
  }

  if (dayOfWeek(requested) === 0) {
    const moved = addDays(requested, 1);
    return {
      date: moved,
      adjusted: true,
      reason: "sunday",
      message: `El ${requested} es domingo; el despacho se traslada al ${moved}.`,
    };
  }

  return { date: requested, adjusted: false, reason: "ok", message: null };
}

// ---------------------------------------------------------------------------
// Clave de recojo
// ---------------------------------------------------------------------------

/**
 * Alfabeto de la clave de recojo. Sin 0/O, 1/I/L ni 5/S: la clave se dicta por
 * teléfono y se copia a mano en la agencia, y una confusión ahí deja el paquete
 * sin poder recogerse.
 */
const KEY_ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789";
export const PICKUP_KEY_LENGTH = 6;

/**
 * Genera una clave de recojo. `rng` es inyectable para poder testear; por
 * defecto usa crypto.getRandomValues, no Math.random — esta clave es lo único
 * que hace falta para llevarse un paquete pagado.
 */
export function generatePickupKey(rng?: () => number): string {
  const next =
    rng ??
    (() => {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return (buf[0] ?? 0) / 2 ** 32;
    });
  let out = "";
  for (let i = 0; i < PICKUP_KEY_LENGTH; i++) {
    const idx = Math.min(KEY_ALPHABET.length - 1, Math.floor(next() * KEY_ALPHABET.length));
    out += KEY_ALPHABET[idx];
  }
  return out;
}

/**
 * Qué clave se envía a Aliclik.
 *
 * REGLA QUE NO SE NEGOCIA: si el pedido YA tiene una clave registrada, se usa
 * esa. Acuñar una segunda dejaría el paquete varado — la agencia exigiría una
 * clave y el equipo tendría otra guardada.
 */
export function resolveAgencyKeyCode(input: {
  existingKey?: string | null;
  generated?: string | null;
}): { keyCode: string; reused: boolean } {
  const existing = (input.existingKey ?? "").trim();
  if (existing) return { keyCode: existing, reused: true };
  const generated = (input.generated ?? "").trim() || generatePickupKey();
  return { keyCode: generated, reused: false };
}

// ---------------------------------------------------------------------------
// Unidades
// ---------------------------------------------------------------------------

export const AGENCY_MAX_UNITS = 6;

export interface UnitsCheck {
  ok: boolean;
  total: number;
  message: string | null;
}

/** Tope de 6 unidades por pedido de agencia, impuesto por Aliclik. */
export function validateAgencyUnits(
  items: readonly { quantity: number }[],
): UnitsCheck {
  const total = items.reduce((n, i) => n + (i.quantity ?? 0), 0);
  if (total <= 0) {
    return { ok: false, total, message: "El pedido no tiene unidades." };
  }
  if (total > AGENCY_MAX_UNITS) {
    return {
      ok: false,
      total,
      message: `Un pedido por agencia admite como máximo ${AGENCY_MAX_UNITS} unidades y este tiene ${total}.`,
    };
  }
  return { ok: true, total, message: null };
}

// ---------------------------------------------------------------------------
// Nombre del cliente
// ---------------------------------------------------------------------------

/**
 * Aliclik pide el nombre partido en tres (firstName / firstLastName /
 * secondLastName) y los TRES son obligatorios, pero Shopify entrega un solo
 * campo. Se parte por espacios con el criterio peruano: los dos últimos tokens
 * son los apellidos.
 *
 * Cuando no hay suficientes tokens se rellena con "." en lugar de dejarlo vacío:
 * un vacío hace que Aliclik rechace el pedido entero, y el apellido materno rara
 * vez es imprescindible para recoger un paquete. Es una decisión deliberada de
 * "que salga el pedido" — la interfaz muestra los tres campos por si hay que
 * corregirlos antes de enviar.
 */
export function splitCustomerName(full: string | null | undefined): {
  firstName: string;
  firstLastName: string;
  secondLastName: string;
} {
  const tokens = (full ?? "").trim().split(/\s+/).filter(Boolean);
  // "." en vez de vacío: un campo vacío hace que Aliclik rechace el pedido
  // entero, y el apellido materno rara vez impide recoger un paquete.
  const at = (i: number): string => tokens[i] ?? ".";
  if (!tokens.length) return { firstName: ".", firstLastName: ".", secondLastName: "." };
  if (tokens.length === 1) return { firstName: at(0), firstLastName: ".", secondLastName: "." };
  if (tokens.length === 2) {
    return { firstName: at(0), firstLastName: at(1), secondLastName: "." };
  }
  return {
    firstName: tokens.slice(0, tokens.length - 2).join(" ") || ".",
    firstLastName: at(tokens.length - 2),
    secondLastName: at(tokens.length - 1),
  };
}
