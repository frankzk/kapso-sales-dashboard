// Crear la guía de un courier sobre la salida que ya existe, en vez de abrir
// una segunda fila para la misma caja.
//
// Lo comparten Tanders, Aliclik y Shalom porque el mecanismo es idéntico y
// arreglar solo uno dejaría la misma trampa puesta en los otros dos: el rodeo
// era anular la salida para poder emitir la guía, y anularla arrastraba al
// pedido a `anulado` (#KP127639).
//
// La decisión de QUÉ salida se rellena vive en lib/shipment-output.ts, pura y
// con pruebas. Aquí solo está el viaje a la base.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MANUAL_ROUTE_CREATED_VIA,
  COURIER_TBD,
  pickFillableRouteOutput,
} from "@/lib/shipment-output";

/** Lo que hace falta para decidir si una salida se puede rellenar. */
const CANDIDATE_COLUMNS =
  "id,courier,created_via,delivery_status,custody_state,custody_transferred_at,output_number,output_code";

interface Candidate {
  id: string;
  courier: string;
  created_via: string | null;
  delivery_status: string;
  custody_state: string | null;
  custody_transferred_at: string | null;
  output_number: number | null;
  output_code: string | null;
}

export interface RouteOutputWriteResult {
  shipmentId: string;
  /** true = se rellenó la salida que ya existía; false = se creó una nueva. */
  filled: boolean;
  /** `KP123-S01` de la salida rellenada, para poder decirlo en el aviso. */
  outputCode: string | null;
}

/**
 * Escribe la guía del courier: rellena la salida «por definir» del pedido si la
 * hay, y si no crea una nueva.
 *
 * `row` es exactamente la fila que el llamador insertaría hoy. Al rellenar se
 * aplica como UPDATE, así que todo lo que NO viene en `row` sobrevive intacto —
 * el consecutivo, el `output_code`, el token del QR, el `preparation_state` y el
 * `custody_state`. Eso es justo lo que se quiere conservar: la caja ya estaba
 * armada y rotulada.
 *
 * `row.created_via` es OBLIGATORIO y tiene que ser el del courier. Sin él la
 * salida rellenada seguiría marcada como ruta manual y el botón «Anular salida»
 * seguiría ofreciéndose sobre una guía que ya existe en el courier — marcarla
 * anulada solo de nuestro lado la dejaría viva del otro (MOM §4).
 *
 * El UPDATE repite las condiciones que se comprobaron al leer: si entre la
 * lectura y la escritura otra pestaña despachó la caja o le puso courier, no la
 * pisa; cae a crear una salida nueva, que es el comportamiento anterior y nunca
 * pierde la guía que el courier ya emitió.
 */
export async function writeCourierGuide(
  admin: SupabaseClient,
  orderId: string,
  row: Record<string, unknown> & { created_via: string },
): Promise<RouteOutputWriteResult | { error: string }> {
  const target = await findFillable(admin, orderId);

  if (target) {
    const { data, error } = await admin
      .from("shipments")
      .update({ ...stripKeys(row), updated_at: new Date().toISOString() })
      .eq("id", target.id)
      .eq("delivery_status", "pendiente")
      .eq("courier", COURIER_TBD)
      .eq("created_via", MANUAL_ROUTE_CREATED_VIA)
      .is("custody_transferred_at", null)
      .select("id")
      .maybeSingle();
    if (!error && data) {
      return { shipmentId: (data as { id: string }).id, filled: true, outputCode: target.output_code };
    }
    // Sin fila devuelta la carrera la ganó otro: se sigue por el camino normal.
  }

  const inserted = await admin.from("shipments").insert(row).select("id").single();
  if (inserted.error) return { error: inserted.error.message };
  return {
    shipmentId: (inserted.data as { id: string }).id,
    filled: false,
    outputCode: null,
  };
}

async function findFillable(admin: SupabaseClient, orderId: string): Promise<Candidate | null> {
  const { data } = await admin
    .from("shipments")
    .select(CANDIDATE_COLUMNS)
    .eq("order_id", orderId)
    .eq("delivery_status", "pendiente");
  return pickFillableRouteOutput((data ?? []) as unknown as Candidate[]);
}

/** `store_id` y `order_id` no se reescriben: es la misma fila del mismo pedido,
 *  y mandarlos en un UPDATE solo abre la puerta a moverla por error. */
function stripKeys(row: Record<string, unknown>): Record<string, unknown> {
  const { store_id: _s, order_id: _o, ...rest } = row;
  return rest;
}
