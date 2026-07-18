import { describe, expect, it } from "vitest";
import { sortShipmentRows } from "@/lib/shipment-sort";
import type { ShipmentRow } from "@/lib/types";

function shipment(
  id: string,
  overrides: Partial<ShipmentRow> = {},
): ShipmentRow {
  return {
    id,
    store_id: "store-a",
    courier: "fenix",
    guide_code: id,
    delivery_status: "en_ruta",
    status_category: "in_route",
    order_id: null,
    matched: false,
    match_method: null,
    order_name: null,
    customer_name: null,
    customer_phone: null,
    product: null,
    district: null,
    city: null,
    region: null,
    delivery_address: null,
    delivery_reference: null,
    latitude: null,
    longitude: null,
    address_override: false,
    address_updated_at: null,
    address_updated_by: null,
    fenix_eligible: false,
    fenix_shipment_id: null,
    delivered_source: null,
    aliclik_attempts: null,
    aliclik_service_date: null,
    reroute_attempts: 0,
    reroute_outcome: null,
    claimed_by: null,
    claimed_at: null,
    next_followup_at: null,
    source_batch_id: null,
    last_report_at: null,
    suggested_order_gid: null,
    suggested_store_id: null,
    suggested_order_name: null,
    ...overrides,
  };
}

const storeName = (id: string) => ({ "store-a": "Aurela", "store-b": "Kenku Peru" })[id] ?? id;

describe("sortShipmentRows", () => {
  it("sorts reprogramming dates in both directions and keeps missing dates last", () => {
    const rows = [
      shipment("none"),
      shipment("21", { next_followup_at: "2026-07-21T00:00:00.000Z" }),
      shipment("20", { next_followup_at: "2026-07-20T00:00:00.000Z" }),
    ];

    expect(sortShipmentRows(rows, "reprogramming", "asc", storeName).map((row) => row.id)).toEqual([
      "20",
      "21",
      "none",
    ]);
    expect(sortShipmentRows(rows, "reprogramming", "desc", storeName).map((row) => row.id)).toEqual([
      "21",
      "20",
      "none",
    ]);
  });

  it("uses natural numeric ordering for guide and order codes", () => {
    const rows = [
      shipment("b", { guide_code: "#KP10", order_name: "#KP20" }),
      shipment("a", { guide_code: "#KP2", order_name: "#KP3" }),
    ];
    expect(sortShipmentRows(rows, "guide", "asc", storeName).map((row) => row.id)).toEqual(["a", "b"]);
    expect(sortShipmentRows(rows, "order", "desc", storeName).map((row) => row.id)).toEqual(["b", "a"]);
  });

  it("sorts visible store, customer, location and status labels", () => {
    const rows = [
      shipment("kenku", {
        store_id: "store-b",
        customer_name: "Zoila",
        district: "Wanchaq",
        city: "Cusco",
        delivery_status: "entregado",
      }),
      shipment("aurela", {
        store_id: "store-a",
        customer_name: "Ángela",
        district: "Cayma",
        city: "Arequipa",
        delivery_status: "anulado",
      }),
    ];

    for (const key of ["store", "customer", "location", "status"] as const) {
      expect(sortShipmentRows(rows, key, "asc", storeName).map((row) => row.id)).toEqual([
        "aurela",
        "kenku",
      ]);
    }
  });

  it("keeps the original order when values are equal", () => {
    const rows = [shipment("first", { customer_name: "Ana" }), shipment("second", { customer_name: "Ana" })];
    expect(sortShipmentRows(rows, "customer", "asc", storeName).map((row) => row.id)).toEqual([
      "first",
      "second",
    ]);
  });
});
