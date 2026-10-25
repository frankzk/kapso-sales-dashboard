// Admin falso para el auto-vínculo de la cola «Revisión»
// (lib/shipment-auto-match.ts): la cola, los pedidos de Kapta (`orders`, de
// Shopify y de WooCommerce) y lo que se escribe. Lo usan
// test/shipment-auto-match-local.test.ts y test/shipment-auto-match-retry.test.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreSummary } from "@/lib/types";

export type Row = Record<string, unknown>;

export interface Update {
  table: string;
  values: Row;
  ids: string[];
}

/** Una consulta a `orders`: sus filtros, en el orden en que se hizo. */
export interface OrdersQuery {
  store_id?: string;
  platform?: string;
  shopify_order_id?: string;
  ilike?: string;
  or?: string;
}

export interface LocalOrder {
  id: string;
  store_id: string;
  platform: "shopify" | "woocommerce";
  shopify_order_id: string;
  name: string;
  customer_phone: string | null;
}

export const STORES = [
  { id: "kenku", name: "Kenku Peru" },
  { id: "aurela", name: "Aurela" },
] as unknown as StoreSummary[];

export const PHONE = "51930295803";

/**
 * - `rows`: los envíos sin revisar (la pasada de búsqueda).
 * - `pend`: los envíos con una sugerencia guardada (la primera pasada).
 * - `orders`: los pedidos de Kapta. La búsqueda resuelve `ilike` sin comodines
 *   como «igual, sin mayúsculas» y `%x%` como «contiene».
 * - `ordersErrorStores`: tiendas cuya búsqueda en `orders` falla (`"*"`: todas).
 * - `lookupError`: falla la lectura de un pedido por su gid guardado.
 * - `linkUpdateError`: falla la escritura del vínculo en `shipments`.
 */
export function fakeAdmin(opts: {
  rows?: Row[];
  pend?: Row[];
  orders?: LocalOrder[];
  ordersErrorStores?: string[];
  lookupError?: boolean;
  linkUpdateError?: boolean;
}) {
  const updates: Update[] = [];
  const queries: OrdersQuery[] = [];
  const like = (value: string, pattern: string) => {
    const p = pattern.toLowerCase();
    const v = value.toLowerCase();
    if (p.startsWith("%") && p.endsWith("%")) return v.includes(p.slice(1, -1));
    return v === p;
  };
  const storeFails = (storeId: string | undefined) =>
    (opts.ordersErrorStores ?? []).some((s) => s === "*" || s === storeId);
  const from = (table: string) => {
    const ctx: { op: "select" | "update"; cols: string; values: Row; ids: string[]; f: OrdersQuery } = {
      op: "select",
      cols: "",
      values: {},
      ids: [],
      f: {},
    };
    const q: Record<string, unknown> = {
      select(cols: string) {
        ctx.cols = cols;
        return q;
      },
      update(values: Row) {
        ctx.op = "update";
        ctx.values = values;
        return q;
      },
      upsert() {
        throw new Error("el auto-vínculo no escribe pedidos");
      },
      in(col: string, vals: string[]) {
        if (ctx.op === "update" && col === "id") ctx.ids = vals;
        return q;
      },
      eq(col: string, val: string) {
        if (ctx.op === "update" && col === "id") ctx.ids = [val];
        if (col === "store_id") ctx.f.store_id = val;
        if (col === "platform") ctx.f.platform = val;
        if (col === "shopify_order_id") ctx.f.shopify_order_id = val;
        return q;
      },
      ilike(_col: string, pattern: string) {
        ctx.f.ilike = pattern;
        return q;
      },
      or(filter: string) {
        ctx.f.or = filter;
        return q;
      },
      not: () => q,
      is: () => q,
      order: () => q,
      limit: () => q,
      // Un pedido por su gid guardado (`store_id` + `shopify_order_id`).
      maybeSingle: async () => {
        if (table !== "orders") return { data: null, error: null };
        queries.push({ ...ctx.f });
        if (opts.lookupError) return { data: null, error: { message: "base caída" } };
        const hit = (opts.orders ?? []).find(
          (o) => o.store_id === ctx.f.store_id && o.shopify_order_id === ctx.f.shopify_order_id,
        );
        return { data: hit ? { id: hit.id, name: hit.name } : null, error: null };
      },
      then(ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) {
        let result: unknown;
        if (ctx.op === "update") {
          updates.push({ table, values: ctx.values, ids: ctx.ids });
          result = {
            error: table === "shipments" && opts.linkUpdateError && "order_id" in ctx.values ? { message: "x" } : null,
          };
        } else if (table === "shipments" && ctx.cols.startsWith("id,suggested_order_gid")) {
          result = { data: opts.pend ?? [], error: null };
        } else if (table === "shipments") {
          result = { data: opts.rows ?? [], error: null };
        } else if (table === "orders") {
          queries.push({ ...ctx.f });
          if (storeFails(ctx.f.store_id)) {
            result = { data: null, error: { message: "base caída" } };
          } else {
            const patterns = ctx.f.ilike
              ? [ctx.f.ilike]
              : (ctx.f.or ?? "").split(",").map((c) => c.replace(/^name\.ilike\./, ""));
            const data = (opts.orders ?? [])
              .filter((o) => o.store_id === ctx.f.store_id)
              .filter((o) => !ctx.f.platform || o.platform === ctx.f.platform)
              .filter((o) => patterns.some((p) => like(o.name, p)))
              .map(({ id, shopify_order_id, name, customer_phone }) => ({ id, shopify_order_id, name, customer_phone }));
            result = { data, error: null };
          }
        } else {
          result = { data: [], error: null };
        }
        return Promise.resolve(result).then(ok, fail);
      },
    };
    return q;
  };
  return { admin: { from } as unknown as SupabaseClient, updates, queries };
}

/** Lo que se marcó como revisado, por id de envío. */
export function checked(updates: Update[]): string[] {
  return updates.filter((u) => u.table === "shipments" && "suggestion_checked_at" in u.values).flatMap((u) => u.ids);
}

/** Los vínculos escritos en `shipments`. */
export function links(updates: Update[]): Update[] {
  return updates.filter((u) => u.table === "shipments" && "order_id" in u.values);
}

/** Las sugerencias que se guardaron (un gid no nulo). */
export function savedSuggestions(updates: Update[]): Update[] {
  return updates.filter((u) => u.table === "shipments" && u.values.suggested_order_gid);
}
