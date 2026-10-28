// Repro Lima: la cola de trabajo amplia. Son filtros de lectura del Master;
// ver un pendiente no crea un caso de entrega fallida ni autoriza otra salida.
import { MACRO_SUBSTAGES_BY_STAGE, macroStageLabel, macroSubstageLabel, type OrderMacroStage } from "@/lib/order-macro-stage";
import { tandersReleaseCutoff } from "@/lib/gf-tanders-review";
import { REPRO_LISTS, type ReproList } from "@/lib/repro-lima";

export type LimaAttentionFilter = "todos" | ReproList;
type AttentionCase = { orderId: string; list: ReproList };

/** Las tarjetas filtran una sola cola. Los pedidos sin caso siguen en Todos;
 * no se les inventa un resultado de llamada ni se cambia su macroestado. */
export function attentionFilter(value: string | null): LimaAttentionFilter {
  return REPRO_LISTS.includes(value as ReproList) ? value as ReproList : "todos";
}

export function attentionRows(rows: readonly LimaPendingOrder[], cases: readonly AttentionCase[], filter: LimaAttentionFilter): LimaPendingOrder[] {
  if (filter === "todos") return [...rows];
  const byId = new Map(rows.map((row) => [row.orderId, row]));
  // La carga de casos ya aplica sortRepro: al filtrar se conservan el orden de
  // llamada y las prioridades de acuerdos, sin reconstruir otra tabla.
  return cases.flatMap((c) => {
    const row = byId.get(c.orderId);
    if (!row || c.list !== filter) return [];
    byId.delete(c.orderId);
    return [row];
  });
}

export function attentionCounts(rows: readonly LimaPendingOrder[], cases: readonly AttentionCase[]): Record<LimaAttentionFilter, number> {
  const counts = { todos: rows.length, por_decidir: 0, llamar_despues: 0, programados: 0, cerrados: 0 };
  const byId = new Map(cases.map((row) => [row.orderId, row.list]));
  for (const row of rows) {
    const list = byId.get(row.orderId);
    if (list) counts[list] += 1;
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
  if (!row.dispatchedAt && row.attempts === 0 && row.stage !== "en_curso") {
    return { label: "Pendiente de primer despacho", detail: "Confirma los datos y la fecha antes de despachar." };
  }
  return { label: "Seguimiento de entrega", detail: "Revisa el estado del courier y la ubicación del paquete antes de otra salida." };
}
