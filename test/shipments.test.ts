import { describe, it, expect } from "vitest";
import {
  DELIVERY_STATUSES,
  categoryOf,
  isCallable,
  isTerminal,
  isValidStatus,
  isPending,
  attemptLabel,
  normalizeCity,
  isFenixCity,
  isFenixDistrict,
  nextShipmentTransition,
  MAX_INTENTOS,
  FENIX_CITIES,
  reconcileDeliveryStatus,
} from "@/lib/shipments";

describe("delivery status model", () => {
  it("has the four global states with consistent categories", () => {
    const codes = DELIVERY_STATUSES.map((s) => s.code);
    expect(new Set(codes)).toEqual(new Set(["pendiente", "en_ruta", "entregado", "anulado"]));
    expect(categoryOf("pendiente")).toBe("pending");
    expect(categoryOf("en_ruta")).toBe("in_route");
    expect(categoryOf("entregado")).toBe("delivered");
    expect(categoryOf("anulado")).toBe("closed");
  });

  it("flags callable/terminal/pending states", () => {
    expect(isCallable("pendiente")).toBe(true);
    expect(isCallable("en_ruta")).toBe(true);
    expect(isCallable("entregado")).toBe(false);
    expect(isTerminal("entregado")).toBe(true);
    expect(isTerminal("anulado")).toBe(true);
    expect(isTerminal("pendiente")).toBe(false);
    expect(isPending("pendiente")).toBe(true);
    expect(isPending("en_ruta")).toBe(false);
    expect(isValidStatus("nope")).toBe(false);
  });

  it("labels the pending sub-state from the intento counter", () => {
    expect(attemptLabel(0)).toBe("Ingestión");
    expect(attemptLabel(null)).toBe("Ingestión");
    expect(attemptLabel(3)).toBe("Intento 3");
    expect(attemptLabel(7)).toBe("Intento 7");
    expect(attemptLabel(99)).toBe("Intento 7"); // clamped to MAX_INTENTOS
  });
});

describe("normalizeCity", () => {
  it("collapses Juliaca/Puno and strips accents/casing", () => {
    expect(normalizeCity("Cusco")).toBe("cusco");
    expect(normalizeCity("CUSCO ")).toBe("cusco");
    expect(normalizeCity("Juliaca/Puno")).toBe("juliaca");
    expect(normalizeCity("Juliaca - Puno")).toBe("juliaca");
    expect(normalizeCity("Puno")).toBe("puno");
  });
  it("knows the Fenix coverage set", () => {
    for (const c of FENIX_CITIES) expect(isFenixCity(c)).toBe(true);
    expect(isFenixCity("Lima")).toBe(false);
    expect(isFenixCity(null)).toBe(false);
  });
  it("matches Fenix-served districts tolerantly (accents, (cercado), longer names)", () => {
    expect(isFenixDistrict("Cerro Colorado")).toBe(true);
    expect(isFenixDistrict("San Sebastián")).toBe(true); // accents
    expect(isFenixDistrict("Arequipa (Cercado)")).toBe(true); // (cercado) → bare form
    expect(isFenixDistrict("Jose Luis Bustamante")).toBe(true); // shorter than "… y Rivero"
    expect(isFenixDistrict("Miraflores")).toBe(false); // Lima district, not served
    expect(isFenixDistrict(null)).toBe(false);
  });
});

describe("nextShipmentTransition (gestión flow)", () => {
  it("pending: no_contesta advances the intento", () => {
    const r = nextShipmentTransition("pendiente", "no_contesta", 2);
    expect(r.status).toBe("pendiente");
    expect(r.attempts).toBe(3);
    expect(r.closed).toBe(false);
  });
  it("pending: failing past intento 7 gives up → anulado", () => {
    const r = nextShipmentTransition("pendiente", "no_contesta", MAX_INTENTOS);
    expect(r.status).toBe("anulado");
    expect(r.closed).toBe(true);
  });
  it("pending: confirma → en_ruta keeping the intento", () => {
    const r = nextShipmentTransition("pendiente", "confirma", 4);
    expect(r.status).toBe("en_ruta");
    expect(r.attempts).toBe(4);
    expect(r.closed).toBe(false);
  });
  it("pending: cancela → anulado", () => {
    expect(nextShipmentTransition("pendiente", "cancela", 1).status).toBe("anulado");
  });
  it("en_ruta: entregado → entregado por Fenix", () => {
    const r = nextShipmentTransition("en_ruta", "entregado", 3);
    expect(r.status).toBe("entregado");
    expect(r.deliveredSource).toBe("fenix");
    expect(r.closed).toBe(true);
  });
  it("en_ruta: no_contesta returns to pending at the SAME intento", () => {
    const r = nextShipmentTransition("en_ruta", "no_contesta", 2);
    expect(r.status).toBe("pendiente");
    expect(r.attempts).toBe(2); // does not increment
    expect(r.closed).toBe(false);
  });
  it("en_ruta: cancela → anulado", () => {
    expect(nextShipmentTransition("en_ruta", "cancela", 5).status).toBe("anulado");
  });
});

describe("reconcileDeliveryStatus (re-import merge)", () => {
  it("keeps En ruta when the report still says pendiente", () => {
    expect(reconcileDeliveryStatus("en_ruta", "pendiente")).toBe("en_ruta");
  });
  it("adopts a fresh ENTREGADO to close the guide", () => {
    expect(reconcileDeliveryStatus("pendiente", "entregado")).toBe("entregado");
    expect(reconcileDeliveryStatus("en_ruta", "entregado")).toBe("entregado");
  });
  it("never reopens a terminal state", () => {
    expect(reconcileDeliveryStatus("entregado", "pendiente")).toBe("entregado");
    expect(reconcileDeliveryStatus("anulado", "pendiente")).toBe("anulado");
    expect(reconcileDeliveryStatus("entregado", "entregado")).toBe("entregado");
  });
  it("keeps pendiente idempotent on re-import (attempts preserved elsewhere)", () => {
    expect(reconcileDeliveryStatus("pendiente", "pendiente")).toBe("pendiente");
  });
  it("takes the incoming status for a brand-new guide (no existing)", () => {
    expect(reconcileDeliveryStatus(null, "pendiente")).toBe("pendiente");
    expect(reconcileDeliveryStatus(undefined, "entregado")).toBe("entregado");
  });
});
