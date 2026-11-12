/** Five exhaustive work blocks, independent of the current disposition/history. */
export const LEAD_WORK_BLOCKS = [
  { key: "carrito_reciente", label: "Carritos nuevos o reactivados", detail: "Carrito con una señal nueva dentro del plazo de prioridad." },
  { key: "interes_reciente", label: "Interés reciente", detail: "Producto, distrito o atención urgente con actividad nueva." },
  { key: "nuevo_sin_intencion", label: "Nuevos sin intención definida", detail: "Fríos y conversaciones recientes con su primera oportunidad." },
  { key: "pendiente_con_interes", label: "Pendientes y reintentos con interés", detail: "Carrito, producto o distrito que ya esperan continuación." },
  { key: "recuperacion", label: "Recuperación de baja intención", detail: "Fríos y conversaciones antiguos o que necesitan reintento." },
] as const;
export type LeadWorkBlock = typeof LEAD_WORK_BLOCKS[number]["key"];
export const PRINCIPAL_BLOCKS: LeadWorkBlock[] = LEAD_WORK_BLOCKS.slice(0, 4).map(b => b.key);
export interface LeadBlockAssignment { userId: string; blocks: LeadWorkBlock[]; backup: boolean; manualTake?: boolean }
export interface LeadRoutingSettings {
  enabled: boolean;
  freshHours: number;
  revision: number;
  assignments: LeadBlockAssignment[];
}
export const EMPTY_LEAD_ROUTING: LeadRoutingSettings = { enabled: false, freshHours: 24, revision: 0, assignments: [] };
export function isLeadWorkBlock(v: unknown): v is LeadWorkBlock {
  return LEAD_WORK_BLOCKS.some(b => b.key === v);
}
export function parseLeadRouting(input: unknown): Omit<LeadRoutingSettings, "revision"> | null {
  if (!input || typeof input !== "object") return null;
  const x = input as Record<string, unknown>;
  if (typeof x.enabled !== "boolean" || !Number.isInteger(x.freshHours) || Number(x.freshHours) < 1 || Number(x.freshHours) > 168 || !Array.isArray(x.assignments) || x.assignments.length > 200) return null;
  const seen = new Set<string>();
  const assignments: LeadBlockAssignment[] = [];
  for (const raw of x.assignments) {
    if (!raw || typeof raw !== "object") return null;
    const a = raw as Record<string, unknown>;
    if (typeof a.userId !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.userId) || seen.has(a.userId) || typeof a.backup !== "boolean" || !Array.isArray(a.blocks) || !a.blocks.every(isLeadWorkBlock) || new Set(a.blocks).size !== a.blocks.length) return null;
    if (a.manualTake !== undefined && typeof a.manualTake !== "boolean") return null;
    seen.add(a.userId);
    assignments.push({ userId: a.userId, blocks: a.blocks as LeadWorkBlock[], backup: a.backup,
      ...(a.manualTake === undefined ? {} : { manualTake: a.manualTake }) });
  }
  return { enabled: x.enabled, freshHours: Number(x.freshHours), assignments };
}
export function routingLabel(blocks: readonly string[]): string {
  if (blocks.length === 5) return "Todos los bloques";
  if (blocks.length === 1 && blocks[0] === "recuperacion") return "Recuperación";
  if (blocks.length === 4 && PRINCIPAL_BLOCKS.every(b => blocks.includes(b))) return "Principal";
  return blocks.length ? `${blocks.length} bloques asignados` : "Sin bloques asignados";
}
export function routingCoverage(assignments: LeadBlockAssignment[], advisors: { userId: string; stores: string[] }[], stores: string[]): { storeId: string; block: LeadWorkBlock }[] {
  return stores.flatMap(storeId => LEAD_WORK_BLOCKS.filter(block => !assignments.some(a => a.blocks.includes(block.key) && advisors.some(m => m.userId === a.userId && m.stores.includes(storeId)))).map(block => ({ storeId, block: block.key })));
}
