// Cuántas veces se pregunta a `lead_routing_scope`, y de qué tamaño (0312).
//
// La cola entera de una asesora cuesta ~1 s de base; un lead suelto, decenas
// de milisegundos. El 06-11-2026 la rotación de Yapes pedía la cola entera de
// CADA asesora en línea, en CADA pestaña, cada 15 s, todo a la vez: la base se
// quedó sin CPU. Aquí se pregunta solo por los leads que hacen falta, de a uno
// cuando son pocos, sin repetir dentro de una misma pasada y con un tope de
// llamadas simultáneas.
//
// Un lead suelto (`p_lead`) se bloquea exactamente cuando la cola entera lo
// bloquea (mismas reglas por fila; lo prueba scripts/sql/lead_routing_scope_perf_smoke.sql),
// así que la respuesta es la misma que leer `blockedIds` de la cola entera.
// Puro y sin base, para poder probarlo.

/** Hasta tantos leads se preguntan de a uno; más, una sola lectura de la cola. */
export const SINGLE_LEAD_SCOPE_MAX = 3;
/** Lecturas de alcance simultáneas por pasada. */
export const SCOPE_CONCURRENCY = 3;

export type ScopeReader = (
  actor: string,
  storeIds: string[],
  leadId: string | null,
) => Promise<{ blockedIds: string[] }>;

/** `Promise.all(items.map(fn))`, con como mucho `limit` en vuelo. Conserva el orden. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/**
 * «¿Cuáles de estos leads le quedan bloqueados a esta asesora en estas
 * tiendas?», con memoria por pasada: lo ya preguntado no se vuelve a pedir, y
 * una vez leída la cola entera de alguien, todo sale de ahí.
 */
export function createBlockedLeadChecker(read: ScopeReader, storeIds: string[]) {
  const perLead = new Map<string, Map<string, boolean>>();
  const wholeQueue = new Map<string, Set<string>>();
  return async function blockedFor(actor: string, leadIds: readonly string[]): Promise<Set<string>> {
    const whole = wholeQueue.get(actor);
    if (whole) return new Set(leadIds.filter((id) => whole.has(id)));
    let known = perLead.get(actor);
    if (!known) perLead.set(actor, (known = new Map()));
    const missing = [...new Set(leadIds)].filter((id) => !known!.has(id));
    if (missing.length > SINGLE_LEAD_SCOPE_MAX) {
      const blocked = new Set((await read(actor, storeIds, null)).blockedIds);
      wholeQueue.set(actor, blocked);
      return new Set(leadIds.filter((id) => blocked.has(id)));
    }
    for (const id of missing) {
      known.set(id, (await read(actor, storeIds, id)).blockedIds.includes(id));
    }
    return new Set(leadIds.filter((id) => known!.get(id)));
  };
}
