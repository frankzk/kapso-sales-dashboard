import { nextUrpiDeliveryDate } from "./urpi-programming";
import type { UrpiReportRow, UrpiResultCode } from "./urpi-report";
import type { UrpiLinkMethod, UrpiLinkStatus } from "./urpi-report-link";

/** Lo que la pantalla lee de `urpi_report_rows`. */
export interface UrpiStoredRow {
  urpi_row: number;
  previous_row: number | null;
  report_date: string | null;
  result_code: UrpiResultCode;
  data: UrpiReportRow;
  order_id: string | null;
  store_id: string | null;
  link_status: UrpiLinkStatus;
  link_method: UrpiLinkMethod | null;
  candidate_order_ids: string[];
}

/** Lo que Kapta sabe del pedido (order_master). */
export interface UrpiOrderFacts {
  order_id: string;
  store_id: string;
  order_name: string | null;
  customer_name: string | null;
  general_status: string;
  macro_stage: string | null;
  order_total: number | null;
  cancelled_at: string | null;
  /** Etapa del Master para mostrar («En curso · Por reprogramar Lima»). */
  stage_label?: string;
}

/**
 * Dónde cae cada envío según su ÚLTIMO intento y lo que Kapta ya sabe:
 *   por_aplicar   Urpi entregó y Kapta no lo tiene (se puede marcar, §30.11).
 *   observacion   Urpi entregó pero Kapta lo tiene anulado o devuelto: nunca se marca.
 *   cancelado     Urpi lo canceló y Kapta lo sigue teniendo abierto (Seguimiento Lima).
 *   reprogramado  Urpi lo reintenta el siguiente día hábil.
 *   en_curso      Programado o en coordinación.
 *   no_reconocido Urpi escribió un estado que Kapta no conoce.
 *   por_vincular  Sin pedido único: alguien elige el pedido.
 *   al_dia        Kapta ya lo cerró (entregado, anulado o devuelto).
 */
export type UrpiBucket = "por_aplicar" | "observacion" | "cancelado" | "reprogramado" | "en_curso" | "no_reconocido" | "por_vincular" | "al_dia";

export interface UrpiShipment {
  key: string;
  attempts: UrpiStoredRow[];
  latest: UrpiStoredRow;
  order: UrpiOrderFacts | null;
  candidates: UrpiOrderFacts[];
  bucket: UrpiBucket;
  /** Reprogramado: el siguiente día de lunes a sábado desde la fecha del reporte. */
  nextDate: string | null;
  /** Entregado: lo cobrado por Urpi frente al total del pedido en Kapta. */
  amountGap: number | null;
}

const CLOSED = new Set(["entregado", "anulado", "devuelto"]);

/** Un envío = todos los intentos de un pedido; sin pedido, los de una cadena. */
export function buildUrpiShipments(rows: readonly UrpiStoredRow[], facts: ReadonlyMap<string, UrpiOrderFacts>): UrpiShipment[] {
  const byRow = new Map(rows.map((row) => [row.urpi_row, row]));
  const rootOf = (row: UrpiStoredRow) => {
    let current = row;
    for (let depth = 0; depth < 100 && current.previous_row !== null; depth++) {
      const parent = byRow.get(current.previous_row);
      if (!parent || parent === current) break;
      current = parent;
    }
    return current.urpi_row;
  };
  const groups = new Map<string, UrpiStoredRow[]>();
  for (const row of rows) {
    const key = row.order_id ? `pedido:${row.order_id}` : `cadena:${rootOf(row)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const shipments: UrpiShipment[] = [];
  for (const [key, list] of groups) {
    const attempts = [...list].sort((a, b) => a.urpi_row - b.urpi_row);
    const latest = attempts[attempts.length - 1]!;
    const order = latest.order_id ? facts.get(latest.order_id) ?? null : null;
    const candidates = latest.candidate_order_ids.map((id) => facts.get(id)).filter((fact): fact is UrpiOrderFacts => Boolean(fact));
    const closed = order ? CLOSED.has(order.general_status) || Boolean(order.cancelled_at) : false;
    let bucket: UrpiBucket;
    if (!order) bucket = "por_vincular";
    else if (latest.result_code === "entregado") {
      bucket = order.general_status === "entregado" ? "al_dia" : closed ? "observacion" : "por_aplicar";
    } else if (latest.result_code === "otro") bucket = "no_reconocido";
    else if (closed) bucket = "al_dia";
    else if (latest.result_code === "cancelado") bucket = "cancelado";
    else if (latest.result_code === "reprogramado") bucket = "reprogramado";
    else bucket = "en_curso";
    let nextDate: string | null = null;
    if (latest.result_code === "reprogramado" && latest.report_date) nextDate = nextUrpiDeliveryDate(latest.report_date);
    const collected = latest.data.amountCollected;
    const amountGap = latest.result_code === "entregado" && collected !== null && order?.order_total != null
      ? Math.round((collected - order.order_total) * 100) / 100 : null;
    shipments.push({ key, attempts, latest, order, candidates, bucket, nextDate, amountGap });
  }
  return shipments.sort((a, b) => (b.latest.report_date ?? "").localeCompare(a.latest.report_date ?? "") || b.latest.urpi_row - a.latest.urpi_row);
}
