// «Llamar con Anura», fase 1 (Click2Dial): las reglas puras. Sin red, sin
// secretos y sin módulos de Node: lo importan el servidor y la ficha por igual.
//
// EL FLUJO. La asesora pide la llamada desde la ficha; Kapta escribe la fila
// (`solicitada`) y pide a Anura un Click2Dial con su anexo. Anura hace sonar
// primero el teléfono de Anura de la asesora (la terminal principal del
// anexo) y, cuando ella contesta, marca a la clienta. Click2Dial responde 200
// sin cuerpo y sin id: el id de Kapta viaja en `customs` (`kapta-<id>`) y
// vuelve como `custom1` en cada aviso (START, TALK, END).
//
// EL RANGO SOLO SUBE. 0 solicitada · 10 sonando · 20 en_curso · 100 final.
// Un aviso repetido o fuera de orden no retrocede una llamada. La única
// excepción: una llamada que Kapta cerró sola por falta de avisos acepta
// todavía el END de verdad, que dice cómo terminó.
//
// Lo prueba `test/anura.test.ts`.

import { talkTimeWords } from "@/lib/browser-call";

export type AnuraCallStatus =
  | "solicitada"
  | "sonando"
  | "en_curso"
  | "contestada"
  | "no_contestada"
  | "ocupado"
  | "fallida"
  | "perdida";

export type AnuraCallMode = "pedido" | "prueba" | "entrante";
export type AnuraDirection = "out" | "in";
export type AnuraRank = 0 | 10 | 20 | 100;
export type AnuraRecordingStatus = "sin_grabacion" | "pendiente" | "guardada" | "vencida";

export const ANURA_STATUS_RANK: Record<AnuraCallStatus, AnuraRank> = {
  solicitada: 0,
  sonando: 10,
  en_curso: 20,
  contestada: 100,
  no_contestada: 100,
  ocupado: 100,
  fallida: 100,
  perdida: 100,
};

export const ANURA_ACTIVE_STATUSES: readonly AnuraCallStatus[] = ["solicitada", "sonando", "en_curso"];

export function isAnuraActive(status: AnuraCallStatus): boolean {
  return ANURA_STATUS_RANK[status] < 100;
}

/** Lo que ve la asesora, en una palabra o dos. */
export const ANURA_STATUS_LABEL: Record<AnuraCallStatus, string> = {
  solicitada: "Llamada pedida",
  sonando: "Sonando",
  en_curso: "En llamada",
  contestada: "Contestó",
  no_contestada: "No contestó",
  ocupado: "Ocupado",
  fallida: "No se pudo llamar",
  perdida: "Perdida",
};

/** La línea de ayuda mientras la llamada está viva. */
export const ANURA_STATUS_HINT: Partial<Record<AnuraCallStatus, string>> = {
  solicitada: "Contesta tu teléfono de Anura: cuando contestes, Anura marca a la clienta.",
  sonando: "Anura está marcando. Habla desde tu teléfono de Anura.",
  en_curso: "En llamada. Al colgar, registra el resultado en la confirmación.",
};

// ---------------------------------------------------------------------------
// Tiempos
// ---------------------------------------------------------------------------

/** Click2Dial: si Anura no contesta en 12 s, se da por fallida la petición. */
export const ANURA_CLICK2DIAL_TIMEOUT_MS = 12_000;
/** Una `solicitada` sin ningún aviso a los 60 s: Anura no llegó a llamar. */
export const ANURA_STALE_REQUEST_MS = 60_000;
/** Una llamada viva sin el END a las 2 horas: Anura no avisó el final. */
export const ANURA_STUCK_CALL_MS = 2 * 3_600_000;
/** El enlace de la grabación de Anura vence a los 30 minutos. */
export const ANURA_RECORDING_TTL_MS = 30 * 60_000;
/** La bitácora de avisos guarda 30 días. */
export const ANURA_EVENT_RETENTION_DAYS = 30;
/** El sondeo de la ficha mientras la llamada está viva. */
export const ANURA_POLL_INTERVAL_MS = 2_500;

export const ANURA_STALE_REASON = "Anura no llegó a hacer la llamada. Revisa que tu teléfono de Anura esté conectado y vuelve a intentar.";
export const ANURA_STUCK_REASON = "Anura no avisó el final de la llamada.";

// ---------------------------------------------------------------------------
// Teléfonos
// ---------------------------------------------------------------------------

/**
 * Lo que Click2Dial marca en Perú: los 9 dígitos del móvil, sin el 51. Acepta
 * `987654321`, `+51 987 654 321`, `51987654321`, `0051987654321`. Solo
 * móviles (empiezan por 9): un fijo o un extranjero da null.
 */
export function anuraPeruCalled(raw: string | null | undefined): string | null {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("0051")) digits = digits.slice(4);
  else if (digits.length === 11 && digits.startsWith("51")) digits = digits.slice(2);
  return /^9\d{8}$/.test(digits) ? digits : null;
}

/**
 * El número enmascarado: los dos primeros y los tres últimos dígitos
 * (`98••••321`). Para la bitácora y la tarjeta; nunca el número entero.
 */
export function maskPhone(raw: string | null | undefined): string {
  // Ya enmascarado (una entrante se guarda así): se deja igual.
  if (String(raw ?? "").includes("•")) return String(raw).trim().slice(0, 40);
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length <= 5) return "•••";
  return `${digits.slice(0, 2)}${"•".repeat(digits.length - 5)}${digits.slice(-3)}`;
}

/** Un anexo de la central: de 2 a 6 dígitos. */
export function normalizeAnuraExtension(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  return /^[0-9]{2,6}$/.test(t) ? t : null;
}

// ---------------------------------------------------------------------------
// El id que viaja en `customs`
// ---------------------------------------------------------------------------

export const ANURA_CUSTOMS_PREFIX = "kapta-";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(raw: unknown): raw is string {
  return typeof raw === "string" && UUID_RE.test(raw);
}

export function anuraCustoms(callId: string): string {
  return `${ANURA_CUSTOMS_PREFIX}${callId}`;
}

/** El id de `anura_calls` que vuelve en `custom1`, o null si no es nuestro. */
export function callIdFromCustom1(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t.toLowerCase().startsWith(ANURA_CUSTOMS_PREFIX)) return null;
  const id = t.slice(ANURA_CUSTOMS_PREFIX.length);
  return isUuid(id) ? id.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// El aviso
// ---------------------------------------------------------------------------

/** La plantilla que se pega en Anura (Configuración → Eventos → Agregar). */
export const ANURA_EVENT_TEMPLATE = `{
  "callId": "{{ cdrid }}",
  "event": "{{ hooktrigger }}",
  "direction": "{{ direction }}",
  "status": "{{ status }}",
  "calling": "{{ calling }}",
  "called": "{{ called }}",
  "dialTime": "{{ dialtime }}",
  "billSeconds": "{{ billseconds }}",
  "wasRecorded": "{{ wasrecorded }}",
  "accountExtension": "{{ accountextension }}",
  "answerExtension": "{{ answerextension }}",
  "custom1": "{{ custom1 }}",
  "recordingUrl": "{{ audio_play_mp3 }}"
}`;

export type AnuraHook = "START" | "TALK" | "END" | "OTRO";

export interface AnuraEvent {
  callId: string | null;
  hook: AnuraHook;
  /** El `hooktrigger` tal cual (recortado), para la bitácora. */
  rawEvent: string | null;
  direction: AnuraDirection | null;
  /** El `status` del END en mayúsculas (ANSWER, BUSY, NOANSWER…). */
  status: string | null;
  calling: string | null;
  called: string | null;
  dialSeconds: number | null;
  billSeconds: number;
  wasRecorded: boolean;
  accountExtension: string | null;
  answerExtension: string | null;
  custom1: string | null;
  /** Solo un enlace https de un host de Anura (`allowedRecordingUrl`). */
  recordingUrl: string | null;
  /** Llegó un enlace de grabación de otro host: se descartó (para la bitácora). */
  recordingRejectedHost: string | null;
}

/** Un valor de la plantilla: vacío si Anura no lo llenó (`{{ x }}`, `None`). */
function field(raw: unknown, max = 200): string | null {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim();
  if (!t || /^\{\{.*\}\}$/.test(t) || /^(none|null|undefined)$/i.test(t)) return null;
  return t.slice(0, max);
}

function count(raw: unknown): number | null {
  const t = field(raw);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n < 86_400 ? Math.round(n) : null;
}

function hookOf(raw: string | null): AnuraHook {
  const t = (raw ?? "").toUpperCase();
  return t === "START" || t === "TALK" || t === "END" ? t : "OTRO";
}

function directionOf(raw: string | null): AnuraDirection | null {
  const t = (raw ?? "").toUpperCase();
  if (t.startsWith("IN") || t === "ENTRANTE") return "in";
  if (t.startsWith("OUT") || t === "SALIENTE") return "out";
  return null;
}

/**
 * Los dominios de Anura de los que Kapta baja una grabación (el host exacto o
 * un subdominio). Cualquier otro enlace se descarta: el aviso no se firma, y
 * sin esta lista quien tuviera la URL del aviso podría hacer que el servidor
 * de Kapta pidiera cualquier dirección. `ANURA_RECORDING_HOSTS` agrega más
 * (separados por comas) si la prueba real muestra otro host.
 */
export const ANURA_RECORDING_HOSTS: readonly string[] = ["anura.pe", "anura.com.pe", "anura.com.ar"];

/** El host es de Anura (o de la lista extra): exacto o subdominio. */
export function anuraRecordingHostAllowed(host: string, extra: readonly string[] = []): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  return [...ANURA_RECORDING_HOSTS, ...extra]
    .map((s) => s.trim().toLowerCase().replace(/^\*?\./, ""))
    .filter(Boolean)
    .some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Un enlace de grabación que Kapta puede bajar: https, puerto 443, sin
 * usuario ni clave, de un host de Anura. Devuelve el enlace normalizado o
 * null.
 */
export function allowedRecordingUrl(raw: string | null | undefined, extra: readonly string[] = []): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (u.port && u.port !== "443") return null;
    return anuraRecordingHostAllowed(u.hostname, extra) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** El host de un enlace https que no es de Anura (para la bitácora), o null. */
function rejectedRecordingHost(raw: string | null, extra: readonly string[]): string | null {
  if (!raw || allowedRecordingUrl(raw, extra)) return null;
  try {
    return new URL(raw).hostname.slice(0, 120) || "sin host";
  } catch {
    return "enlace no válido";
  }
}

export interface ParseAnuraEventOptions {
  /** Hosts extra de grabación (`ANURA_RECORDING_HOSTS`). */
  extraRecordingHosts?: readonly string[];
}

/** Lee el cuerpo del aviso. Null si no es un objeto. */
export function parseAnuraEvent(raw: unknown, opts: ParseAnuraEventOptions = {}): AnuraEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const rawEvent = field(r.event, 40);
  const recorded = (field(r.wasRecorded, 10) ?? "").toLowerCase();
  const extra = opts.extraRecordingHosts ?? [];
  const recordingRaw = field(r.recordingUrl, 2000);
  return {
    callId: field(r.callId, 120),
    hook: hookOf(rawEvent),
    rawEvent,
    direction: directionOf(field(r.direction, 20)),
    status: field(r.status, 40)?.toUpperCase() ?? null,
    calling: field(r.calling, 40),
    called: field(r.called, 40),
    dialSeconds: count(r.dialTime),
    billSeconds: count(r.billSeconds) ?? 0,
    wasRecorded: ["1", "true", "yes", "si", "sí", "y"].includes(recorded),
    accountExtension: field(r.accountExtension, 20),
    answerExtension: field(r.answerExtension, 20),
    custom1: field(r.custom1, 120),
    recordingUrl: allowedRecordingUrl(recordingRaw, extra),
    recordingRejectedHost: rejectedRecordingHost(recordingRaw, extra),
  };
}

/** El aviso para la bitácora: los teléfonos enmascarados y sin la grabación. */
export function maskedEventPayload(ev: AnuraEvent): Record<string, unknown> {
  return {
    callId: ev.callId,
    event: ev.rawEvent,
    direction: ev.direction,
    status: ev.status,
    calling: maskPhone(ev.calling),
    called: maskPhone(ev.called),
    dialSeconds: ev.dialSeconds,
    billSeconds: ev.billSeconds,
    wasRecorded: ev.wasRecorded,
    accountExtension: ev.accountExtension,
    answerExtension: ev.answerExtension,
    custom1: ev.custom1,
    hasRecording: ev.recordingUrl !== null,
  };
}

// ---------------------------------------------------------------------------
// La máquina de estados
// ---------------------------------------------------------------------------

/** Lo que la asesora lee cuando el END llega con un fallo de Anura. */
export function anuraFailureReason(status: string | null): string {
  switch ((status ?? "").toUpperCase()) {
    case "CONGESTION":
      return "Destino restringido para tu anexo o sin ruta en Anura: revisa en Anura que tu anexo pueda llamar a celulares.";
    case "CHANUNAVAIL":
      return "El número no está disponible.";
    case "FAILED":
      return "Anura no pudo completar la llamada.";
    default:
      return "Anura no pudo completar la llamada.";
  }
}

/** Cómo terminó una saliente, según el END. */
export function outboundEndStatus(status: string | null, billSeconds: number): AnuraCallStatus {
  const s = (status ?? "").toUpperCase();
  if (billSeconds > 0 || s === "ANSWER" || s === "ANSWERED") return "contestada";
  if (s === "BUSY") return "ocupado";
  if (s === "NOANSWER" || s === "NO ANSWER" || s === "CANCEL") return "no_contestada";
  if (s === "FAILED" || s === "CONGESTION" || s === "CHANUNAVAIL") return "fallida";
  return "no_contestada";
}

/**
 * Cómo terminó una entrante. En la fase 1 no hay timbre en Kapta, y Anura
 * marca ANSWER también cuando contestó su mensaje automático: solo cuenta
 * como contestada si la tomó el anexo de una asesora y se habló.
 */
export function inboundEndStatus(ev: AnuraEvent, advisorExtensions: ReadonlySet<string>): AnuraCallStatus {
  const ext = ev.answerExtension;
  return ext && advisorExtensions.has(ext) && ev.billSeconds > 0 ? "contestada" : "perdida";
}

export interface AnuraCallState {
  status: AnuraCallStatus;
  /** Kapta la cerró sola (sin avisos a los 60 s o sin END a las 2 h). */
  closedByTimeout: boolean;
}

export interface AnuraTransition {
  status: AnuraCallStatus;
  rank: AnuraRank;
  final: boolean;
  failureReason: string | null;
}

/** El estado al que lleva un aviso, sin mirar el estado actual. */
export function eventTarget(
  ev: AnuraEvent,
  direction: AnuraDirection,
  advisorExtensions: ReadonlySet<string> = new Set(),
): AnuraTransition | null {
  let status: AnuraCallStatus;
  if (ev.hook === "START") status = "sonando";
  else if (ev.hook === "TALK") status = "en_curso";
  else if (ev.hook === "END") status = direction === "in" ? inboundEndStatus(ev, advisorExtensions) : outboundEndStatus(ev.status, ev.billSeconds);
  else return null;
  const rank = ANURA_STATUS_RANK[status];
  return { status, rank, final: rank === 100, failureReason: status === "fallida" ? anuraFailureReason(ev.status) : null };
}

/**
 * Lo que un aviso le hace a una llamada. Null = nada (repetido, fuera de
 * orden o de otro tipo). El rango solo sube; una llamada cerrada sola por
 * Kapta acepta todavía el END.
 */
export function applyAnuraEvent(
  current: AnuraCallState,
  ev: AnuraEvent,
  direction: AnuraDirection,
  advisorExtensions: ReadonlySet<string> = new Set(),
): AnuraTransition | null {
  const target = eventTarget(ev, direction, advisorExtensions);
  if (!target) return null;
  const rank = ANURA_STATUS_RANK[current.status];
  if (rank === 100) return current.closedByTimeout && target.final ? target : null;
  return target.rank > rank ? target : null;
}

/**
 * Por qué no se puede pedir otra llamada, según cómo está la que sigue viva.
 * Una pedida sin avisos se suelta sola al minuto; una que ya sonó solo se
 * suelta con el fin de Anura o, si nunca llega, a las 2 horas.
 */
export function anuraBusyError(activeStatus: AnuraCallStatus | null | undefined): string {
  if (activeStatus === "sonando" || activeStatus === "en_curso") {
    return "Ya tienes una llamada de Anura en curso. Cuelga en tu teléfono de Anura; si Anura no avisa el final, Kapta la libera sola a las 2 horas.";
  }
  return "Ya tienes una llamada de Anura pedida. Si tu teléfono de Anura no suena, se libera sola al minuto.";
}

// ---------------------------------------------------------------------------
// El historial del pedido
// ---------------------------------------------------------------------------

/**
 * La llamada de un pedido terminó con un aviso de fin de Anura, y por eso
 * dejó su hecho en el historial (`recordAnuraOrderFact`). No llega: la
 * petición que Anura rechazó ni la que Kapta cerró sola (60 s o 2 h) mientras
 * el fin no llegue. El fin de Anura es lo único que escribe `was_recorded`.
 */
export function anuraReachedHistory(row: {
  mode: AnuraCallMode;
  status: AnuraCallStatus;
  closed_by_timeout: boolean;
  was_recorded: boolean | null;
}): boolean {
  return row.mode === "pedido" && !isAnuraActive(row.status) && !row.closed_by_timeout && row.was_recorded !== null;
}

/** La línea del historial (`order_events.note`), con el número enmascarado. */
export function anuraCallNote(input: {
  status: AnuraCallStatus;
  billSeconds: number | null;
  phone: string | null;
  extension: string | null;
  failureReason: string | null;
}): string {
  const to = maskPhone(input.phone);
  const head = `Llamada con Anura${to ? ` al ${to}` : ""}${input.extension ? ` (anexo ${input.extension})` : ""}`;
  switch (input.status) {
    case "contestada":
      return (input.billSeconds ?? 0) > 0
        ? `${head}: contestó, ${talkTimeWords(input.billSeconds ?? 0)} de conversación.`
        : `${head}: contestó.`;
    case "ocupado":
      return `${head}: ocupado.`;
    case "fallida":
      return `${head}: no se pudo llamar. ${input.failureReason ?? ""}`.trim();
    case "no_contestada":
      return `${head}: no contestó.`;
    default:
      return `${head}: ${ANURA_STATUS_LABEL[input.status].toLowerCase()}.`;
  }
}
