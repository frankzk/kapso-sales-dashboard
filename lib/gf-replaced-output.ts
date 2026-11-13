// «Sacar con salida nueva» (12-10-2026, decisión del owner, MOM §9.3 y §29.13).
//
// EL CASO. Johnny (Yhoni) y Roy traen lo no entregado al día siguiente; Alexis
// cada dos o tres días; de noche no se recibe nada. Mientras tanto la caja
// «No entregado» sigue a nombre del motorizado, y si el cliente pide el pedido
// antes, había que esperar a que volviera. Ahora el pedido puede salir con una
// salida NUEVA —otra caja desde stock, con su QR y su rótulo— y la anterior
// queda «en devolución» a nombre del motorizado: custodia `retorno` y evento
// `output_replaced` (0248). Al recibirla en oficina se desarma y vuelve a
// stock; no se reutiliza ni vuelve a la cola.
//
// Sin imports: lo leen el Master, las etiquetas, la cola y el navegador.

/** El evento que deja `gf_replace_output` (0248) sobre la salida reemplazada. */
export const OUTPUT_REPLACED_KIND = "output_replaced";

export interface ReturningOutputLike {
  courier?: string | null;
  delivery_status?: string | null;
  custody_state?: string | null;
  returned_at?: string | null;
}

/**
 * ¿Es una salida de Grupo GF «en devolución» que todavía no se recibió?
 * Propia, viva para su courier (`pendiente`/`en_ruta`), custodia `retorno` y
 * sin recibir. Ya no se trabaja: no se reusa, no se rotula, no bloquea otra
 * salida ni es la vigente del pedido. La deja así «Sacar con salida nueva», y
 * también «Solicitar devolución» (§13). Que se REEMPLAZÓ lo dice su evento
 * `output_replaced` (`replacedOutputIds`, `gf_output_replaced` en la base):
 * solo esa no se reporta ni se reprograma.
 */
export function isReturningOwnOutput(output: ReturningOutputLike): boolean {
  return (
    (output.courier ?? "").trim().toLowerCase() === "propio" &&
    ["pendiente", "en_ruta"].includes(output.delivery_status ?? "") &&
    output.custody_state === "retorno" &&
    !output.returned_at
  );
}

/**
 * ¿Es la salida REEMPLAZADA por otra que el motorizado todavía tiene? En
 * devolución (`isReturningOwnOutput`) y con el evento `output_replaced`
 * (`replaced`, de `replacedOutputIds`). Una en `retorno` por «Solicitar
 * devolución» no lo es: se sigue reportando, recibiendo y reprogramando.
 */
export function isReplacedOwnOutput(output: ReturningOutputLike & { id?: string | null }, replaced: ReadonlySet<string>): boolean {
  return Boolean(output.id) && replaced.has(output.id as string) && isReturningOwnOutput(output);
}

/** Sin eventos leídos: ninguna salida cuenta como reemplazada. */
export const NO_REPLACED_OUTPUTS: ReadonlySet<string> = new Set();

/** Las salidas que se reemplazaron por otra (`output_replaced`), por id. */
export function replacedOutputIds(events: readonly { kind: string; shipment_id?: string | null }[]): Set<string> {
  const out = new Set<string>();
  for (const event of events) {
    if (event.kind === OUTPUT_REPLACED_KIND && event.shipment_id) out.add(event.shipment_id);
  }
  return out;
}

/**
 * Lo que hizo `gf_return_to_office` (0248) al recibir una caja en oficina,
 * leído DESPUÉS de llamarla: la reemplazada y la que ya constaba devuelta
 * salen a stock (custodia `devuelto`); lo demás vuelve a «por asignar»
 * (`empresa`). Un «Sacar con salida nueva» que terminó entre la lectura previa
 * y la recepción cambia la rama, así que el aviso no sale de lo leído antes.
 *
 * 0307 (owner, 04-11-2026): la de un pedido ANULADO EN LA TIENDA (o de una
 * venta terminada, 0285) va a inventario: `saleEnded` es `orders.cancelled_at`
 * (o `woo_sale_returns`) releído después de recibir.
 */
export type OfficeReturnOutcome = "a_stock_reemplazada" | "a_inventario_anulado" | "ya_devuelta" | "por_asignar";

export function officeReturnOutcome(custodyAfter: string | null | undefined, replaced: boolean, saleEnded = false): OfficeReturnOutcome {
  if (custodyAfter !== "devuelto") return "por_asignar";
  if (replaced) return "a_stock_reemplazada";
  return saleEnded ? "a_inventario_anulado" : "ya_devuelta";
}

// ---------------------------------------------------------------------------
// La guía de Aliclik también reemplaza la caja (owner, 12-11-2026; 0329)
// ---------------------------------------------------------------------------
//
// #KP203491: Alexis reportó la S01 «No entregado · no contesta» y todavía la
// tenía cuando una asesora creó la guía del reintento por Aliclik (S02). El
// pedido seguía en «Por reprogramar Lima» y en «Reintentos Aliclik»: el «No
// entregado» de la S01 solo dejaba de mandar con un movimiento de ESA salida.
// Ahora, al guardar la guía, `gf_replace_output_with_aliclik` deja la S01 en
// devolución como «Sacar con salida nueva» —custodia `retorno` y
// `output_replaced`, con `replaced_by_courier = aliclik`— y CIERRA su
// solicitud de Grupo GF (no la pasa a la guía, que no es de Grupo GF). La
// parada fallida del motorizado queda en su ruta. MOM §9.5.

/** La función de la base (0329), solo de `service_role`. */
export const GF_REPLACE_WITH_ALICLIK_RPC = "gf_replace_output_with_aliclik";

/**
 * ¿Hay que preguntarle a la base? Solo si entre las salidas vivas que la guía
 * de Aliclik deja atrás (`estorban` de la regla de salidas) hay una caja de
 * Grupo GF todavía con el motorizado (custodia `courier`). La base decide el
 * resto: Lima, «No entregado» antes de la guía, sin recibir ni reemplazar.
 */
export function ownBoxStillWithRider(outputs: readonly ReturningOutputLike[]): boolean {
  return outputs.some((output) =>
    (output.courier ?? "").trim().toLowerCase() === "propio" &&
    output.delivery_status === "pendiente" &&
    output.custody_state === "courier" &&
    !output.returned_at);
}

/** Una caja que la guía de Aliclik dejó en devolución, como la devuelve la base. */
export interface ReplacedByGuide {
  shipmentId: string;
  oldCode: string | null;
  riderName: string | null;
}

/** Lee la respuesta de `gf_replace_output_with_aliclik`; lo que no se entiende no cuenta. */
export function replacedByGuideFrom(result: unknown): ReplacedByGuide[] {
  const list = (result as { replaced?: unknown } | null)?.replaced;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const row = entry as { shipment_id?: unknown; old_code?: unknown; rider?: unknown } | null;
    if (typeof row?.shipment_id !== "string" || !row.shipment_id) return [];
    return [{
      shipmentId: row.shipment_id,
      oldCode: typeof row.old_code === "string" ? row.old_code : null,
      riderName: typeof row.rider === "string" ? row.rider : null,
    }];
  });
}

/** Lo que se le dice a quien creó la guía: qué caja quedó en devolución y qué pasa al recibirla. */
export function replacedByGuideNotice(replaced: readonly ReplacedByGuide[]): string | null {
  if (!replaced.length) return null;
  const boxes = replaced.map((row) => `${row.oldCode ?? "La caja anterior"} sigue con ${row.riderName ?? "el motorizado"}`);
  const one = replaced.length === 1;
  return `${boxes.join(" y ")}: ${one ? "queda" : "quedan"} en devolución y ${one ? "su solicitud" : "sus solicitudes"} de Grupo GF ${one ? "se cerró" : "se cerraron"}. Al recibirla en oficina se desarma y vuelve a stock.`;
}
