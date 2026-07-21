// Kardex del stock Fénix: cada cambio de inventario es un movimiento con signo.
// El saldo (fenix_stock.quantity) es la suma de los movimientos; esta capa los
// aplica (actualiza el saldo + inserta el historial) y descuenta 1 unidad
// automáticamente cuando una guía Fénix se entrega. Ver 0041_fenix_stock_movements.

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCity } from "./shipments";
import { stockCoversRef, type FenixStockRow, type ProductRef } from "./fenix";

export type StockMovementKind = "entrada" | "salida_entrega" | "salida_merma" | "ajuste";

export const STOCK_MOVEMENT_LABEL: Record<StockMovementKind, string> = {
  entrada: "Entrada",
  salida_entrega: "Salida por entrega",
  salida_merma: "Merma / pérdida",
  ajuste: "Ajuste (conteo Fénix)",
};

export interface StockMovementRow {
  id: string;
  kind: StockMovementKind;
  delta: number;
  balance_after: number;
  note: string | null;
  shipment_id: string | null;
  created_by: string | null;
  created_at: string;
}

/** Delta con signo para un ajuste que lleva el saldo actual al conteo real de
 *  Fénix (targetQty). Pure. */
export function ajusteDelta(currentQty: number, targetQty: number): number {
  return Math.trunc(targetQty) - Math.trunc(currentQty);
}

export interface RecordMovementInput {
  stockId: string;
  orgId: string;
  city: string;
  product: string;
  kind: StockMovementKind;
  delta: number; // con signo
  note?: string | null;
  shipmentId?: string | null;
  createdBy?: string | null;
}

/**
 * Aplica un movimiento: inserta el kardex (primero, para que la idempotencia de
 * la salida por entrega actúe antes de tocar el saldo) y actualiza
 * fenix_stock.quantity al balance resultante. Devuelve el nuevo saldo, o null
 * si no se aplicó (delta 0, renglón inexistente, o salida por entrega ya
 * registrada — choque del índice único). Usa el service role.
 */
export async function recordStockMovement(
  admin: SupabaseClient,
  input: RecordMovementInput,
): Promise<number | null> {
  const delta = Math.trunc(input.delta);
  if (delta === 0) return null;
  const { data: cur } = await admin
    .from("fenix_stock")
    .select("quantity")
    .eq("id", input.stockId)
    .maybeSingle();
  if (!cur) return null;
  const balanceAfter = ((cur as { quantity: number | null }).quantity ?? 0) + delta;
  const { error: insErr } = await admin.from("fenix_stock_movements").insert({
    org_id: input.orgId,
    fenix_stock_id: input.stockId,
    city: input.city,
    product: input.product,
    kind: input.kind,
    delta,
    balance_after: balanceAfter,
    note: input.note ?? null,
    shipment_id: input.shipmentId ?? null,
    created_by: input.createdBy ?? null,
  });
  if (insErr) return null; // incluye 23505 = salida por entrega ya consumida
  await admin.from("fenix_stock").update({ quantity: balanceAfter }).eq("id", input.stockId);
  return balanceAfter;
}

/**
 * Descuenta 1 unidad del renglón de stock correspondiente cuando una guía Fénix
 * se entrega — el mecanismo para que el inventario baje al mismo ritmo que Fénix
 * despacha. Idempotente (una guía consume una vez, vía el índice único por
 * shipment_id). Best-effort: si el producto de la guía no matchea ningún renglón
 * de la provincia, no descuenta (lo cuadra la reconciliación por conteo). Solo
 * actúa sobre guías courier='fenix' ya en estado 'entregado'.
 */
export async function consumeFenixStockOnDelivery(
  admin: SupabaseClient,
  shipmentId: string,
): Promise<void> {
  const { data: ship } = await admin
    .from("shipments")
    .select("id, courier, store_id, city, product, order_id, delivery_status")
    .eq("id", shipmentId)
    .maybeSingle();
  const s = ship as {
    courier: string;
    store_id: string;
    city: string | null;
    product: string | null;
    order_id: string | null;
    delivery_status: string;
  } | null;
  if (!s || s.courier !== "fenix" || s.delivery_status !== "entregado") return;

  const { data: existing } = await admin
    .from("fenix_stock_movements")
    .select("id")
    .eq("shipment_id", shipmentId)
    .eq("kind", "salida_entrega")
    .maybeSingle();
  if (existing) return;

  const { data: store } = await admin.from("stores").select("org_id").eq("id", s.store_id).maybeSingle();
  const orgId = (store as { org_id: string } | null)?.org_id;
  if (!orgId) return;

  const city = normalizeCity(s.city);
  const { data: stock } = await admin
    .from("fenix_stock")
    .select("id, city, product, sku, quantity")
    .eq("org_id", orgId);
  const cityRows = ((stock as (FenixStockRow & { id: string })[]) ?? []).filter(
    (r) => normalizeCity(r.city) === city,
  );
  if (!cityRows.length) return;

  // Producto(s) de la guía: line items del pedido vinculado (mismo catálogo que
  // el stock) o el texto libre como fallback.
  let refs: ProductRef[] = [{ title: s.product, sku: null }];
  if (s.order_id) {
    const { data: order } = await admin.from("orders").select("line_items").eq("id", s.order_id).maybeSingle();
    const li = ((order as { line_items: { title?: string | null; sku?: string | null }[] | null } | null)
      ?.line_items ?? []) as { title?: string | null; sku?: string | null }[];
    if (li.length) refs = li.map((x) => ({ title: x.title ?? null, sku: x.sku ?? null }));
  }
  const match = cityRows.find((r) => refs.some((ref) => stockCoversRef(r, ref)));
  if (!match) return;

  await recordStockMovement(admin, {
    stockId: match.id,
    orgId,
    city: match.city,
    product: match.product,
    kind: "salida_entrega",
    delta: -1,
    shipmentId,
  });
}
