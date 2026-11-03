// Los carritos anteriores de una clienta (MOM §11, 25-10-2026): ¿suele terminar
// la compra o solo deja carritos? Las asesoras lo miraban en Shopify →
// Pedidos → Borradores, cliente por cliente: cada envío del formulario contra
// entrega deja un borrador, «Completado» si terminó en pedido y «Abierto» si lo
// abandonó. Shopify cierra el 28-10-2026; Kapta ya tiene los dos lados:
//
//   · `draft_orders`, el espejo vivo (y desde WooCommerce, con su plataforma);
//   · `shopify_history_carts`, el archivo completo (MOM §37.6): 106 mil
//     borradores de Aurela desde 2021 y 105 mil de Kenku desde 2023, más los
//     checkouts abandonados de la web.
//
// Un mismo borrador puede estar en los dos: manda el espejo, que es el más
// reciente. Puro.

/** Un carrito de la clienta, venga del espejo o del archivo. */
export interface CustomerCart {
  /** «borrador:<id>» o «carrito:<id>»: la misma clave en las dos fuentes. */
  key: string;
  /** «#D105674»; un checkout abandonado no tiene nombre. */
  name: string | null;
  kind: "borrador" | "carrito";
  createdAt: string | null;
  /** Terminó en pedido. */
  completed: boolean;
  /** El pedido en que terminó, si se sabe («#KP143817»). */
  orderName: string | null;
  total: number | null;
  /** «Nails Repairing – Sérum… ×1», en una línea. */
  products: string | null;
}

export interface CustomerCartsSummary {
  total: number;
  completed: number;
  abandoned: number;
}

export interface CustomerCarts {
  summary: CustomerCartsSummary;
  /** Los más recientes primero. */
  carts: CustomerCart[];
}

/** Una fila de `draft_orders` (el espejo). */
export interface MirrorDraftRow {
  shopify_draft_order_id: string | null;
  draft_order_gid: string | null;
  name: string | null;
  status: string | null;
  created_at: string | null;
  total_amount: number | string | null;
  line_items: unknown;
  /** El nombre del pedido en que terminó, ya resuelto desde `order_gid`. */
  order_name?: string | null;
}

/** Una fila de `shopify_history_carts` (el archivo). */
export interface ArchiveCartRow {
  cart_key: string;
  kind: string | null;
  name: string | null;
  status: string | null;
  created_at: string | null;
  total: number | string | null;
  order_name: string | null;
  line_items: unknown;
}

/**
 * Las formas en que puede estar guardado el celular de la clienta. El espejo lo
 * guarda normalizado («51958769605»); el archivo, como venía en Shopify sin lo
 * que no son dígitos («958769605», «051958769605»).
 */
export function cartPhoneVariants(phone: string | null | undefined): string[] {
  const digits = (phone ?? "").replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("51") ? digits.slice(2) : digits.length === 9 ? digits : null;
  if (!local) return digits.length >= 8 ? [digits] : [];
  return [`51${local}`, local, `051${local}`, `0051${local}`];
}

function amount(value: number | string | null | undefined): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Los productos en una línea: el título (espejo) o el nombre (archivo) con su cantidad. */
export function cartProductsLabel(lineItems: unknown): string | null {
  if (!Array.isArray(lineItems)) return null;
  const parts: string[] = [];
  for (const raw of lineItems) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title : typeof item.name === "string" ? item.name : null;
    if (!title?.trim()) continue;
    const q = Number(item.quantity);
    parts.push(Number.isFinite(q) && q > 1 ? `${title.trim()} ×${q}` : title.trim());
  }
  return parts.length ? parts.join(", ") : null;
}

/** El id de Shopify de un gid o de una clave («gid://shopify/DraftOrder/123», «borrador:123»). */
function numericId(value: string | null | undefined): string | null {
  const m = (value ?? "").match(/(\d+)\s*$/);
  return m ? m[1]! : null;
}

/**
 * Los carritos de la clienta, sin repetir y sin el del propio lead
 * (`excludeDraftGid`): ese ya está en «Lo que pidió», y contarlo diría que
 * abandonó uno que todavía se está trabajando.
 */
export function mergeCustomerCarts(
  mirror: readonly MirrorDraftRow[],
  archive: readonly ArchiveCartRow[],
  excludeDraftGid?: string | null,
): CustomerCart[] {
  const exclude = numericId(excludeDraftGid);
  const byKey = new Map<string, CustomerCart>();
  for (const row of archive) {
    const kind = row.kind === "carrito" ? "carrito" : "borrador";
    const id = numericId(row.cart_key);
    const key = id ? `${kind}:${id}` : row.cart_key;
    byKey.set(key, {
      key,
      name: row.name,
      kind,
      createdAt: row.created_at,
      completed: row.status === "completed",
      orderName: row.order_name,
      total: amount(row.total),
      products: cartProductsLabel(row.line_items),
    });
  }
  // El espejo manda: es la misma fila, más reciente.
  for (const row of mirror) {
    const id = row.shopify_draft_order_id ?? numericId(row.draft_order_gid);
    if (!id) continue;
    const key = `borrador:${id}`;
    const before = byKey.get(key);
    byKey.set(key, {
      key,
      name: row.name ?? before?.name ?? null,
      kind: "borrador",
      createdAt: row.created_at ?? before?.createdAt ?? null,
      completed: row.status === "completed",
      orderName: row.order_name ?? before?.orderName ?? null,
      total: amount(row.total_amount) ?? before?.total ?? null,
      products: cartProductsLabel(row.line_items) ?? before?.products ?? null,
    });
  }
  return [...byKey.values()]
    .filter((cart) => !(exclude && cart.kind === "borrador" && numericId(cart.key) === exclude))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export function summarizeCarts(carts: readonly CustomerCart[]): CustomerCartsSummary {
  const completed = carts.filter((cart) => cart.completed).length;
  return { total: carts.length, completed, abandoned: carts.length - completed };
}

/**
 * Lo que la asesora lee primero, en hechos y no en etiquetas: cuántos de sus
 * carritos terminaron en pedido. Null sin carritos anteriores.
 */
export function cartsVerdict(summary: CustomerCartsSummary): string | null {
  if (!summary.total) return null;
  if (!summary.completed) return summary.total === 1 ? "No terminó en pedido." : "Ninguno terminó en pedido.";
  if (!summary.abandoned) return summary.total === 1 ? "Terminó en pedido." : "Todos terminaron en pedido.";
  return `${summary.completed} de ${summary.total} terminaron en pedido.`;
}

/**
 * El tono del veredicto, el mismo en la ficha y en la tarjeta del siguiente:
 * ámbar si nunca terminó un carrito (es lo que cambia cómo se llama), verde si
 * siempre terminó y tinta en los mixtos.
 */
export function cartsTone(summary: CustomerCartsSummary): "warn" | "ok" | "neutral" {
  if (summary.total && !summary.completed) return "warn";
  if (summary.total && !summary.abandoned) return "ok";
  return "neutral";
}
