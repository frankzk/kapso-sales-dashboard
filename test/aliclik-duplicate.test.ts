import { describe, expect, it } from "vitest";
import { duplicateItems, sharesDuplicateItem, unresolvedDuplicateShipment, duplicateGate,
  duplicateResolutionProblem, type DuplicateShipment, type DuplicateConflict, type DuplicateResolution } from "@/lib/aliclik-duplicate";

const shipment: DuplicateShipment = {
  id: "shipment", order_id: "prior", guide_code: "AUR5X833230866120", courier: "aliclik",
  dispatched_at: "2026-09-18T21:25:31Z", custody_transferred_at: null, out_for_delivery_at: null,
  aliclik_reported_dispatch_date: null, returned_at: null, delivery_status: "en_ruta", custody_state: "courier", pickup_state: null,
};
const conflict: DuplicateConflict = { orderId: "prior", orderName: "#AUR177107", shipmentId: "shipment",
  guideCode: shipment.guide_code, courier: "aliclik", dispatchedAt: shipment.dispatched_at };
const resolution = (decision: DuplicateResolution["decision"], fingerprint = "current"): DuplicateResolution => ({
  decision, fingerprint, actor: "actor", reason: "Cliente confirmó ambos por llamada", occurredAt: "2026-10-01T12:00:00Z",
});

describe("la caja despachada, no el cierre comercial", () => {
  it("retiene el caso AUR177661/AUR177107 aunque hayan pasado 13 días", () => {
    expect(unresolvedDuplicateShipment(shipment)).toBe(true);
    expect(duplicateGate([conflict], "current", null, 0).allowed).toBe(false);
  });
  it.each(["anulado", "transferido", "pendiente"])("%s no prueba la devolución de un paquete despachado", (delivery_status) => {
    expect(unresolvedDuplicateShipment({ ...shipment, delivery_status })).toBe(true);
  });
  it.each([{ delivery_status: "entregado" }, { returned_at: "2026-09-30T12:00:00Z" }, { custody_state: "devuelto" }])("libera la salida resuelta: %j", (patch) => {
    expect(unresolvedDuplicateShipment({ ...shipment, ...patch })).toBe(false);
  });
  it("crear una guía sin despacho no es haber enviado dos paquetes", () => {
    expect(unresolvedDuplicateShipment({ ...shipment, dispatched_at: null, delivery_status: "pendiente", custody_state: "empresa" })).toBe(false);
  });
  it("un paquete esperando recojo en agencia sigue en custodia externa", () => {
    expect(unresolvedDuplicateShipment({ ...shipment, dispatched_at: null, delivery_status: "pendiente", custody_state: null, pickup_state: "disponible_para_recojo" })).toBe(true);
  });
});

describe("identidad de producto", () => {
  const items = (variant: string, sku = "SKU", quantity = 1) => duplicateItems([{ variant_id: variant, sku, quantity }])!;
  it("no confunde dos tallas de la misma tienda aunque el SKU esté repetido", () => {
    expect(sharesDuplicateItem(items("XL"), items("M"), true)).toBe(false);
  });
  it("reconoce el mismo SKU entre tiendas y no compara IDs Shopify de tiendas distintas", () => {
    expect(sharesDuplicateItem(items("1"), items("2"), false)).toBe(true);
    expect(sharesDuplicateItem(items("1", ""), items("1", ""), false)).toBeNull();
  });
  it("detecta el producto repetido aunque cambie la cantidad o haya otro adicional", () => {
    expect(sharesDuplicateItem(items("1", "SKU", 2), [...items("2"), ...items("1")], true)).toBe(true);
  });
  it("no toma títulos o una lectura vacía como identidades verificadas", () => {
    expect(duplicateItems([{ title: "Shorts", quantity: 1 }])).toBeNull();
    expect(duplicateItems(null)).toBeNull();
  });
});

describe("resoluciones", () => {
  it("ni pago solo ni confirmación sin dinero validado liberan ambos", () => {
    expect(duplicateGate([conflict], "current", null, 100).allowed).toBe(false);
    expect(duplicateGate([conflict], "current", resolution("both"), 19.99).allowed).toBe(false);
    expect(duplicateGate([conflict], "current", resolution("both"), 20).allowed).toBe(true);
  });
  it.each(["keep_existing", "replacement"] as const)("%s sigue retenido aunque haya adelanto", (decision) => {
    expect(duplicateGate([conflict], "current", resolution(decision), 200).allowed).toBe(false);
  });
  it("una salida o producto distinto invalida la excepción", () => {
    expect(duplicateGate([conflict], "changed", resolution("exception"), 200).allowed).toBe(false);
    expect(duplicateGate([conflict], "current", resolution("exception"), 0).allowed).toBe(true);
  });
  it("recuperar todos los paquetes libera el reemplazo", () => {
    expect(duplicateGate([], null, resolution("replacement"), 0).allowed).toBe(true);
  });
  it("exige un permiso de responsable además de la explicación", () => {
    expect(duplicateResolutionProblem("exception", "Excepción por compra confirmada", false)).toMatch(/responsable/);
    expect(duplicateResolutionProblem("exception", "Excepción por compra confirmada", true)).toBeNull();
    expect(duplicateResolutionProblem("confirmed", "Cliente dijo que sí", true)).toMatch(/válida/);
    expect(duplicateResolutionProblem("exception", "ok", true)).toMatch(/12/);
  });
});
