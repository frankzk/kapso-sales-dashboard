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
  /**
   * Columnas que la base todavía no tenía y se dejaron fuera para poder guardar
   * la guía. Vacío en operación normal; con algo dentro, hay una migración sin
   * aplicar y ese dato concreto no se registró.
   */
  droppedColumns: string[];
}

// ---------------------------------------------------------------------------
// La ventana entre el despliegue y la migración
// ---------------------------------------------------------------------------

/**
 * ESTO EXISTE POR UN FALLO REAL, EL 05-09-2026. El despliegue que empezó a
 * escribir `aliclik_expected_dispatch_date` salió antes de que su migración se
 * aplicara. Aliclik creó los pedidos —201, irreversible, con costo— y el INSERT
 * de nuestra fila reventó con «no existe la columna». Resultado: dos guías vivas
 * en Aliclik (`AUR5X950324066036`, `AUR5X431594420316`) que en Kapta no
 * existían, con sus pedidos mostrándose SIN guía. El siguiente paso natural de
 * la operadora habría sido emitir una segunda guía para la misma caja.
 *
 * La lección no es «acuérdate de migrar antes». Es que **esta escritura ocurre
 * después de una escritura hacia afuera que no se puede deshacer**, así que
 * tiene que ser la más difícil de romper del sistema, no la más frágil. Perder
 * una columna nueva es un dato de menos; perder la fila entera es un paquete
 * fantasma.
 *
 * Por eso el reintento NO lleva una lista de columnas nuevas que alguien tenga
 * que acordarse de mantener —olvidarla es exactamente el fallo que se está
 * arreglando—. Lleva la lista de las que jamás se pueden soltar: si falta una de
 * esas, la base no es la que este código espera y el error sube tal cual.
 */
const ESSENTIAL_COLUMNS: ReadonlySet<string> = new Set([
  "store_id",
  "order_id",
  "courier",
  "guide_code",
  "delivery_status",
  "status_category",
  "matched",
  "match_method",
  "created_via",
  "order_name",
]);

/**
 * Tope de columnas que se pueden ir soltando. Un despliegue puede adelantarse a
 * UNA migración con dos o tres columnas nuevas; si faltan más, lo que hay no es
 * una ventana de despliegue sino la base equivocada, y conviene que se note.
 */
const MAX_COLUMN_RETRIES = 4;

interface WriteError {
  code?: string;
  message?: string;
}

/**
 * El nombre de la columna que falta, o null si el error es cualquier otra cosa.
 *
 * `PGRST204` lo da PostgREST contra su caché de esquema —«Could not find the
 * 'x' column of 'shipments' in the schema cache»— y `42703` lo da Postgres
 * directamente —«column "x" of relation "shipments" does not exist»—. Los dos
 * traen el nombre entrecomillado y es el primer entrecomillado del mensaje.
 */
export function missingColumnName(error: WriteError | null | undefined): string | null {
  if (!error) return null;
  if (error.code !== "PGRST204" && error.code !== "42703") return null;
  const match = /'([^']+)'|"([^"]+)"/.exec(error.message ?? "");
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/**
 * Decide si se puede reintentar sin esa columna, y con qué fila.
 *
 * Devuelve null cuando NO hay que reintentar: el error es otro, la columna es
 * esencial, o no está en la fila que mandamos —soltar lo que no enviamos sería
 * un bucle infinito—.
 */
export function retryWithoutMissingColumn(
  row: Record<string, unknown>,
  error: WriteError | null | undefined,
): { row: Record<string, unknown>; dropped: string } | null {
  const column = missingColumnName(error);
  if (!column) return null;
  if (ESSENTIAL_COLUMNS.has(column)) return null;
  if (!(column in row)) return null;
  const { [column]: _dropped, ...rest } = row;
  return { row: rest, dropped: column };
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
  options: { createIfMissing?: boolean } = {},
): Promise<RouteOutputWriteResult | { error: string }> {
  const target = await findFillable(admin, orderId);
  const dropped: string[] = [];

  if (target) {
    const { data, error } = await withColumnFallback(
      { ...stripKeys(row), updated_at: new Date().toISOString() },
      dropped,
      (attempt) =>
        admin
          .from("shipments")
          .update(attempt)
          .eq("id", target.id)
          .eq("delivery_status", "pendiente")
          .eq("courier", COURIER_TBD)
          .eq("created_via", MANUAL_ROUTE_CREATED_VIA)
          .is("custody_transferred_at", null)
          .select("id")
          .maybeSingle(),
    );
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
      return {
        shipmentId: (data as { id: string }).id,
        filled: true,
        outputCode: target.output_code,
        droppedColumns: dropped,
      };
    }
    // Un error real no es una carrera. Antes se descartaba aquí y el operador
    // solo veía «la salida ya no está disponible», incluso cuando Postgres
    // explicaba exactamente qué columna o restricción había fallado.
    if (error) {
      return { error: error.message ?? "No se pudo actualizar la salida existente." };
    }
    // Sin fila devuelta la carrera la ganó otro: se sigue por el camino normal.
  }

  if (options.createIfMissing === false) {
    return { error: "La salida por definir ya no está disponible; no se creó una caja duplicada." };
  }

  const inserted = await withColumnFallback<{ id: string }>(row, dropped, (attempt) =>
    admin.from("shipments").insert(attempt).select("id").single(),
  );
  if (inserted.error || !inserted.data) {
    return { error: inserted.error?.message ?? "La base no devolvió la fila de la guía." };
  }
  return {
    shipmentId: inserted.data.id,
    filled: false,
    outputCode: null,
    droppedColumns: dropped,
  };
}

/**
 * Ejecuta la escritura y, si la base se queja de una columna que todavía no
 * tiene, la suelta y vuelve a intentar. `dropped` se va rellenando para que el
 * llamador pueda contar lo que no se guardó.
 */
async function withColumnFallback<T>(
  row: Record<string, unknown>,
  dropped: string[],
  run: (row: Record<string, unknown>) => PromiseLike<{ data: T | null; error: WriteError | null }>,
): Promise<{ data: T | null; error: WriteError | null }> {
  let attempt = row;
  for (let i = 0; i <= MAX_COLUMN_RETRIES; i++) {
    const result = await run(attempt);
    const retry = retryWithoutMissingColumn(attempt, result.error);
    if (!retry) return result;
    attempt = retry.row;
    dropped.push(retry.dropped);
  }
  return run(attempt);
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
  // El llamador construye una fila completa porque el mismo objeto también
  // sirve para INSERT. Al rellenar una salida existente, ese UUID nuevo jamás
  // puede viajar en el UPDATE: cambiaría la identidad de la caja y Postgres lo
  // rechazará en cuanto ya exista un evento o cotejo que la referencie.
  "id",
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
