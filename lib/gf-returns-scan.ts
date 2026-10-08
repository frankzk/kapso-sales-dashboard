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

import { boxDayShort } from "@/lib/gf-scan-return";

export interface GfReturnFacts {
  /** La caja de Grupo GF donde está el paquete ahora, si está en una. */
  box: { riderName: string; routeDate: string; stopStatus: string | null } | null;
  /** `shipments.custody_state`. */
  custodyState: string | null;
  /** Ya se recibió en oficina (`returned_to_office`) y no volvió a salir. */
  receivedInOffice: boolean;
}

export type GfReturnDecision =
  | { kind: "recibir" }
  | { kind: "aviso"; message: string }
  | { kind: "error"; message: string };

/** Pura: qué hace el escaneo con un paquete de Grupo GF. `label` es el código de la salida. */
export function gfReturnDecision(label: string, facts: GfReturnFacts): GfReturnDecision {
  const { box } = facts;
  if (box) {
    const where = `la caja de ${box.riderName} del ${boxDayShort(box.routeDate)}`;
    if (box.stopStatus === "no_entregado") return { kind: "recibir" };
    if (box.stopStatus === "entregado") {
      return { kind: "error", message: `${label}: ${box.riderName} lo reportó entregado (${where}). Si volvió, que corrija ese reporte.` };
    }
    return {
      kind: "error",
      message: `${label} sigue en ${where} sin reporte: pide a ${box.riderName} que lo reporte «No entregado» y vuelve a escanearlo.`,
    };
  }
  if (facts.custodyState !== "empresa") {
    return { kind: "error", message: `${label}: no está en una caja de Grupo GF ni en la oficina. Revísalo en el Master.` };
  }
  return facts.receivedInOffice
    ? { kind: "aviso", message: `${label} ya estaba recibido en oficina: sigue por asignar en Grupo GF para reprogramarlo.` }
    : { kind: "aviso", message: `${label} nunca salió en Kapta: no hay devolución que registrar. Sigue por asignar en Grupo GF.` };
}
