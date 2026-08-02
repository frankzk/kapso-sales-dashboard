// Qué salida se imprime cuando el almacén selecciona un PEDIDO.
//
// Un pedido puede tener varias salidas (MOM §4: hasta cinco). Para imprimir la
// tanda del día interesa la que está por prepararse: la que sigue bajo custodia
// de la empresa. Si ninguna lo está —todas ya salieron— se usa la más reciente,
// que es la que el operador esperaría reimprimir.
//
// Puro y testeado: la regla de "cuál es la salida vigente" no debe vivir dentro
// de un handler HTTP.

export interface ShipmentForLabel {
  id: string;
  order_id: string | null;
  courier: string;
  guide_code: string;
  output_code: string | null;
  output_number: number | null;
  qr_token: string | null;
  custody_state: string | null;
  created_at: string | null;
}

/** La salida a rotular de un pedido, o null si no tiene ninguna. */
export function pickShipmentForLabel<T extends ShipmentForLabel>(
  shipments: readonly T[],
): T | null {
  if (!shipments.length) return null;
  const byRecency = [...shipments].sort((a, b) => {
    const ac = a.created_at ?? "";
    const bc = b.created_at ?? "";
    if (ac !== bc) return ac < bc ? 1 : -1;
    // Sin fecha fiable, el consecutivo de salida desempata (S02 gana a S01).
    return (b.output_number ?? 0) - (a.output_number ?? 0);
  });
  return byRecency.find((s) => s.custody_state === "empresa") ?? byRecency[0]!;
}

export interface LabelSelection<T> {
  /** Una salida por pedido, en el orden en que llegaron los pedidos. */
  labels: T[];
  /** Pedidos seleccionados que todavía no tienen ninguna salida creada. */
  missing: string[];
}

/**
 * Reparte las salidas por pedido conservando el orden en que el operador
 * seleccionó los pedidos, y separa los que aún no tienen rótulo que imprimir
 * (subetapa `por_generar_rotulo`: la salida todavía no existe).
 */
export function selectLabelsForOrders<T extends ShipmentForLabel>(
  orderIds: readonly string[],
  shipments: readonly T[],
): LabelSelection<T> {
  const byOrder = new Map<string, T[]>();
  for (const shipment of shipments) {
    if (!shipment.order_id) continue;
    const list = byOrder.get(shipment.order_id) ?? [];
    list.push(shipment);
    byOrder.set(shipment.order_id, list);
  }

  const labels: T[] = [];
  const missing: string[] = [];
  for (const orderId of orderIds) {
    const picked = pickShipmentForLabel(byOrder.get(orderId) ?? []);
    if (picked) labels.push(picked);
    else missing.push(orderId);
  }
  return { labels, missing };
}
