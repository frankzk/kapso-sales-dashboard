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
