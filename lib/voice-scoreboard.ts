// «Agentes de voz: comparación» — MOM §11.8. Los agentes compiten en las
// mismas condiciones (misma cola, mismo guion); lo que cambia es la línea o el
// motor. Esta tabla los pone uno al lado del otro, solo con llamadas reales, en
// el rango de días que se elija (hoy, ayer, 7 días, este mes o uno a mano).
//
// Función pura: recibe las filas de `voice_calls` y devuelve una fila por
// agente, siempre los tres, para que un agente sin llamadas se vea en cero.

import {
  VOICE_AGENT_ELEVENLABS_KEY,
  VOICE_AGENT_ELEVENLABS_NAME,
  VOICE_AGENT_KEY,
  VOICE_AGENT_NAME,
  VOICE_AGENT_TELNYX_KEY,
  VOICE_AGENT_TELNYX_NAME,
} from "@/lib/shipments";

export interface VoiceScoreCall {
  telephony: string | null;
  provider: string | null;
  /** Lo marca `identificar_llamada`: la clienta contestó y habló con el agente. */
  started_at: string | null;
  outcome: string | null;
  /** `outcome_payload.salida_swayp.ok`: la guía Swayp nueva salió. */
  salidaOk: boolean;
}

export interface VoiceScoreRow {
  agent: string;
  name: string;
  llamadas: number;
  atendidas: number;
  /** Atendió y se cortó sin que el agente registrara la gestión. */
  sinGestion: number;
  confirma: number;
  programar: number;
  cancela: number;
  /** Guías Swayp creadas por sus «confirma». */
  guias: number;
}

const ORDER = [
  [VOICE_AGENT_KEY, VOICE_AGENT_NAME],
  [VOICE_AGENT_TELNYX_KEY, VOICE_AGENT_TELNYX_NAME],
  [VOICE_AGENT_ELEVENLABS_KEY, VOICE_AGENT_ELEVENLABS_NAME],
] as const;

/** Quién hizo la llamada: Zadarma es Daaph; Telnyx con Grok o con ElevenLabs. */
export function voiceAgentOfCall(c: Pick<VoiceScoreCall, "telephony" | "provider">): string {
  if (c.telephony !== "telnyx") return VOICE_AGENT_KEY;
  return c.provider === "elevenlabs" ? VOICE_AGENT_ELEVENLABS_KEY : VOICE_AGENT_TELNYX_KEY;
}

const GESTION = new Set(["confirma", "programar", "cancela"]);

export function aggregateVoiceScore(calls: readonly VoiceScoreCall[]): VoiceScoreRow[] {
  const rows = new Map<string, VoiceScoreRow>(
    ORDER.map(([agent, name]) => [
      agent,
      { agent, name, llamadas: 0, atendidas: 0, sinGestion: 0, confirma: 0, programar: 0, cancela: 0, guias: 0 },
    ]),
  );
  for (const c of calls) {
    const r = rows.get(voiceAgentOfCall(c))!;
    r.llamadas += 1;
    if (c.started_at) {
      r.atendidas += 1;
      if (!GESTION.has(c.outcome ?? "")) r.sinGestion += 1;
    }
    if (c.outcome === "confirma") r.confirma += 1;
    if (c.outcome === "programar") r.programar += 1;
    if (c.outcome === "cancela") r.cancela += 1;
    if (c.salidaOk) r.guias += 1;
  }
  return [...rows.values()];
}

/** Confirma sobre atendidas, o null sin atendidas. */
export function voiceConversion(r: Pick<VoiceScoreRow, "confirma" | "atendidas">): number | null {
  return r.atendidas ? r.confirma / r.atendidas : null;
}

/** Cuántas llamadas cuesta un «confirma», o null si aún no hay ninguno. */
export function voiceCallsPerConfirma(r: Pick<VoiceScoreRow, "confirma" | "llamadas">): number | null {
  return r.confirma ? r.llamadas / r.confirma : null;
}

/** El rango más largo que se consulta de una vez. */
export const VOICE_SCORE_MAX_DAYS = 366;

/**
 * Días calendario de Lima, ambos incluidos (YYYY-MM-DD), a instantes UTC
 * `[startIso, endIso)`. Null si las fechas no valen o el rango es demasiado
 * largo: llega desde el navegador.
 */
export function voiceScoreBounds(from: string, to: string): { startIso: string; endIso: string } | null {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(from) || !day.test(to) || from > to) return null;
  const start = Date.parse(`${from}T00:00:00-05:00`);
  const end = Date.parse(`${to}T00:00:00-05:00`) + 86_400_000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end - start > VOICE_SCORE_MAX_DAYS * 86_400_000) return null;
  return { startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() };
}
