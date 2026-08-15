// Adaptador de Aliclik. ENVUELVE el parser que ya existe
// (lib/aliclik-import.ts) en vez de reescribirlo: ese parser lleva tiempo en
// producción, está probado (test/aliclik-import.test.ts) y conoce las rarezas
// reales de los exports de Aliclik (la guía se detecta por VALOR porque las
// cabeceras cambian, el nº de pedido sale del texto libre de NOTA, etc.).
//
// Aquí solo se traduce su `ParsedShipmentRow` al registro canónico común.

import { parseAliclikReport, type ParsedShipmentRow } from "@/lib/aliclik-import";
import { emptyReportRow, type CanonicalReportRow, type CourierAdapter } from "./types";

/** Una fila de Aliclik se reconoce por su guía AUR5X, esté en la columna que esté. */
const GUIDE_RE = /AUR5X[A-Za-z0-9]+/i;

function toCanonical(row: ParsedShipmentRow): CanonicalReportRow {
  return {
    ...emptyReportRow(row.raw),
    guide_code: row.guide_code,
    order_name: row.order_name,
    order_name_confirmed: row.order_name_confirmed,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    product: row.product,
    district: row.district,
    province: row.province,
    region: row.region,
    delivery_address: row.delivery_address,
    delivery_reference: row.delivery_reference,
    delivery_status: row.delivery_status,
    // El parser ya normalizó el estado; conservamos el literal del reporte para
    // que se pueda auditar por qué se decidió lo que se decidió.
    reported_status: row.raw["ESTADO ENTREGA"] ?? row.raw["ESTADO DE ENTREGA"] ?? row.raw["ESTADO"] ?? null,
    attempts: row.aliclik_attempts,
    attempt_failed: row.attempt_failed,
    // Aliclik informa la fecha operativa de entrega: el día en que salió a
    // repartir, que es justo el día del intento.
    attempt_date: row.aliclik_service_date,
    // Aliclik informa la fecha operativa de entrega, no la de despacho; se usa
    // como fecha de cierre cuando la guía ya está entregada.
    closed_at: row.delivery_status === "entregado" && row.aliclik_service_date
      ? `${row.aliclik_service_date}T00:00:00.000Z`
      : null,
    store_hint: row.store_hint,
  };
}

export const aliclikAdapter: CourierAdapter = {
  id: "aliclik",
  label: "Aliclik",
  agency: false,
  parse: (rows, opts) => parseAliclikReport(rows, opts).map(toCanonical),
  score: (rows) =>
    rows
      .slice(0, 20)
      .filter((r) => Object.values(r).some((v) => GUIDE_RE.test(String(v ?? "")))).length,
};
