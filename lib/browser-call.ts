// Llamar desde la computadora (MOM §8.5): lo que la ficha muestra mientras
// llama y lo que se guarda de cada llamada. Sin red ni secretos: lo usan el
// navegador y el servidor por igual.

/** Lo que ve la asesora, en el orden en que pasa. */
export type BrowserCallPhase = "preparando" | "conectando" | "timbrando" | "en_llamada" | "terminada" | "error";

export const BROWSER_CALL_PHASE_LABEL: Record<BrowserCallPhase, string> = {
  preparando: "Preparando la línea…",
  conectando: "Conectando…",
  timbrando: "Timbrando…",
  en_llamada: "En llamada",
  terminada: "Llamada terminada",
  error: "No se pudo llamar",
};

/**
 * El estado de la llamada del SDK de Telnyx (`call.state`, en minúsculas) en la
 * fase que ve la asesora. Lo que no se reconoce cuenta como «conectando»: es lo
 * único que no promete nada.
 */
export function phaseFromSdkState(state: string | null | undefined): BrowserCallPhase {
  switch ((state ?? "").toLowerCase()) {
    case "ringing":
    case "early":
      return "timbrando";
    case "active":
    case "held":
      return "en_llamada";
    case "hangup":
    case "destroy":
    case "purge":
      return "terminada";
    default:
      return "conectando";
  }
}

/** El reloj de la llamada: `0:07`, `2:13`, `1:02:03`. */
export function formatTalkTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** La duración dicha en palabras, para el historial: «45 s», «2 min 13 s». */
export function talkTimeWords(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

/** Lo que el navegador cuenta de una llamada terminada. */
export interface BrowserCallReport {
  /** El id de la llamada en el SDK de Telnyx. Hace idempotente el registro. */
  callId: string;
  /** Si la clienta contestó (la llamada llegó a «active»). */
  answered: boolean;
  /** Segundos desde que contestó hasta que se colgó. 0 si no contestó. */
  talkSeconds: number;
  /** Segundos desde que se marcó hasta que se colgó. */
  totalSeconds: number;
  /** La causa de fin que da Telnyx (`NORMAL_CLEARING`, `USER_BUSY`…). */
  cause: string | null;
  sipCode: number | null;
}

/** Cuatro horas: una llamada más larga que esto es un reloj roto, no una llamada. */
const MAX_CALL_SECONDS = 4 * 3600;

function seconds(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_CALL_SECONDS) return null;
  return Math.round(n);
}

/**
 * Valida lo que manda el navegador. Lo escribe la propia asesora, así que no se
 * le cree más de lo razonable: ids cortos, duraciones acotadas, una llamada sin
 * contestar no tiene tiempo de conversación.
 */
export function parseBrowserCallReport(raw: unknown): BrowserCallReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const callId = typeof r.callId === "string" ? r.callId.trim() : "";
  if (!callId || callId.length > 100 || !/^[\w.:-]+$/.test(callId)) return null;
  if (typeof r.answered !== "boolean") return null;
  const total = seconds(r.totalSeconds);
  const talk = seconds(r.talkSeconds);
  if (total === null || talk === null) return null;
  const cause = typeof r.cause === "string" && r.cause.trim() ? r.cause.trim().slice(0, 60) : null;
  const sip = r.sipCode === null || r.sipCode === undefined ? null : Number(r.sipCode);
  return {
    callId,
    answered: r.answered,
    talkSeconds: r.answered ? Math.min(talk, total) : 0,
    totalSeconds: total,
    cause,
    sipCode: sip !== null && Number.isInteger(sip) && sip >= 100 && sip < 700 ? sip : null,
  };
}

/**
 * Por qué no se habló, en palabras. Las causas son las de Telnyx (Q.850); lo que
 * no está en la lista se dice tal cual, para no inventar un motivo.
 */
export function noAnswerReason(cause: string | null, sipCode: number | null): string {
  switch ((cause ?? "").toUpperCase()) {
    case "USER_BUSY":
      return "ocupado";
    case "NO_ANSWER":
    case "NO_USER_RESPONSE":
      return "no contestó";
    case "CALL_REJECTED":
      return "rechazó la llamada";
    case "UNALLOCATED_NUMBER":
    case "INVALID_NUMBER_FORMAT":
      return "el número no existe";
    case "ORIGINATOR_CANCEL":
    case "NORMAL_CLEARING":
      return "se colgó antes de que contestara";
    case "SUBSCRIBER_ABSENT":
      return "apagado o fuera de cobertura";
    case "":
      return sipCode ? `terminó sin contestar (SIP ${sipCode})` : "terminó sin contestar";
    default:
      return `terminó sin contestar (${cause})`;
  }
}

/** La línea del historial del pedido. */
export function browserCallNote(report: BrowserCallReport, to: string, from: string): string {
  const head = `Llamada desde Kapta al ${to} (número ${from})`;
  return report.answered
    ? `${head}: contestó, ${talkTimeWords(report.talkSeconds)} de conversación.`
    : `${head}: ${noAnswerReason(report.cause, report.sipCode)}.`;
}
