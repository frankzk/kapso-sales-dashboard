// «Gestión por persona» (Envíos, MOM §11.8): asesoras y agentes de voz en una
// sola tabla, para el rango de días que se elija.
//
// Antes eran dos tablas que se contradecían a la vista (10-10-2026): «Hoy por
// asesora» decía 24 «Guías» (guías distintas tocadas) y «Agentes de voz:
// comparación» 1 «Guías Swayp» (salidas creadas). Además, la salida Swayp de un
// agente le sumaba tres gestiones (su llamada y las dos filas `reroute`).
//
// Cada fila sale de una sola fuente:
//   · asesora → sus gestiones en `shipment_calls`;
//   · agente  → sus llamadas reales en `voice_calls` (una llamada, una gestión).
// Las columnas comunes significan lo mismo para las dos; las del agente
// (atendidas, costo…) quedan vacías en las asesoras.
//
// Función pura: recibe lo ya agregado y devuelve filas y total.

import { isVoiceAgentKey, type ReproDayAgentCount } from "@/lib/shipments";
import type { VoiceScoreRow } from "@/lib/voice-scoreboard";

export interface TeamScoreRow {
  key: string;
  name: string;
  /** Agente de voz IA (lleva la marca y las columnas de llamada). */
  voice: boolean;
  gestiones: number;
  pedidos: number;
  /** Salieron a En ruta: la reprogramación de la asesora o la salida Swayp del agente. */
  reprogramadas: number;
  /** Null en los agentes: no anulan, a lo más proponen (`cancela`). */
  anuladas: number | null;
  entregadas: number | null;
  // Solo agentes (null en las asesoras):
  atendidas: number | null;
  sinGestion: number | null;
  programar: number | null;
  cancela: number | null;
  costo: number | null;
  conCosto: number;
  llamadas: number;
}

export interface TeamScore {
  rows: TeamScoreRow[];
  total: TeamScoreRow;
}

function personRow(p: ReproDayAgentCount & { name: string }): TeamScoreRow {
  return {
    key: p.agent,
    name: p.name,
    voice: false,
    gestiones: p.gestiones,
    pedidos: p.pedidos,
    reprogramadas: p.reprogramadas,
    anuladas: p.anuladas,
    entregadas: p.entregadas,
    atendidas: null,
    sinGestion: null,
    programar: null,
    cancela: null,
    costo: null,
    conCosto: 0,
    llamadas: 0,
  };
}

function agentRow(a: VoiceScoreRow): TeamScoreRow {
  return {
    key: a.agent,
    name: a.name,
    voice: true,
    gestiones: a.llamadas,
    pedidos: a.pedidos,
    reprogramadas: a.guias,
    anuladas: null,
    entregadas: null,
    atendidas: a.atendidas,
    sinGestion: a.sinGestion,
    programar: a.programar,
    cancela: a.cancela,
    costo: a.conCosto ? a.costo : null,
    conCosto: a.conCosto,
    llamadas: a.llamadas,
  };
}

const sum = (rows: TeamScoreRow[], pick: (r: TeamScoreRow) => number | null): number | null => {
  const vals = rows.map(pick).filter((v): v is number => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
};

/**
 * Asesoras primero (por gestiones), después los tres agentes en su orden fijo,
 * siempre, aunque estén en cero. Las filas de agente que hubiera en
 * `shipment_calls` se descartan: el agente se cuenta por sus llamadas.
 */
export function buildTeamScore(
  people: (ReproDayAgentCount & { name: string })[],
  agents: VoiceScoreRow[],
): TeamScore {
  const rows = [
    ...people.filter((p) => !isVoiceAgentKey(p.agent)).map(personRow),
    ...agents.map(agentRow),
  ];
  const total: TeamScoreRow = {
    key: "total",
    name: "Total",
    voice: false,
    gestiones: sum(rows, (r) => r.gestiones) ?? 0,
    pedidos: sum(rows, (r) => r.pedidos) ?? 0,
    reprogramadas: sum(rows, (r) => r.reprogramadas) ?? 0,
    anuladas: sum(rows, (r) => r.anuladas),
    entregadas: sum(rows, (r) => r.entregadas),
    atendidas: sum(rows, (r) => r.atendidas),
    sinGestion: sum(rows, (r) => r.sinGestion),
    programar: sum(rows, (r) => r.programar),
    cancela: sum(rows, (r) => r.cancela),
    costo: sum(rows, (r) => r.costo),
    conCosto: rows.reduce((a, r) => a + r.conCosto, 0),
    llamadas: rows.reduce((a, r) => a + r.llamadas, 0),
  };
  return { rows, total };
}

/** Reprogramadas sobre atendidas; null sin atendidas o en una asesora. */
export function teamConversion(r: Pick<TeamScoreRow, "reprogramadas" | "atendidas">): number | null {
  return r.atendidas ? r.reprogramadas / r.atendidas : null;
}

/**
 * Costo de línea por reprogramada, solo cuando TODAS las llamadas traen costo:
 * con una parte sin costo el cociente saldría más barato de lo que fue.
 */
export function teamCostPerReprogramada(
  r: Pick<TeamScoreRow, "reprogramadas" | "costo" | "conCosto" | "llamadas">,
): number | null {
  if (!r.reprogramadas || r.costo === null || !r.conCosto || r.conCosto < r.llamadas) return null;
  return r.costo / r.reprogramadas;
}
