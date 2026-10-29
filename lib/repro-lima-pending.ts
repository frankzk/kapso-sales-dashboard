// Repro Lima: la cola de trabajo amplia. Son filtros de lectura del Master;
// ver un pendiente no crea un caso de entrega fallida ni autoriza otra salida.
import { MACRO_SUBSTAGES_BY_STAGE, macroStageLabel, macroSubstageLabel, type OrderMacroStage } from "@/lib/order-macro-stage";
import { tandersReleaseCutoff } from "@/lib/gf-tanders-review";
import type { ReproList } from "@/lib/repro-lima";
import { QUEUE_SEGMENTS, QUEUE_SEGMENT_LABEL, queueSegment, type QueueSegment } from "@/lib/dispatch-day";

export type LimaAttentionFilter = "todos" | "reprogramados" | QueueSegment | "llamar_despues" | "cerrados";
type AttentionCase = {
  orderId: string; list: ReproList;
  agreement?: { agreedOn: string } | null;
  program?: { scheduledFor: string } | null;
};

export const LIMA_QUEUE_CARDS: readonly { key: Exclude<LimaAttentionFilter, "todos" | "llamar_despues" | "cerrados">; label: string; hint: string; empty: string }[] = [
  { key: "reprogramados", label: "Reprogramados", hint: "Con una nueva fecha acordada y vigente en Repro Lima. También aparecen en Hoy, Mañana o Después según esa fecha.", empty: "No hay pedidos con una nueva fecha acordada con estos filtros." },
  { key: "programados_hoy", label: "Programados para hoy", hint: QUEUE_SEGMENT_LABEL.programados_hoy.hint, empty: "No hay pedidos programados para hoy con estos filtros." },
  { key: "programados_manana", label: "Programados para mañana", hint: QUEUE_SEGMENT_LABEL.programados_manana.hint, empty: "No hay pedidos programados para mañana con estos filtros." },
  { key: "nunca_salieron", label: "Nunca salieron", hint: QUEUE_SEGMENT_LABEL.nunca_salieron.hint, empty: "No hay pedidos recientes sin salida registrada con estos filtros." },
  { key: "ya_salieron", label: "Ya salieron", hint: "Con al menos una salida a reparto registrada y sin una nueva fecha pendiente. La situación indica si sigue con el courier o ya retornó.", empty: "No hay pedidos con una salida previa y sin nueva fecha con estos filtros." },
  { key: "mas_de_30", label: "Más de 30 días", hint: QUEUE_SEGMENT_LABEL.mas_de_30.hint, empty: "No hay pedidos de más de 30 días sin salida registrada con estos filtros." },
  { key: "programados_despues", label: "Programados para después", hint: QUEUE_SEGMENT_LABEL.programados_despues.hint, empty: "No hay pedidos programados para después de mañana con estos filtros." },
];

export const LIMA_FOLLOWUP_FILTERS = [
  { key: "llamar_despues" as const, label: "Llamar después", hint: "El cliente pidió que lo llamen a otra hora. Por la hora de la llamada.", empty: "Nadie pidió que lo llamen después." },
  { key: "cerrados" as const, label: "Cerrados · esperan anulación", hint: "«Desarmar y cerrar» del intento vigente: el pedido sigue en la etapa hasta que la tienda anule la venta.", empty: "Ningún caso cerrado espera la anulación." },
];

/** Las tarjetas filtran una sola cola. Los pedidos sin caso siguen en Todos;
 * no se les inventa un resultado de llamada ni se cambia su macroestado. */
export function attentionFilter(value: string | null): LimaAttentionFilter {
  if (value === "programados") return "reprogramados";
  return [...LIMA_QUEUE_CARDS, ...LIMA_FOLLOWUP_FILTERS].some((c) => c.key === value) ? value as LimaAttentionFilter : "todos";
}

/** La fecha acordada vigente manda sobre un programa anterior que aún no se
 * actualizó. Sin acuerdo vigente, se usa solo una programación persistida. */
export function limaScheduledFor(row: LimaPendingOrder, c?: AttentionCase): string | null {
  return (c?.list === "programados" ? c.agreement?.agreedOn : null) ?? row.programmedFor ?? c?.program?.scheduledFor ?? null;
}

export function limaQueueSegment(row: LimaPendingOrder, today: string, c?: AttentionCase): QueueSegment {
  return queueSegment({ programmedFor: limaScheduledFor(row, c), hasPriorDispatch: row.hasPriorDispatch, createdAt: row.createdAt }, today);
}

export function attentionRows(rows: readonly LimaPendingOrder[], cases: readonly AttentionCase[], filter: LimaAttentionFilter, today: string): LimaPendingOrder[] {
  const caseById = new Map(cases.map((c) => [c.orderId, c]));
  if (filter === "todos" || QUEUE_SEGMENTS.includes(filter as QueueSegment)) {
    // Una clasificación por pedido: el comparador no reconstruye fechas de
    // Lima miles de veces cuando la cola amplia tiene más de 2000 filas.
    return rows.map((row) => {
      const c = caseById.get(row.orderId);
      const segment = limaQueueSegment(row, today, c);
      return { row, segment, rank: QUEUE_SEGMENTS.indexOf(segment), day: limaScheduledFor(row, c) ?? "", created: Date.parse(row.createdAt ?? "") || 0 };
    }).filter((r) => filter === "todos" || r.segment === filter)
      .sort((a, b) => a.rank - b.rank || a.day.localeCompare(b.day) || b.created - a.created)
      .map((r) => r.row);
  }
  const byId = new Map(rows.map((row) => [row.orderId, row]));
  // La carga de casos ya aplica sortRepro: al filtrar se conservan el orden de
  // llamada y las prioridades de acuerdos, sin reconstruir otra tabla.
  return cases.flatMap((c) => {
    const row = byId.get(c.orderId);
    const matches = filter === "reprogramados" ? c.list === "programados" && Boolean(c.agreement?.agreedOn) : c.list === filter;
    if (!row || !matches) return [];
    byId.delete(c.orderId);
    return [row];
  });
}

export function attentionCounts(rows: readonly LimaPendingOrder[], cases: readonly AttentionCase[], today: string): Record<LimaAttentionFilter, number> {
  const counts: Record<LimaAttentionFilter, number> = { todos: rows.length, reprogramados: 0, programados_hoy: 0, programados_manana: 0, nunca_salieron: 0, ya_salieron: 0, mas_de_30: 0, programados_despues: 0, llamar_despues: 0, cerrados: 0 };
  const byId = new Map(cases.map((row) => [row.orderId, row]));
  for (const row of rows) {
    const c = byId.get(row.orderId);
    counts[limaQueueSegment(row, today, c)] += 1;
    if (c?.list === "programados" && c.agreement?.agreedOn) counts.reprogramados += 1;
    if (c?.list === "llamar_despues" || c?.list === "cerrados") counts[c.list] += 1;
  }
  return counts;
}

export const LIMA_PENDING_STAGES = ["por_confirmar", "preparacion", "por_despachar", "en_curso"] as const;
export type LimaPendingStage = typeof LIMA_PENDING_STAGES[number];
export interface LimaPendingOrder {
  orderId: string;
  storeId: string;
  storeName: string;
  orderName: string;
  customerName: string;
  customerPhone: string | null;
  district: string | null;
  orderTotal: number;
  createdAt: string | null;
  macroSince: string | null;
  stage: LimaPendingStage;
  substage: string | null;
  courier: string | null;
  dispatchedAt: string | null;
  attempts: number;
  hasPriorDispatch: boolean;
  lastDepartureAt: string | null;
  programmedFor: string | null;
}
export interface LimaPendingFilter {
  stage: LimaPendingStage;
  label: string;
  count: number;
  children: { key: string; label: string; count: number }[];
}

export function pendingKey(row: Pick<LimaPendingOrder, "stage" | "substage">): string {
  return `${row.stage}:${row.substage ?? ""}`;
}

export function isLimaPendingStage(stage: unknown): stage is LimaPendingStage {
  return LIMA_PENDING_STAGES.includes(stage as LimaPendingStage);
}

export function pendingFilters(rows: readonly LimaPendingOrder[]): LimaPendingFilter[] {
  return LIMA_PENDING_STAGES.flatMap((stage) => {
    const matching = rows.filter((r) => r.stage === stage);
    if (!matching.length) return [];
    const counts = new Map<string | null, number>();
    for (const row of matching) counts.set(row.substage, (counts.get(row.substage) ?? 0) + 1);
    const canon: readonly string[] = MACRO_SUBSTAGES_BY_STAGE[stage as OrderMacroStage];
    const subs = [...counts.keys()].sort((a, b) => {
      const ai = a == null ? Infinity : canon.indexOf(a);
      const bi = b == null ? Infinity : canon.indexOf(b);
      return (ai < 0 ? canon.length : ai) - (bi < 0 ? canon.length : bi) || (a ?? "").localeCompare(b ?? "", "es");
    });
    return [{ stage, label: macroStageLabel(stage), count: matching.length, children: subs.map((substage) => ({
      key: pendingKey({ stage, substage }), label: substage ? macroSubstageLabel(substage) : "Sin subetapa", count: counts.get(substage)!,
    })) }];
  });
}

// Exclusiones, no selecciones: todo se muestra al entrar, incluso una subetapa
// nueva. Desmarcar todas es válido y no debe restablecer la lista por sorpresa.
export function togglePendingKeys(hidden: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const next = new Set(hidden);
  const show = keys.some((key) => hidden.has(key));
  for (const key of keys) { if (show) next.delete(key); else next.add(key); }
  return next;
}

export function pendingMatches(row: LimaPendingOrder, query: string): boolean {
  const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f#]/g, "").toLowerCase().trim();
  const q = norm(query);
  if (!q || norm(row.orderName).includes(q) || norm(row.customerName).includes(q)) return true;
  const digits = query.replace(/\D/g, "");
  return digits.length >= 3 && (row.customerPhone ?? "").replace(/\D/g, "").includes(digits);
}

export function pendingGroup(row: LimaPendingOrder, today: string): { label: string; detail: string } {
  if (row.stage === "en_curso" && row.substage === "por_reprogramar_lima") {
    return { label: "Entrega fallida", detail: "Confirma con el cliente una nueva fecha y courier." };
  }
  const old = row.createdAt && Number.isFinite(Date.parse(row.createdAt)) &&
    Date.parse(`${today}T00:00:00-05:00`) - Date.parse(row.createdAt) > 30 * 86_400_000;
  if (old) return { label: "Antiguo por revisar", detail: "Más de 30 días: confirma si la venta sigue vigente y ubica el paquete." };
  const tandersDue = row.courier === "tanders" && row.stage === "en_curso" && row.substage === "en_transito" &&
    row.dispatchedAt && Number.isFinite(Date.parse(row.dispatchedAt)) &&
    Date.parse(row.dispatchedAt) < Date.parse(`${tandersReleaseCutoff(today)}T00:00:00-05:00`);
  if (tandersDue) return { label: "Antiguo por revisar", detail: "Tanders: despacho anterior sin cierre. Confirma su reporte y dónde está el paquete." };
  if (!row.hasPriorDispatch && row.stage !== "en_curso") {
    return { label: "Pendiente de primer despacho", detail: "Confirma los datos y la fecha antes de despachar." };
  }
  return { label: "Seguimiento de entrega", detail: "Revisa el estado del courier y la ubicación del paquete antes de otra salida." };
}
