// Un paquete de Grupo GF escaneado en «Devoluciones» de Almacén (05-10-2026).
//
// EL CASO. Al recibir devoluciones, KP137351-S01 y KP137320-S01 respondían «no
// es de Tanders ni de Shalom: su devolución se registra desde el Master», y
// quien tenía la caja en la mano no sabía qué pasaba con el pedido. Las dos
// estaban sin courier (`por_definir`), sin caja y en la empresa: para Kapta
// nunca salieron, y el pedido ya estaba «Por despachar · Listo para asignar».
//
// LA REGLA. Lo que vuelve de Grupo GF se recibe aquí igual que en Despacho del
// día → «Devoluciones»: un «No entregado» —cualquier motivo— sale de la caja
// del motorizado (`gf_return_to_office`) y el pedido queda por asignar en Grupo
// GF, para reprogramarlo. Solo la anulación en Shopify termina la venta (v1.23).
// Lo que nunca salió en Kapta no tiene nada que recibir: se dice que sigue por
// asignar. Un entregado o una parada sin reporte no se tocan.
//
// La caja reemplazada (12-10-2026, «Sacar con salida nueva», 0248) se recibe
// igual, pero vuelve a stock: el pedido ya salió con otra salida.

import { boxDayShort } from "@/lib/gf-scan-return";
import type { ReturnScanOutcome } from "@/lib/returns-scan-outcome";

export interface GfReturnFacts {
  /** La caja de Grupo GF donde está el paquete ahora, si está en una. */
  box: { riderName: string; routeDate: string; stopStatus: string | null } | null;
  /** `shipments.custody_state`. */
  custodyState: string | null;
  /**
   * Ya se recibió en oficina y no volvió a salir: `returned_to_office`, o
   * `return_received` de la rama a stock de `gf_return_to_office` (0248/0307:
   * la reemplazada, el anulado en la tienda, la que ya constaba devuelta).
   */
  receivedInOffice: boolean;
  /** El pedido salió con otra salida (`output_replaced`): esta vuelve a stock. */
  replaced?: boolean;
  /*
   * Una salida que ya consta devuelta pero sigue en la caja también va a stock
   * (0248): `custodyState` «devuelto».
   */
  /**
   * La venta terminó: anulado en la tienda (`orders.cancelled_at`, 0307) o
   * venta de WooCommerce terminada (0285). Sin caja y `devuelto`, ya se recibió
   * y fue a inventario: escanearla otra vez solo lo dice.
   */
  saleEnded?: boolean;
}

export type GfReturnDecision =
  /** `toStock`: era la caja reemplazada; al recibirla se desarma, no se reprograma. */
  | { kind: "recibir"; toStock?: boolean }
  /**
   * `toInventory`: ya se recibió y fue a inventario (venta terminada); no es una alarma.
   * `repeat`: la caja ya se había recibido antes: el escaneo no suma (05-11-2026).
   */
  | { kind: "aviso"; message: string; toInventory?: boolean; repeat?: true }
  | { kind: "error"; message: string };

/** Pura: qué hace el escaneo con un paquete de Grupo GF. `label` es el código de la salida. */
export function gfReturnDecision(label: string, facts: GfReturnFacts): GfReturnDecision {
  const { box } = facts;
  if (box) {
    const where = `la caja de ${box.riderName} del ${boxDayShort(box.routeDate)}`;
    if (box.stopStatus === "no_entregado") {
      return facts.replaced || facts.custodyState === "devuelto" ? { kind: "recibir", toStock: true } : { kind: "recibir" };
    }
    if (box.stopStatus === "entregado") {
      return { kind: "error", message: `${label}: ${box.riderName} lo reportó entregado (${where}). Si volvió, que corrija ese reporte.` };
    }
    return {
      kind: "error",
      message: `${label} sigue en ${where} sin reporte: pide a ${box.riderName} que lo reporte «No entregado» y vuelve a escanearlo.`,
    };
  }
  if (facts.replaced && facts.custodyState === "devuelto") {
    return { kind: "aviso", repeat: true, message: `${label} ya se recibió: era la caja reemplazada; desármala y regístrala como reingreso a stock.` };
  }
  if (facts.saleEnded && facts.custodyState === "devuelto") {
    return {
      kind: "aviso",
      toInventory: true,
      repeat: true,
      message: `${label} ya se recibió: el pedido está anulado en la tienda (o su venta terminó), así que fue a inventario —Almacén decide stock o merma—. No vuelve a «por asignar».`,
    };
  }
  // La que ya constaba devuelta (sin reemplazo ni venta terminada): la rama a
  // stock la sacó de la caja y sigue `devuelto`. Escanearla otra vez es la
  // misma caja que pasa dos veces por el lector, no un error (05-11-2026).
  if (facts.custodyState === "devuelto" && facts.receivedInOffice) {
    return { kind: "aviso", repeat: true, message: `${label} ya se recibió en oficina y consta devuelto: ya salió de la caja y no vuelve a «por asignar».` };
  }
  if (facts.custodyState !== "empresa") {
    return { kind: "error", message: `${label}: no está en una caja de Grupo GF ni en la oficina. Revísalo en el Master.` };
  }
  return facts.receivedInOffice
    ? { kind: "aviso", repeat: true, message: `${label} ya estaba recibido en oficina: sigue por asignar en Grupo GF para reprogramarlo.` }
    : { kind: "aviso", message: `${label} nunca salió en Kapta: no hay devolución que registrar. Sigue por asignar en Grupo GF.` };
}

/**
 * Qué fue el escaneo, para que la pantalla lo cuente (05-11-2026): recibirla
 * es `nueva` (también la reemplazada a stock y la del anulado a inventario);
 * un aviso de algo ya recibido es `repetida` —no suma—; el resto de avisos
 * («nunca salió en Kapta») es `informativa`. Un error no tiene resultado. PURA.
 */
export function gfReceptionOutcome(decision: GfReturnDecision): ReturnScanOutcome | null {
  if (decision.kind === "recibir") return "nueva";
  if (decision.kind === "aviso") return decision.repeat ? "repetida" : "informativa";
  return null;
}

/**
 * La caja de Grupo GF que sigue con el motorizado y se escanea en «Armar»
 * (13-11-2026, #KP201841): no se arma, se recibe en Devoluciones, donde pasa
 * si el motorizado la reportó «No entregado». PURA.
 */
export function gfReadyScanHint(label: string): string {
  return `${label} está con el motorizado de Grupo GF. Si volvió, recíbelo en Devoluciones (necesita su reporte «No entregado»).`;
}
