// «Sacar con salida nueva» (12-10-2026, decisión del owner, MOM §9.3 y §29.13).
//
// EL CASO. Johnny (Yhoni) y Roy traen lo no entregado al día siguiente; Alexis
// cada dos o tres días; de noche no se recibe nada. Mientras tanto la caja
// «No entregado» sigue a nombre del motorizado, y si el cliente pide el pedido
// antes, había que esperar a que volviera. Ahora el pedido puede salir con una
// salida NUEVA —otra caja desde stock, con su QR y su rótulo— y la anterior
// queda «en devolución» a nombre del motorizado: custodia `retorno` y evento
// `output_replaced` (0246). Al recibirla en oficina se desarma y vuelve a
// stock; no se reutiliza ni vuelve a la cola.
//
// Sin imports: lo leen el Master, las etiquetas, la cola y el navegador.

/** El evento que deja `gf_replace_output` (0246) sobre la salida reemplazada. */
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

/** Las salidas que se reemplazaron por otra (`output_replaced`), por id. */
export function replacedOutputIds(events: readonly { kind: string; shipment_id?: string | null }[]): Set<string> {
  const out = new Set<string>();
  for (const event of events) {
    if (event.kind === OUTPUT_REPLACED_KIND && event.shipment_id) out.add(event.shipment_id);
  }
  return out;
}
