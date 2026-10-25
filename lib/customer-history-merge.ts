// «Pedidos antes» de Leads con el historial de Shopify (MOM §37.7, 25-10-2026).
//
// Puro: junta los pedidos de Kapta (`orders`) con los del archivo del
// historial (`shopify_history_orders`) del mismo celular y la misma tienda,
// sin contar dos veces el mismo pedido. Nada aquí lee la base.

/** Un pedido de Kapta del celular, como lo lee `getCustomerHistory`. */
export interface LocalPriorRow {
  id: string;
  name: string | null;
  created_at: string | null;
  cancelled_at?: string | null;
  line_items: unknown;
}

/** Un pedido del historial de Shopify (§37), ya sin los anulados. */
export interface HistoryPriorRow {
  order_name: string;
  created_at: string | null;
  total: number | null;
  refunded_amount: number | null;
  line_items: unknown;
}

/** Cuántos pedidos del historial se leen por ficha (el celular con más tiene 73). */
export const HISTORY_PRIOR_LIMIT = 25;

export type PriorEntry<L> =
  | { kind: "local"; row: L; createdAt: string | null }
  | { kind: "history"; row: HistoryPriorRow; createdAt: string | null };

export interface CombinedPrior<L> {
  /** Todos los leídos, del más nuevo al más viejo, sin repetidos ni el propio. */
  entries: PriorEntry<L>[];
  /** Pedidos antes, contando los del historial que no se leyeron por el límite. */
  count: number;
}

const at = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

/**
 * Junta los dos lados.
 *
 * - De Kapta cuentan los no anulados y nunca el pedido propio del lead.
 * - Del historial se descarta el que ya está en Kapta con el mismo número
 *   (`order_name` = `orders.name`), **anulado o no**: si Kapta lo anuló después
 *   de la copia, manda Kapta. También el pedido propio del lead.
 * - `historyTotal` (el conteo exacto de la consulta) suma los del historial que
 *   el límite dejó fuera: son los más viejos, y los de Kapta empiezan en 2024,
 *   así que se dan por no repetidos.
 */
export function combinePriorOrders<L extends LocalPriorRow>(
  local: readonly L[],
  history: readonly HistoryPriorRow[],
  {
    excludeOrderId = null,
    currentOrderName = null,
    historyTotal = null,
  }: { excludeOrderId?: string | null; currentOrderName?: string | null; historyTotal?: number | null } = {},
): CombinedPrior<L> {
  const known = new Set<string>();
  for (const r of local) if (r.name) known.add(r.name);
  if (currentOrderName) known.add(currentOrderName);

  const activeLocal = local.filter((r) => r.id !== excludeOrderId && !r.cancelled_at);
  const seen = new Set<string>();
  const onlyHistory = history.filter((h) => {
    if (!h.order_name || known.has(h.order_name) || seen.has(h.order_name)) return false;
    seen.add(h.order_name);
    return true;
  });

  const entries: PriorEntry<L>[] = [
    ...activeLocal.map((row) => ({ kind: "local" as const, row, createdAt: row.created_at })),
    ...onlyHistory.map((row) => ({ kind: "history" as const, row, createdAt: row.created_at })),
  ].sort((a, b) => at(b.createdAt) - at(a.createdAt));

  const unread = historyTotal != null ? Math.max(0, historyTotal - history.length) : 0;
  return { entries, count: entries.length + unread };
}

/** El primer producto de un pedido: Kapta guarda `title`; el historial, `name`. */
export function firstProductTitle(lineItems: unknown): string | null {
  if (!Array.isArray(lineItems) || !lineItems.length) return null;
  const first = lineItems[0] as { title?: unknown; name?: unknown } | null;
  const title = String(first?.title ?? first?.name ?? "").trim();
  return title || null;
}

/** Neto de un pedido del historial (total − devuelto), a dos decimales. */
export function historyNetAmount(row: Pick<HistoryPriorRow, "total" | "refunded_amount">): number {
  return Math.round(((Number(row.total) || 0) - (Number(row.refunded_amount) || 0)) * 100) / 100;
}
