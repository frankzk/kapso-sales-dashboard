// «Llamando ahora» en Envíos (MOM §11.8). La cola de Reproprovincia muestra en
// vivo qué pedido está llamando el agente de voz: esa fila va primero, con una
// nota que dice qué agente llama y desde cuándo. Funciones puras; la lectura
// vive en `getLiveVoiceCalls` y el sondeo en el tablero.

import {
  VOICE_AGENT_ELEVENLABS_NAME,
  VOICE_AGENT_NAME,
  VOICE_AGENT_TELNYX_NAME,
} from "@/lib/shipments";

export interface LiveVoiceCall {
  orderId: string;
  orderName: string | null;
  /** Nombre visible del agente: «Agente Daaph», «Agente Telnyx», «Agente ElevenLabs». */
  agent: string;
  /** `dialing`: suena el teléfono. `in_progress`: la clienta habla con el agente. */
  phase: "dialing" | "in_progress";
  /** Desde cuándo está en esta fase (ISO). */
  since: string;
}

/** Zadarma es Daaph; Telnyx con Grok es Telnyx y con ElevenLabs, ElevenLabs. */
export function liveAgentName(telephony: string | null, provider: string | null): string {
  if (telephony !== "telnyx") return VOICE_AGENT_NAME;
  return provider === "elevenlabs" ? VOICE_AGENT_ELEVENLABS_NAME : VOICE_AGENT_TELNYX_NAME;
}

/**
 * Las filas cuyo pedido está en llamada van primero, en el orden en que
 * estaban; el resto no se mueve. Se aplica sobre el orden que la persona eligió,
 * así que ordenar por otra columna no esconde la llamada en curso.
 */
export function pinLiveCalls<T extends { order_id: string | null }>(
  rows: readonly T[],
  live: ReadonlyMap<string, LiveVoiceCall>,
): T[] {
  if (!live.size) return rows as T[];
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const r of rows) (r.order_id && live.has(r.order_id) ? pinned : rest).push(r);
  return pinned.length ? [...pinned, ...rest] : (rows as T[]);
}

/** «0:42», «12:05»: minutos y segundos desde `since`; nunca negativo. */
export function liveElapsed(since: string, now: number): string {
  const ms = now - Date.parse(since);
  const s = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** La firma de las llamadas abiertas: si cambia, alguna empezó o terminó. */
export function liveSignature(calls: readonly LiveVoiceCall[]): string {
  return calls
    .map((c) => `${c.orderId}:${c.phase}`)
    .sort()
    .join("|");
}

/** Cómo terminó la última llamada, dicho en una palabra o dos. */
export interface LastVoiceCall {
  orderName: string | null;
  agent: string;
  /** «confirmó», «programó», «canceló», «no contestó», «se cortó sin gestión», «falló». */
  result: string;
  endedAt: string;
}

/** «Ahora» del agente: lo que llama, lo último que llamó y cuándo vuelve a llamar. */
export interface VoiceLiveStatus {
  calls: LiveVoiceCall[];
  last: LastVoiceCall | null;
  /** Próxima pasada del barrido dentro del horario (ISO); null si el automático está apagado. */
  nextPassAt: string | null;
}

export function lastCallResult(c: {
  status: string;
  outcome: string | null;
  error: string | null;
  started_at: string | null;
}): string {
  if (c.status === "failed") return "falló";
  if (c.outcome === "confirma") return "confirmó";
  if (c.outcome === "programar") return "programó";
  if (c.outcome === "cancela") return "canceló";
  if ((c.error ?? "").startsWith("sin registrar_gestion")) return "se cortó sin gestión";
  if (c.outcome === "no_contesta") return c.started_at ? "buzón o sin respuesta" : "no contestó";
  return "terminó";
}

/** El barrido corre cada 5 min (`*\/5`, en punto de reloj). */
export const VOICE_PASS_MINUTES = 5;

/**
 * La próxima pasada del barrido que cae dentro del horario de llamadas. Recibe
 * la regla del horario (`withinVoiceHours`) en vez de copiarla. Busca hasta dos
 * días adelante; null si no hay ninguna.
 */
export function nextVoicePass(now: Date, within: (d: Date) => boolean): Date | null {
  const step = VOICE_PASS_MINUTES * 60_000;
  let t = Math.floor(now.getTime() / step) * step + step;
  for (let i = 0; i < (48 * 60) / VOICE_PASS_MINUTES; i++, t += step) {
    const d = new Date(t);
    if (within(d)) return d;
  }
  return null;
}

/** «21:10», o «mañana 09:00», o «lun 09:00», en hora de Lima. */
export function limaPassLabel(at: string, now: number): string {
  const lima = (ms: number) => new Date(ms - 5 * 3_600_000);
  const a = lima(Date.parse(at));
  const n = lima(now);
  const hhmm = `${String(a.getUTCHours()).padStart(2, "0")}:${String(a.getUTCMinutes()).padStart(2, "0")}`;
  const day = (d: Date) => Math.floor(d.getTime() / 86_400_000);
  const diff = day(a) - day(n);
  if (diff <= 0) return hhmm;
  if (diff === 1) return `mañana ${hhmm}`;
  return `${["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][a.getUTCDay()]} ${hhmm}`;
}

/** «hace 2 min», «hace 1 h», «hace un momento». */
export function agoLabel(at: string, now: number): string {
  const m = Math.floor((now - Date.parse(at)) / 60_000);
  if (!Number.isFinite(m) || m < 1) return "hace un momento";
  if (m < 60) return `hace ${m} min`;
  return `hace ${Math.floor(m / 60)} h`;
}
