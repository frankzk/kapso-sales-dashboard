// Agente de voz para Reproprovincia — reglas puras (MOM §11.8).
//
// Aquí vive todo lo que decide sin tocar la base, para poder probarlo:
//   - la ficha que devuelve `identificar_llamada` (lo que el agente dice),
//   - qué llamada abierta es la de este agente (la atadura),
//   - qué hechos escribe cada `disposition` de `registrar_gestion`.
//
// El agente es un operador más: no tiene estados propios. Todo lo que escribe
// sobre el pedido pasa por `register_confirmation_attempt_v2`, con los mismos
// resultados que una asesora (§6.1).

import { zadarmaLocalPeru } from "@/lib/zadarma";

export const VOICE_SOURCE = "agente_voz";

/** Franja de reparto que el agente ofrece. Swayp reparte en horario de día. */
export const VOICE_DELIVERY_WINDOW = "de 9 de la mañana a 6 de la tarde";

/** Minutos que una llamada puede estar marcando antes de darse por caída. */
export const DIALING_TTL_MINUTES = 3;
/** Minutos que una llamada puede estar en curso antes de darse por caída. */
export const IN_PROGRESS_TTL_MINUTES = 10;

// ── Producto corto ──────────────────────────────────────────────────────────

const STOP_TAIL = new Set(["de", "del", "para", "con", "y", "la", "el", "los", "las", "en", "a"]);

/**
 * El nombre que el agente dice en voz alta. El título de Shopify es de
 * catálogo —marca, variante, «(60 Cápsulas)»— y cada palabra son segundos
 * cobrados. Regla: si el título trae «Marca – Nombre», se queda el nombre; se
 * quitan paréntesis y las palabras en mayúsculas de marca; y se corta en
 * cuatro palabras sin terminar en preposición.
 */
export function productoCorto(title: string | null | undefined): string {
  let t = String(title ?? "").trim();
  if (!t) return "su pedido";
  const dash = t.split(/\s[–—-]\s/);
  if (dash.length > 1) t = dash.slice(1).join(" ");
  t = t.replace(/\([^)]*\)/g, " ");
  const words = t
    .split(/\s+/)
    .filter(Boolean)
    // «SUPER HUMAN», «KENKU»: marca en mayúsculas, no lo que la clienta pidió.
    .filter((w) => !(w.length > 1 && w === w.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(w)));
  const cut = words.slice(0, 4);
  while (cut.length > 1 && STOP_TAIL.has((cut[cut.length - 1] ?? "").toLowerCase())) cut.pop();
  return cut.join(" ") || "su pedido";
}

// ── Fechas en Lima ──────────────────────────────────────────────────────────

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

interface LimaDay {
  key: string; // YYYY-MM-DD
  weekday: number; // 0 = domingo
  day: number;
  month: number; // 1-12
}

/** Perú es UTC-5 fijo, sin horario de verano: restar cinco horas basta. */
function limaDay(at: Date, addDays = 0): LimaDay {
  const shifted = new Date(at.getTime() - 5 * 3_600_000 + addDays * 86_400_000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  return {
    key: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    weekday: shifted.getUTCDay(),
    day: d,
    month: m,
  };
}

function texto(d: LimaDay): string {
  return `${DIAS[d.weekday]} ${d.day} de ${MESES[d.month - 1]}`;
}

export interface VoiceDates {
  hoy: string;
  hoy_texto: string;
  fecha_minima: string;
  fecha_minima_texto: string;
  /** Lo que dice el saludo: «el día de mañana», o «el lunes 28» si mañana es domingo. */
  fecha_saludo: string;
}

/**
 * La primera fecha que el agente ofrece es MAÑANA en Lima, nunca hoy
 * (§11.6: una reprogramación no puede ser de ayer, y hoy ya no da tiempo) y
 * nunca domingo. Si mañana es domingo, el lunes.
 */
export function voiceDates(now: Date): VoiceDates {
  const hoy = limaDay(now);
  let min = limaDay(now, 1);
  const skipped = min.weekday === 0;
  if (skipped) min = limaDay(now, 2);
  return {
    hoy: hoy.key,
    hoy_texto: texto(hoy),
    fecha_minima: min.key,
    fecha_minima_texto: texto(min),
    fecha_saludo: skipped ? `el ${DIAS[min.weekday]} ${min.day}` : "el día de mañana",
  };
}

// ── Ficha de identificar_llamada ────────────────────────────────────────────

export interface FichaInput {
  storeName: string | null;
  customerName: string | null;
  orderName: string | null;
  lineItems: { title?: string | null; quantity?: number | null }[] | null;
  total: number | string | null;
  district: string | null;
  province: string | null;
  address: string | null;
  reference: string | null;
  mode: "real" | "test";
}

export type Ficha = VoiceDates & {
  encontrada: true;
  modo: "real" | "test";
  tienda: string;
  nombre: string;
  pedido: string;
  producto: string;
  producto_corto: string;
  cantidad: number;
  monto: string;
  distrito: string;
  ciudad: string;
  direccion: string;
  referencia: string;
  ventana_horaria: string;
};

/** «Kenku Peru» → «Kenku». La clienta conoce la marca, no la razón social. */
export function tiendaHablada(name: string | null | undefined): string {
  return String(name ?? "").replace(/\s+(peru|perú)$/i, "").trim() || "la tienda";
}

/** Primer nombre, en tipo título. «GONZALO PÉREZ» → «Gonzalo». */
export function primerNombre(name: string | null | undefined): string {
  const first = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first) return "";
  return first.charAt(0).toLocaleUpperCase("es") + first.slice(1).toLocaleLowerCase("es");
}

/** «298.00» → «S/ 298»; «149.5» → «S/ 149.50». */
export function montoHablado(total: number | string | null | undefined): string {
  const n = Number(total);
  if (!Number.isFinite(n) || n <= 0) return "";
  return Number.isInteger(n) ? `S/ ${n}` : `S/ ${n.toFixed(2)}`;
}

export function buildFicha(input: FichaInput, now: Date): Ficha {
  const items = (input.lineItems ?? []).filter((li) => (li?.title ?? "").trim());
  const first = items[0];
  const cantidad = items.reduce((s, li) => s + (Number(li.quantity) || 1), 0) || 1;
  const producto = items.map((li) => String(li.title).trim()).join(" + ") || "su pedido";
  const corto =
    items.length > 1 ? `${productoCorto(first?.title)} y otros productos` : productoCorto(first?.title);
  return {
    encontrada: true,
    modo: input.mode,
    tienda: tiendaHablada(input.storeName),
    nombre: primerNombre(input.customerName),
    // El nombre de Shopify, nunca el código de guía (§11.1, `recoveryOrderName`).
    pedido: input.orderName ?? "",
    producto,
    producto_corto: corto,
    cantidad,
    monto: montoHablado(input.total),
    distrito: input.district ?? "",
    ciudad: input.province ?? input.district ?? "",
    direccion: input.address ?? "",
    referencia: input.reference ?? "",
    ventana_horaria: VOICE_DELIVERY_WINDOW,
    ...voiceDates(now),
  };
}

// ── La atadura: qué llamada abierta es la de este agente ────────────────────

export interface OpenCall {
  id: string;
  agent_number: string;
  phone: string;
  status: "queued" | "dialing" | "in_progress";
  dialed_at: string | null;
  started_at: string | null;
}

/** Mismo formato que marca Zadarma, para comparar «+51 1 705 8243» con «17058243». */
function localDigits(p: string | null | undefined): string {
  return zadarmaLocalPeru(p) ?? String(p ?? "").replace(/\D/g, "");
}

/** Una llamada abierta cuya ventana ya pasó está caída: no se le atribuye nada. */
export function isStale(call: OpenCall, now: Date): boolean {
  const ref = call.status === "in_progress" ? call.started_at : call.dialed_at;
  if (!ref) return call.status !== "queued";
  const ttl = call.status === "in_progress" ? IN_PROGRESS_TTL_MINUTES : DIALING_TTL_MINUTES;
  return now.getTime() - new Date(ref).getTime() > ttl * 60_000;
}

export interface StaleResolution {
  status: "completed" | "failed";
  outcome: "no_contesta" | "sin_resultado";
  error: string | null;
  /** Escribir sobre el pedido el `no_contesta` que el agente no pudo registrar. */
  registerNoAnswer: boolean;
}

/**
 * Qué se hace con una llamada caducada (MOM §11.8). La fila pasa a
 * `in_progress` recién cuando `identificar_llamada` corre, y el agente la
 * llama al oír a una persona. Una llamada que nunca pasó de `dialing` es una
 * clienta que no contestó (o cuya línea no dijo nada): el agente no pudo
 * registrarlo. En modo real se escribe ese `no_contesta`, como lo habría
 * hecho él. Una llamada `in_progress` sin registro se cortó a media
 * conversación: eso no es gestión y no se escribe nada.
 */
export function staleCallResolution(call: Pick<OpenCall, "status"> & { mode: "real" | "test" }): StaleResolution {
  if (call.status === "dialing") {
    return { status: "completed", outcome: "no_contesta", error: null, registerNoAnswer: call.mode === "real" };
  }
  return {
    status: "failed",
    outcome: "sin_resultado",
    error: call.status === "in_progress" ? "sin registrar_gestion dentro de la ventana" : "no se marcó",
    registerNoAnswer: false,
  };
}

/**
 * Elige la fila de la llamada en curso. MOM §11.8: la llamada se ata a la
 * fila que Kapta escribió ANTES de marcar, nunca a un pedido buscado por el
 * teléfono.
 *
 * - `agentNumber` viene en la URL de la tool (cada agente de xAI tiene la
 *   suya). Hay una sola llamada abierta por número de agente (índice único),
 *   así que con él la elección es exacta.
 * - Sin él, se acepta solo si hay UNA llamada abierta en total.
 * - `customerPhone`, si llega y coincide con una fila, gana: es la atadura
 *   exacta. Si es un celular peruano que no coincide con ninguna, es otra
 *   persona llamando al número del agente y no se ata a nada. Un número que
 *   no es celular (el de la cuenta, el del agente) no decide: se cae a la
 *   única llamada abierta.
 */
export function pickOpenCall(
  calls: readonly OpenCall[],
  wanted: "dialing" | "in_progress",
  opts: { now: Date; agentNumber?: string | null; customerPhone?: string | null },
): { call: OpenCall } | { error: "ninguna" | "ambigua" | "otro_numero" } {
  const live = calls.filter((c) => c.status === wanted && !isStale(c, opts.now));
  const agent = localDigits(opts.agentNumber);
  const scoped = agent ? live.filter((c) => localDigits(c.agent_number) === agent) : live;
  const phone = localDigits(opts.customerPhone);
  if (phone) {
    const [only, ...rest] = scoped.filter((c) => localDigits(c.phone) === phone);
    if (only && rest.length === 0) return { call: only };
    // Un celular peruano que no es el de ninguna llamada abierta es otra
    // persona marcando al número del agente —típicamente una clienta que
    // devuelve una perdida— mientras el agente llama a alguien. No recibe la
    // ficha ajena ni puede registrar sobre ese pedido (24-09-2026).
    if (zadarmaLocalPeru(opts.customerPhone)?.startsWith("9")) return { error: "otro_numero" };
  }
  const [single, ...others] = scoped;
  if (single && others.length === 0) return { call: single };
  return { error: scoped.length === 0 ? "ninguna" : "ambigua" };
}

// ── registrar_gestion: qué hechos escribe cada disposition ──────────────────

export const VOICE_DISPOSITIONS = ["confirma", "programar", "no_contesta", "cancela"] as const;
export type VoiceDisposition = (typeof VOICE_DISPOSITIONS)[number];

export interface GestionInput {
  disposition?: string | null;
  fecha?: string | null;
  rango?: string | null;
  direccion_confirmada?: string | null;
  referencia?: string | null;
  motivo?: string | null;
  resumen?: string | null;
}

export type GestionAction =
  | {
      kind: "attempt";
      disposition: VoiceDisposition;
      result: "confirmado" | "volver_a_contactar" | "se_deja_mensaje" | "sin_respuesta";
      nextContactOn: string | null;
      note: string;
      extra: Record<string, unknown>;
    }
  | { kind: "discard"; disposition: "cancela"; reason: string; note: string; extra: Record<string, unknown> }
  | { kind: "propose_discard"; disposition: "cancela"; reason: string; note: string; extra: Record<string, unknown> }
  | { kind: "invalid"; error: string };

const clean = (s: string | null | undefined, max = 500) => String(s ?? "").trim().slice(0, max);

/** «No me llamen», «que no la vuelvan a llamar», «no quiere que la llamen». */
export function pideNoLlamar(text: string): boolean {
  return /no\s+(quiere\s+que\s+)?(me|la|lo|le|nos)?\s*(vuelvan\s+a\s+|sigan\s+)?llam(en|ar|ando)/i.test(text);
}

/**
 * Traduce lo que manda el agente a los hechos de §11.8.
 *
 * | disposition | hecho                                                  |
 * | confirma    | `confirmado` con fecha, rango y dirección en el payload |
 * | programar   | `volver_a_contactar` si trae fecha futura; si no,       |
 * |             | `se_deja_mensaje` (contestó otra persona, o sin fecha)  |
 * | no_contesta | `sin_respuesta`                                         |
 * | cancela     | descarte si la tienda lo delega; si no, solo propuesta  |
 *
 * `confirmado` sin fecha futura no se acepta: la reprogramación sin fecha no
 * es reprogramación (§11.6), y el pedido se queda en la cola como
 * `se_deja_mensaje` con la nota, para que una persona retome.
 */
export function translateGestion(
  input: GestionInput,
  opts: { today: string; canDiscard: boolean; voiceCallId: string },
): GestionAction {
  const d = clean(input.disposition, 40).toLowerCase() as VoiceDisposition;
  if (!VOICE_DISPOSITIONS.includes(d)) {
    return { kind: "invalid", error: `disposition debe ser una de: ${VOICE_DISPOSITIONS.join(", ")}` };
  }
  const resumen = clean(input.resumen, 1000);
  const fecha = clean(input.fecha, 10);
  const fechaFutura = /^\d{4}-\d{2}-\d{2}$/.test(fecha) && fecha > opts.today ? fecha : null;
  const extra: Record<string, unknown> = { voice_call_id: opts.voiceCallId, voice_disposition: d };
  // El prompt pide escribir textual «que no la llamen» en el resumen. Se
  // marca para que el barrido no vuelva a llamar a ese teléfono (§11.8, cond. 9).
  if (pideNoLlamar(`${resumen} ${clean(input.motivo)}`)) extra.no_llamar = true;
  const noteFor = (prefix: string) => ["Agente de voz", prefix, resumen].filter(Boolean).join(" · ");

  if (d === "confirma") {
    if (!fechaFutura) {
      return {
        kind: "attempt",
        disposition: d,
        result: "se_deja_mensaje",
        nextContactOn: null,
        note: noteFor("aceptó, pero sin fecha futura válida; revisar"),
        extra: { ...extra, fecha_recibida: fecha || null },
      };
    }
    return {
      kind: "attempt",
      disposition: d,
      result: "confirmado",
      nextContactOn: null,
      note: noteFor(`acepta reenvío el ${fechaFutura}`),
      extra: {
        ...extra,
        reenvio: "swayp",
        fecha_entrega: fechaFutura,
        rango: clean(input.rango, 120) || null,
        direccion_confirmada: clean(input.direccion_confirmada) || null,
        referencia: clean(input.referencia) || null,
      },
    };
  }
  if (d === "programar") {
    return fechaFutura
      ? {
          kind: "attempt",
          disposition: d,
          result: "volver_a_contactar",
          nextContactOn: fechaFutura,
          note: noteFor("volver a llamar"),
          extra,
        }
      : {
          kind: "attempt",
          disposition: d,
          result: "se_deja_mensaje",
          nextContactOn: null,
          note: noteFor("sin fecha pactada"),
          extra,
        };
  }
  if (d === "no_contesta") {
    return { kind: "attempt", disposition: d, result: "sin_respuesta", nextContactOn: null, note: noteFor(""), extra };
  }
  const motivo = clean(input.motivo) || resumen || "sin motivo dicho";
  const reason = `Agente de voz: ${motivo}`;
  return opts.canDiscard
    ? { kind: "discard", disposition: "cancela", reason, note: noteFor("no quiere el pedido"), extra: { ...extra, motivo } }
    : { kind: "propose_discard", disposition: "cancela", reason, note: noteFor("propone descartar"), extra: { ...extra, motivo } };
}
