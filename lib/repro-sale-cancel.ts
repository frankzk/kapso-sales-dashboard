import { wooSaleUnshippedLive } from "@/lib/woo-sale-return";
import type { WooCancelFacts } from "@/lib/woo-cancel";

/** Atender exige resolver las guías de preparación antes del cierre comercial.
 * Una guía pedida a GF para anular sigue viva hasta la respuesta confirmada.
 * Las cajas que ya salieron conservan su retorno por el flujo comercial existente.
 */
export function reproSaleGuideBlocks(facts: Pick<WooCancelFacts, "shipments" | "events">): string[] {
  return wooSaleUnshippedLive(facts).map((s) =>
    `La guía ${s.guide_code ?? "sin número"} de ${s.courier ?? "courier por definir"} sigue activa en preparación. Resuelve su anulación y actualiza su estado antes de confirmar la venta.`);
}
