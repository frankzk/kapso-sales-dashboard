import { evaluateAliclikReschedule, labelOf, normalizeCity } from "./shipments";
import type { ShipmentRow } from "./types";

export type ShipmentSortKey =
  | "guide"
  | "store"
  | "order"
  | "customer"
  | "product"
  | "location"
  | "status"
  | "lastDelivery"
  | "reprogramming"
  | "route";

export type ShipmentSortDirection = "asc" | "desc";

type SortValue = string | number | null;

function routeSortValue(shipment: ShipmentRow): string {
  if (shipment.courier !== "aliclik" || shipment.status_category !== "pending") return "";
  const decision = evaluateAliclikReschedule({
    courier: shipment.courier,
    attempts: shipment.aliclik_attempts,
    serviceDate: shipment.aliclik_service_date,
  });
  return decision.eligible ? "aliclik" : "fenix";
}

function sortValue(
  shipment: ShipmentRow,
  key: ShipmentSortKey,
  storeName: (id: string) => string,
): SortValue {
  switch (key) {
    case "guide":
      return shipment.guide_code;
    case "store":
      return storeName(shipment.store_id);
    case "order":
      return shipment.order_name;
    case "customer":
      return shipment.customer_name || shipment.customer_phone;
    case "product":
      return shipment.product;
    case "location":
      return [shipment.district, normalizeCity(shipment.city)].filter(Boolean).join(" ");
    case "status":
      return labelOf(shipment.delivery_status);
    case "lastDelivery":
      // Última fecha de entrega agendada por Aliclik (más reciente arriba en desc);
      // sin fecha → null, que el sort manda al final en cualquier dirección.
      return shipment.aliclik_service_date ? Date.parse(shipment.aliclik_service_date) : null;
    case "reprogramming":
      return shipment.next_followup_at ? Date.parse(shipment.next_followup_at) : null;
    case "route":
      return routeSortValue(shipment);
  }
}

function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "es", {
    numeric: true,
    sensitivity: "base",
  });
}

/** Stable client-side sorting for the currently loaded/filtered shipment rows. */
export function sortShipmentRows(
  rows: ShipmentRow[],
  key: ShipmentSortKey,
  direction: ShipmentSortDirection,
  storeName: (id: string) => string,
): ShipmentRow[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftValue = sortValue(left.row, key, storeName);
      const rightValue = sortValue(right.row, key, storeName);
      const leftMissing = leftValue == null || leftValue === "";
      const rightMissing = rightValue == null || rightValue === "";
      // Missing dates/text always stay at the bottom, in either direction.
      if (leftMissing || rightMissing) {
        if (leftMissing && rightMissing) return left.index - right.index;
        return leftMissing ? 1 : -1;
      }
      const compared = compareValues(leftValue, rightValue);
      return compared === 0 ? left.index - right.index : compared * multiplier;
    })
    .map(({ row }) => row);
}
