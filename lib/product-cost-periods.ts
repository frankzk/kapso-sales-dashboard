// Registrar un costo de producto con vigencia (MOM §26). Lo usan «Costos de
// productos» (app/dashboard/costos/actions.ts) y «Pasar a Costos» de Compras
// (MOM §45): una sola forma de abrir un periodo, para que las dos no se
// contradigan.
//
// La regla es la de Costos: nada se edita en su sitio. El periodo abierto del
// mismo SKU y el mismo ámbito (la tienda, o general) se cierra el día anterior
// y se abre otro; si el abierto empezaba ese mismo día o después, se elimina
// (cerrarlo dejaría un intervalo imposible). Quien llama ya comprobó
// `costs.manage` en la organización.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ProductCostPeriod {
  org_id: string;
  store_id: string | null;
  sku: string;
  product_name: string | null;
  supplier: string | null;
  batch: string | null;
  unit_cost: number;
  effective_from: string;
  created_by: string;
  /** Por defecto la de la tabla (PEN). */
  currency?: string;
  note?: string | null;
}

/** El día anterior a `AAAA-MM-DD`. */
export function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * `laterOpen`: qué hacer si el periodo abierto empieza ese mismo día o después.
 * Costos lo reemplaza (`"replace"`, lo de siempre). «Pasar a Costos» lo deja
 * como está y no escribe (`"keep"`, 14-11-2026): ese costo lo cargó una
 * persona después de la llegada y una importación no lo borra.
 */
export async function insertProductCostPeriod(
  admin: SupabaseClient,
  period: ProductCostPeriod,
  opts: { laterOpen?: "replace" | "keep" } = {},
): Promise<{ error?: string; laterFrom?: string }> {
  const previousDay = dayBefore(period.effective_from);

  let query = admin
    .from("product_costs")
    .select("id,effective_from")
    .eq("org_id", period.org_id)
    .eq("sku", period.sku)
    .is("effective_to", null);
  query = period.store_id ? query.eq("store_id", period.store_id) : query.is("store_id", null);
  const { data: current } = await query;

  const rows = (current ?? []) as { id: string; effective_from: string }[];
  const later = rows.find((row) => row.effective_from > previousDay);
  if (later && opts.laterOpen === "keep") {
    return { error: `Costos ya tiene un costo desde ${later.effective_from}.`, laterFrom: later.effective_from };
  }
  for (const row of rows) {
    if (row.effective_from > previousDay) {
      await admin.from("product_costs").delete().eq("id", row.id);
    } else {
      await admin.from("product_costs").update({ effective_to: previousDay }).eq("id", row.id);
    }
  }

  const row: Record<string, unknown> = {
    org_id: period.org_id,
    store_id: period.store_id,
    sku: period.sku,
    product_name: period.product_name,
    supplier: period.supplier,
    batch: period.batch,
    unit_cost: period.unit_cost,
    effective_from: period.effective_from,
    created_by: period.created_by,
  };
  if (period.currency) row.currency = period.currency;
  if (period.note) row.note = period.note;
  const { error } = await admin.from("product_costs").insert(row);
  return error ? { error: error.message } : {};
}
