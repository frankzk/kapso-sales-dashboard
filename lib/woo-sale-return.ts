import { commercialSaleCancelBlocks, type LegacySaleEvent } from "@/lib/legacy-sale-cancel";
import type { WooCancelFacts, WooCancelShipment } from "@/lib/woo-cancel";

export const WOO_SALE_ENDED = "woo_sale_ended_pending_return";
export const WOO_SALE_RETURN_SYNCED = "woo_sale_return_synced";

export function shipmentHasLeft(s: WooCancelShipment): boolean {
  return Boolean(s.dispatched_at || s.custody_transferred_at || ["courier", "retorno", "devuelto"].includes(s.custody_state ?? ""));
}
export function wooSaleWasDispatched(f: Pick<WooCancelFacts, "shipments" | "events">): boolean {
  return f.shipments.some(shipmentHasLeft) || Boolean(f.events?.some((e) => e.kind === "returned_to_office"
    && e.source === "dispatch" && e.actor && f.shipments.some((s) => s.id === e.shipment_id)));
}

const LIVE_STATUSES = new Set(["pendiente", "por_preparar", "en_ruta"]);
const isGfCourier = (courier: string | null | undefined) => ["gf_courier", "gf courier"].includes((courier ?? "").trim().toLowerCase());

/**
 * Las salidas vivas que nunca salieron del almacén (ni volvieron a él después
 * de salir). Terminar la venta no las toca por sí sola: el courier seguiría
 * esperando el pedido (17-11-2026, #AUR900668: la guía de GF Courier siguió
 * «Lista para recojo» en GF después de terminar la venta).
 */
export function wooSaleUnshippedLive<T extends WooCancelShipment>(f: { shipments: readonly T[]; events?: WooCancelFacts["events"] }): T[] {
  const backAtOffice = new Set((f.events ?? []).filter((e) => e.kind === "returned_to_office" && e.source === "dispatch" && e.actor)
    .map((e) => e.shipment_id));
  return f.shipments.filter((s) => LIVE_STATUSES.has(s.delivery_status) && s.custody_state !== "devuelto"
    && !shipmentHasLeft(s) && !(s.id && backAtOffice.has(s.id)));
}

/** De esas, las guías de GF Courier que Kapta anula en GF antes de terminar la venta. */
export function wooSaleGfToCancel<T extends WooCancelShipment>(f: { shipments: readonly T[]; events?: WooCancelFacts["events"] }): T[] {
  return wooSaleUnshippedLive(f).filter((s) => isGfCourier(s.courier) && Boolean(s.guide_code));
}

export function wooSaleEndBlocks(f: WooCancelFacts): string[] {
  if (f.platform !== "woocommerce") return ["Esta opción es solo para WooCommerce."];
  // Las demás salidas vivas que no salieron se anulan con su botón (avisa a su courier).
  const gf = new Set(wooSaleGfToCancel(f));
  const others = wooSaleUnshippedLive(f).filter((s) => !gf.has(s));
  return [...commercialSaleCancelBlocks(f), ...(!wooSaleWasDispatched(f)
    ? ["La caja todavía no salió. Usa «Anular pedido» después de retirar sus salidas activas."] : []),
    ...others.map((s) => `La salida ${s.guide_code ?? "nueva"} de ${s.courier ?? "courier por definir"} sigue viva y no salió: anúlala primero con su propio botón (avisa al courier) y después termina la venta.`)];
}
export interface ReturnProof extends LegacySaleEvent { shipment_id?: string | null; actor?: string | null }

/** Si el pedido cambió de productos/cantidades, el retorno exige revisión humana. */
export function stockItemsFingerprint(items: unknown): string | null {
  if (!Array.isArray(items) || !items.length) return null;
  const keys: string[]=[];
  for (const item of items) {
    if (!item || typeof item!=="object" || !Number.isInteger(item.quantity) || item.quantity<1 || (!item.product_id && !item.sku)) return null;
    keys.push(JSON.stringify([String(item.product_id ?? ""),String(item.variant_id ?? ""),String(item.sku ?? ""),item.quantity]));
  }
  return JSON.stringify(keys.sort());
}

/** Un estado del courier nunca prueba recepción humana ni mercancía apta para stock. */
export function wooReturnStockBlock(shippedIds: readonly string[], shipments: readonly (WooCancelShipment & { id: string })[], events: readonly ReturnProof[]): string | null {
  if (!shippedIds.length || shippedIds.some((id) => !shipments.some((s) => s.id === id))) return "Falta una salida del expediente de retorno. Revisa su vínculo.";
  if (shipments.some((s) => shipmentHasLeft(s) && !shippedIds.includes(s.id))) return "Hay otra salida despachada sin revisar.";
  for (const id of shippedIds) {
    const proof = events.filter((e) => e.shipment_id === id && e.actor && ["manual", "dispatch"].includes(e.source ?? ""));
    const receipt = proof.filter((e) => e.kind === "return_received").map((e) => e.occurred_at).sort().at(-1);
    if (!receipt) return "Retorno pendiente: almacén debe confirmar la recepción física de todas las salidas.";
    if (shipments.find((s)=>s.id===id)?.custody_state!=="devuelto") return "Retorno pendiente: falta confirmar la custodia de la caja recibida en almacén.";
    const inventory = proof.filter((e) => ["inventory_reconciled", "merma_closed"].includes(e.kind)).sort((a,b) => b.occurred_at.localeCompare(a.occurred_at))[0];
    if (!inventory || inventory.kind !== "inventory_reconciled" || inventory.occurred_at < receipt)
      return "Almacén debe confirmar el reingreso apto a stock de cada salida recibida. Una merma requiere revisión.";
  }
  if (shipments.some((s) => !shippedIds.includes(s.id) && ["pendiente", "en_ruta", "por_preparar"].includes(s.delivery_status) && s.custody_state !== "devuelto"))
    return "Retira las salidas activas que nunca salieron antes de reponer el stock.";
  return null;
}
