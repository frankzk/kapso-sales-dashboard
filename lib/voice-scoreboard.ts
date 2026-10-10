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
  /** El pedido llamado: dos llamadas al mismo pedido son un pedido. */
  order_id?: string | null;
  provider: string | null;
  /** Lo marca `identificar_llamada`: el agente creyó oír a una persona. */
  started_at: string | null;
  outcome: string | null;
  /**
   * El vigilante cierra con «sin registrar_gestion dentro de la ventana» la
   * llamada que llegó a conversación y se cortó sin resultado. Es lo que separa
   * ese `no_contesta` del que registró el propio agente al oír un buzón.
   */
  error?: string | null;
  /** `outcome_payload.salida_swayp.ok`: la guía Swayp nueva salió. */
  salidaOk: boolean;
  /** `telephony_response.costo.total`: lo que cobró Telnyx (US$); null si no avisó. */
  costo?: number | null;
}

export interface VoiceScoreRow {
  agent: string;
  name: string;
  llamadas: number;
  /** Pedidos distintos llamados. */
  pedidos: number;
  atendidas: number;
  /** Atendió y terminó sin que el agente registrara la gestión. */
  sinGestion: number;
  confirma: number;
  programar: number;
  cancela: number;
  /** Guías Swayp creadas por sus «confirma». */
  guias: number;
  /** Suma de lo que cobró la línea, solo de las llamadas con costo avisado. */
  costo: number;
  /** Cuántas llamadas traen costo. Zadarma no lo avisa: Daaph queda en cero. */
  conCosto: number;
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

/** El vigilante la cerró: el agente la tomó por persona y nunca registró nada. */
function cortadaSinRegistro(c: Pick<VoiceScoreCall, "error">): boolean {
  return (c.error ?? "").startsWith("sin registrar_gestion");
}

/**
 * ¿La clienta habló con el agente? `started_at` solo dice que el agente CREYÓ
 * oír a una persona: si después él mismo registró «no contestó», era un buzón
 * (el 03-10-2026, 4 de las 10 llamadas de Daaph, ~19 s cada una). Contarlas
 * como atendidas daba 10 atendidas y 10 «sin gestión» sobre 10 buzones y cortes.
 */
export function voiceCallAnswered(c: Pick<VoiceScoreCall, "started_at" | "outcome" | "error">): boolean {
  if (!c.started_at) return false;
  return !(c.outcome === "no_contesta" && !cortadaSinRegistro(c));
}

export function aggregateVoiceScore(calls: readonly VoiceScoreCall[]): VoiceScoreRow[] {
  const rows = new Map<string, VoiceScoreRow>(
    ORDER.map(([agent, name]) => [
      agent,
      {
        agent,
        name,
        llamadas: 0,
        pedidos: 0,
        atendidas: 0,
        sinGestion: 0,
        confirma: 0,
        programar: 0,
        cancela: 0,
        guias: 0,
        costo: 0,
        conCosto: 0,
      },
    ]),
  );
  const pedidos = new Map<string, Set<string>>(ORDER.map(([agent]) => [agent, new Set<string>()]));
  for (const c of calls) {
    const r = rows.get(voiceAgentOfCall(c))!;
    r.llamadas += 1;
    if (c.order_id) pedidos.get(r.agent)!.add(c.order_id);
    if (voiceCallAnswered(c)) {
      r.atendidas += 1;
      if (!GESTION.has(c.outcome ?? "")) r.sinGestion += 1;
    }
    if (c.outcome === "confirma") r.confirma += 1;
    if (c.outcome === "programar") r.programar += 1;
    if (c.outcome === "cancela") r.cancela += 1;
    if (c.salidaOk) r.guias += 1;
    if (typeof c.costo === "number" && Number.isFinite(c.costo)) {
      r.costo += c.costo;
      r.conCosto += 1;
    }
  }
  return [...rows.values()].map((r) => ({ ...r, pedidos: pedidos.get(r.agent)!.size }));
}

/** Confirma sobre atendidas, o null sin atendidas. */
export function voiceConversion(r: Pick<VoiceScoreRow, "confirma" | "atendidas">): number | null {
  return r.atendidas ? r.confirma / r.atendidas : null;
}

/** Cuántas llamadas cuesta un «confirma», o null si aún no hay ninguno. */
export function voiceCallsPerConfirma(r: Pick<VoiceScoreRow, "confirma" | "llamadas">): number | null {
  return r.confirma ? r.llamadas / r.confirma : null;
}

/**
 * Costo por «confirma», solo cuando TODAS las llamadas traen costo: con una
 * parte sin costo el cociente saldría más barato de lo que fue.
 */
export function voiceCostPerConfirma(r: Pick<VoiceScoreRow, "confirma" | "costo" | "conCosto" | "llamadas">): number | null {
  if (!r.confirma || !r.conCosto || r.conCosto < r.llamadas) return null;
  return r.costo / r.confirma;
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
