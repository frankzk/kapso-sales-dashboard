// Las filas del Master, listas para una hoja de cálculo. Puro + testeado.
//
// QUÉ EXPORTA. Lo que se ve en la tabla, con las MISMAS etiquetas: quien abre
// el fichero tiene que reconocer lo que estaba mirando. Un `por_confirmar` en
// la hoja donde la pantalla decía «Por confirmar» obliga a traducir a mano.
//
// QUÉ NO DECIDE. Este módulo no sabe nada de filtros. El conjunto a exportar lo
// resuelve `getOrderMasterPage` con los filtros parseados de la misma URL que
// vio la tabla (lib/master-query.ts), así que exportar no puede divergir de
// listar: es la misma consulta, sin paginar. Reimplementar aquí el filtrado
// sería garantizar que un día la hoja y la pantalla dejen de coincidir.

import type { OrderMasterRow } from "@/lib/types";
import { macroStageLabel, macroSubstageLabel } from "@/lib/order-macro-stage";
import { generalLabel, operationalLabel } from "@/lib/order-status";
import { ORDER_COVERAGE_LABEL, type OrderCoverage } from "@/lib/order-coverage";

export interface MasterExportColumn {
  header: string;
  width: number;
  /** Texto, número o fecha. Decide el formato de la celda, no el contenido. */
  kind: "text" | "number" | "money" | "date";
  value: (row: OrderMasterRow, ctx: MasterExportContext) => string | number | Date | null;
}

export interface MasterExportContext {
  /** id de tienda → nombre. La hoja enseña «Kenku Peru», no un UUID. */
  storeNames: Record<string, string>;
  /** Para calcular la antigüedad igual que la columna de la tabla. */
  now: Date;
}

const DAY_MS = 86_400_000;

/** Fecha ISO → Date, o null si no hay o no se entiende. Una celda vacía es
 *  preferible a un "Invalid Date" que Excel arrastra como texto. */
function asDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Días desde el último movimiento, que es lo que la tabla llama «Antigüedad».
 * Se devuelve el número, no "hoy"/"3 días": en una hoja de cálculo un número se
 * puede ordenar y promediar, y el texto no.
 */
export function ageInDays(row: OrderMasterRow, now: Date): number | null {
  const ref = asDate(row.last_movement_at) ?? asDate(row.order_created_at);
  if (!ref) return null;
  return Math.max(0, Math.floor((now.getTime() - ref.getTime()) / DAY_MS));
}

/**
 * Las columnas, en el orden en que se leen en pantalla de izquierda a derecha.
 *
 * Al final van cuatro que la tabla NO enseña —guía, despacho, entrega y
 * devolución— porque son justo lo que se busca al bajar el listado a una hoja:
 * cruzar con el courier, contar entregas, revisar devoluciones. Ocupan poco y
 * evitan tener que pedir otro export distinto.
 */
export const MASTER_EXPORT_COLUMNS: MasterExportColumn[] = [
  { header: "Pedido", width: 16, kind: "text", value: (r) => r.order_name ?? "" },
  {
    header: "Tienda",
    width: 16,
    kind: "text",
    value: (r, ctx) => ctx.storeNames[r.store_id] ?? r.store_id,
  },
  { header: "Creado", width: 12, kind: "date", value: (r) => asDate(r.order_created_at) },
  { header: "Cliente", width: 28, kind: "text", value: (r) => r.customer_name ?? "" },
  // Texto a propósito: un teléfono es un identificador, no una cantidad. Como
  // número, Excel se come el cero inicial y lo pasa a notación científica.
  { header: "Teléfono", width: 16, kind: "text", value: (r) => r.customer_phone ?? "" },
  { header: "Región", width: 16, kind: "text", value: (r) => r.region ?? "" },
  { header: "Provincia", width: 16, kind: "text", value: (r) => r.province ?? "" },
  { header: "Distrito", width: 18, kind: "text", value: (r) => r.district ?? "" },
  {
    header: "Cobertura",
    width: 15,
    kind: "text",
    value: (r) => (r.coverage ? (ORDER_COVERAGE_LABEL[r.coverage as OrderCoverage] ?? r.coverage) : ""),
  },
  { header: "Monto", width: 12, kind: "money", value: (r) => r.order_total ?? null },
  { header: "Estado", width: 14, kind: "text", value: (r) => generalLabel(r.general_status) },
  {
    header: "Estado operativo",
    width: 20,
    kind: "text",
    value: (r) => operationalLabel(r.operational_status),
  },
  { header: "Macroetapa", width: 16, kind: "text", value: (r) => macroStageLabel(r.macro_stage) },
  { header: "Subetapa", width: 18, kind: "text", value: (r) => macroSubstageLabel(r.macro_substage) },
  { header: "Courier actual", width: 15, kind: "text", value: (r) => r.current_courier ?? "" },
  { header: "Último courier", width: 15, kind: "text", value: (r) => r.last_courier ?? "" },
  { header: "Couriers", width: 10, kind: "number", value: (r) => r.courier_count ?? 0 },
  { header: "Intentos", width: 10, kind: "number", value: (r) => r.attempt_count ?? 0 },
  { header: "Últ. movimiento", width: 14, kind: "date", value: (r) => asDate(r.last_movement_at) },
  { header: "Antigüedad (días)", width: 16, kind: "number", value: (r, ctx) => ageInDays(r, ctx.now) },
  { header: "Guía", width: 22, kind: "text", value: (r) => r.guide_code ?? "" },
  { header: "Despachado", width: 12, kind: "date", value: (r) => asDate(r.dispatched_at) },
  { header: "Entregado", width: 12, kind: "date", value: (r) => asDate(r.delivered_at) },
  { header: "Devuelto", width: 12, kind: "date", value: (r) => asDate(r.returned_at ?? null) },
];

/** Una fila de la hoja, en el orden de las columnas. */
export function toExportRow(
  row: OrderMasterRow,
  ctx: MasterExportContext,
): (string | number | Date | null)[] {
  return MASTER_EXPORT_COLUMNS.map((c) => c.value(row, ctx));
}

/**
 * El nombre del fichero dice QUÉ se bajó, porque se acumulan en Descargas y a
 * los dos días nadie recuerda cuál era cuál. Lleva la pestaña, si había una, y
 * la fecha.
 */
export function exportFilename(view: string | null | undefined, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const stage = view && view !== "todos" ? `_${view}` : "";
  return `pedidos${stage}_${day}.xlsx`;
}
