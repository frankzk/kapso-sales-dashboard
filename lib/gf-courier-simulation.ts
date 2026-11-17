// Simulación de GF Courier (MOM §29.17, owner 16-11-2026): «qué impide crear la guía». Se arma el cuerpo de cada
// pedido como lo arma Kapta para crear la guía y se manda a POST /v1/orders/validate, que aplica las mismas reglas que
// crear sin crear nada. Aquí, lo puro: el external_id de simulación, la fecha, el valor enviado en el campo que GF
// señala y el resumen. Nada de esto se guarda: el resumen vive en la pantalla del owner.
import type { GfOrderInput } from "@/lib/gf-courier";

/** Pedidos de los últimos N días. */
export const GF_SIM_DAYS = 90;
/** Una llamada a GF cada 250 ms: 4 por segundo (GF permite 300 por minuto por clave). */
export const GF_SIM_INTERVAL_MS = 250;
/** Pedidos por pasada del servidor (~30 s a 4 por segundo). */
export const GF_SIM_CHUNK = 120;
/** Ejemplos por grupo de error. */
export const GF_SIM_EXAMPLES = 3;
/** Sufijo del external_id cuando el pedido ya tiene guía en GF: así GF no responde DUPLICATE_ORDER. */
export const GF_SIM_SUFFIX = "-SIM";
/** Pasarelas que cuentan como contraentrega para la simulación: COD y los pedidos manuales del equipo. */
export const GF_SIM_GATEWAYS = ["cod", "manual"] as const;

/** El external_id de simulación: con guía en GF lleva «-SIM» al final, sin pasar los 100 caracteres de GF. */
export function simExternalId(externalId: string, hasGfGuide: boolean): string {
  return hasGfGuide ? `${externalId.slice(0, 100 - GF_SIM_SUFFIX.length)}${GF_SIM_SUFFIX}` : externalId;
}

/** Sin `scheduled_date` si es un día pasado (GF elige el próximo día de reparto). `today` es YYYY-MM-DD de Lima. */
export function withoutPastSchedule(input: GfOrderInput, today: string): GfOrderInput {
  if (!input.scheduled_date || input.scheduled_date >= today) return input;
  const { scheduled_date: _past, ...rest } = input;
  return rest;
}

/**
 * El valor enviado en el campo que GF señala («destination.district», «items[0].sku», «recipient.phone»). Un objeto o
 * una lista se devuelve en JSON corto. Sin campo, o si el campo no existe en el cuerpo, null.
 */
export function sentValue(input: GfOrderInput, field: string | null | undefined): string | null {
  if (!field) return null;
  const path = field.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = input;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (cur === undefined) return null;
  if (cur === null) return "null";
  const text = typeof cur === "object" ? JSON.stringify(cur) : String(cur);
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

export type GfSimOutcome =
  | { kind: "valid"; order: string; store: string; takenFromAddress: boolean; hadGuide: boolean }
  | { kind: "error"; order: string; store: string; code: string; field: string | null; message: string; sent: string | null; hadGuide: boolean };

/** Lo que Kapta no llega a armar (falta el nombre, un SKU…): se cuenta como error con este código. */
export const GF_SIM_KAPTA_CODE = "KAPTA_NO_ARMA_EL_CUERPO";

export interface GfSimGroup {
  code: string;
  field: string | null;
  count: number;
  examples: { order: string; store: string; message: string; sent: string | null }[];
}
export interface GfSimSummary {
  total: number;
  valid: number;
  errors: number;
  takenFromAddress: number;
  withGuide: number;
  byStore: { store: string; total: number; valid: number; errors: number }[];
  groups: GfSimGroup[];
}

/** Totales, por tienda, y errores agrupados por código y campo (los más frecuentes primero) con 3 ejemplos. */
export function summarizeGfSimulation(outcomes: readonly GfSimOutcome[]): GfSimSummary {
  const groups = new Map<string, GfSimGroup>();
  const stores = new Map<string, { store: string; total: number; valid: number; errors: number }>();
  let valid = 0, taken = 0, withGuide = 0;
  for (const o of outcomes) {
    const s = stores.get(o.store) ?? { store: o.store, total: 0, valid: 0, errors: 0 };
    s.total++;
    if (o.hadGuide) withGuide++;
    if (o.kind === "valid") {
      valid++; s.valid++;
      if (o.takenFromAddress) taken++;
    } else {
      s.errors++;
      const key = `${o.code}\u0000${o.field ?? ""}`;
      const g = groups.get(key) ?? { code: o.code, field: o.field, count: 0, examples: [] };
      g.count++;
      if (g.examples.length < GF_SIM_EXAMPLES) g.examples.push({ order: o.order, store: o.store, message: o.message, sent: o.sent });
      groups.set(key, g);
    }
    stores.set(o.store, s);
  }
  return {
    total: outcomes.length,
    valid,
    errors: outcomes.length - valid,
    takenFromAddress: taken,
    withGuide,
    byStore: [...stores.values()].sort((a, b) => a.store.localeCompare(b.store)),
    groups: [...groups.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code) || (a.field ?? "").localeCompare(b.field ?? "")),
  };
}

/** El resumen en texto plano, para copiarlo. */
export function gfSimulationText(s: GfSimSummary): string {
  const lines = [
    `Simulación GF Courier · ${s.total} pedidos revisados`,
    `Válidos: ${s.valid} · Con error: ${s.errors}`,
    `Válidos con el distrito tomado de la dirección: ${s.takenFromAddress}`,
    `Con guía GF previa (enviados con ${GF_SIM_SUFFIX}): ${s.withGuide}`,
    ...s.byStore.map((b) => `· ${b.store}: ${b.total} revisados, ${b.valid} válidos, ${b.errors} con error`),
    "",
    "Errores por código y campo:",
  ];
  for (const g of s.groups) {
    lines.push(`${g.code} · ${g.field ?? "(sin campo)"} · ${g.count}`);
    for (const e of g.examples) lines.push(`   ${e.order}: ${e.message}${e.sent != null ? ` · enviado: ${e.sent}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Un turno cada `intervalMs`: quien llama espera su turno antes de la llamada a GF. Con varias llamadas en paralelo,
 * igual salen como mucho 1000/intervalMs por segundo.
 */
export function createPacer(
  intervalMs: number,
  now: () => number = () => Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): () => Promise<void> {
  let next = 0;
  return async () => {
    const t = now();
    const at = Math.max(t, next);
    next = at + intervalMs;
    if (at > t) await sleep(at - t);
  };
}
