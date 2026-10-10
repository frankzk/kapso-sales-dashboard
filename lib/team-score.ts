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
  /**
   * Las reprogramadas que salieron de una llamada del agente: la base de la
   * conversión y del costo. Null en las asesoras. En el total suma solo las de
   * los agentes: con todas, el 10-10 el total decía 35 % de conversión porque
   * contaba las 56 reprogramadas de una asesora sobre las atendidas del agente.
   */
  reprogramadasLlamada: number | null;
  /**
   * Entrega real de lo reprogramado: de las guías que esta persona sacó a En
   * ruta en el rango, cuántas figuran entregadas hoy. Sale de `shipment_calls`
   * también para los agentes (su salida Swayp deja la fila `en_ruta` en la
   * guía nueva).
   */
  llegaron: number;
  llegaronDe: number;
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

type Person = ReproDayAgentCount & { name: string };

function personRow(p: Person): TeamScoreRow {
  return {
    key: p.agent,
    name: p.name,
    voice: false,
    gestiones: p.gestiones,
    pedidos: p.pedidos,
    reprogramadas: p.reprogramadas,
    reprogramadasLlamada: null,
    llegaron: p.reprogramadasEntregadas,
    llegaronDe: p.reprogramadasGuias,
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

function agentRow(a: VoiceScoreRow, trail: Person | undefined): TeamScoreRow {
  return {
    key: a.agent,
    name: a.name,
    voice: true,
    gestiones: a.llamadas,
    pedidos: a.pedidos,
    reprogramadas: a.guias,
    reprogramadasLlamada: a.guias,
    llegaron: trail?.reprogramadasEntregadas ?? 0,
    llegaronDe: trail?.reprogramadasGuias ?? 0,
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
  people: Person[],
  agents: VoiceScoreRow[],
): TeamScore {
  // Del rastro del agente en `shipment_calls` solo se toma la entrega real.
  const trails = new Map(people.filter((p) => isVoiceAgentKey(p.agent)).map((p) => [p.agent, p]));
  const rows = [
    ...people.filter((p) => !isVoiceAgentKey(p.agent)).map(personRow),
    ...agents.map((a) => agentRow(a, trails.get(a.agent))),
  ];
  const total: TeamScoreRow = {
    key: "total",
    name: "Total",
    voice: false,
    gestiones: sum(rows, (r) => r.gestiones) ?? 0,
    pedidos: sum(rows, (r) => r.pedidos) ?? 0,
    reprogramadas: sum(rows, (r) => r.reprogramadas) ?? 0,
    reprogramadasLlamada: sum(rows, (r) => r.reprogramadasLlamada),
    llegaron: sum(rows, (r) => r.llegaron) ?? 0,
    llegaronDe: sum(rows, (r) => r.llegaronDe) ?? 0,
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

/** Reprogramadas por llamada sobre atendidas; null sin atendidas o en una asesora. */
export function teamConversion(r: Pick<TeamScoreRow, "reprogramadasLlamada" | "atendidas">): number | null {
  return r.atendidas && r.reprogramadasLlamada !== null ? r.reprogramadasLlamada / r.atendidas : null;
}

/**
 * Costo de línea por reprogramada, solo cuando TODAS las llamadas traen costo:
 * con una parte sin costo el cociente saldría más barato de lo que fue.
 */
export function teamCostPerReprogramada(
  r: Pick<TeamScoreRow, "reprogramadasLlamada" | "costo" | "conCosto" | "llamadas">,
): number | null {
  if (!r.reprogramadasLlamada || r.costo === null || !r.conCosto || r.conCosto < r.llamadas) return null;
  return r.costo / r.reprogramadasLlamada;
}
