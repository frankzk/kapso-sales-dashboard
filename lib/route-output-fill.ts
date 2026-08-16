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
  ROUTE_OUTPUT_FILLED,
  pickFillableRouteOutput,
} from "@/lib/shipment-output";

/** Lo que hace falta para decidir si una salida se puede rellenar. */
const CANDIDATE_COLUMNS =
  "id,store_id,courier,created_via,delivery_status,custody_state,custody_transferred_at,output_number,output_code";

interface Candidate {
  id: string;
  store_id: string;
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
      // EL RASTRO. Sin él, deshacer el relleno más tarde obligaría a deducir de
      // la FORMA de la fila que un día fue «por definir», y esa deducción es
      // justo la que `cancelledAsRecordCorrection` documenta como peligrosa.
      // Va después del UPDATE: un evento sin relleno detrás mentiría.
      await admin.from("order_events").insert({
        store_id: target.store_id,
        order_id: orderId,
        kind: ROUTE_OUTPUT_FILLED,
        occurred_at: new Date().toISOString(),
        source: "manual",
        courier: typeof row.courier === "string" ? row.courier : null,
        guide_code: typeof row.guide_code === "string" ? row.guide_code : null,
        shipment_id: target.id,
        note: `${target.output_code ?? "La salida"} tenia courier por definir; se le escribio la guia del courier encima.`,
        payload: { outputCode: target.output_code, previousCourier: target.courier },
      });
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

/**
 * Lo que describe LA CAJA, no la guía, y por tanto no se pisa al rellenar.
 *
 * Rellenar decide el courier de un bulto que ya existe: quién lo lleva es dato
 * nuevo, pero el trabajo que el almacén ya hizo sobre él no. Mandar
 * `preparation_state` en la fila haría retroceder a «rótulo generado» una caja
 * escaneada como «listo despacho» —borrar un escaneo real para registrar una
 * guía—, y mandar `qr_token` u `output_number` le cambiaría la identidad a mitad
 * de camino, con el rótulo ya pegado.
 *
 * Hoy ninguno de los llamadores manda estos campos, así que esto no cambia nada:
 * está para que el siguiente que escriba una fila no tenga que saberlo. Es la
 * misma razón por la que `store_id` y `order_id` tampoco se reescriben — es la
 * misma fila del mismo pedido, y mandarlos solo abre la puerta a moverla.
 */
const BOX_OWNED_COLUMNS = [
  "store_id",
  "order_id",
  "preparation_state",
  "custody_state",
  "custody_transferred_at",
  "custody_transferred_by",
  "ready_at",
  "ready_by",
  "qr_token",
  "output_number",
  "output_code",
] as const;

export function stripKeys(row: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!(BOX_OWNED_COLUMNS as readonly string[]).includes(key)) rest[key] = value;
  }
  return rest;
}
