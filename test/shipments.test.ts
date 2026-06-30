import { describe, it, expect } from "vitest";
import {
  DELIVERY_STATUSES,
  categoryOf,
  isCallable,
  isTerminal,
  isValidStatus,
  isFailureState,
  entersRerouteQueue,
  mapAliclikStatus,
  normalizeCity,
  isFenixCity,
  nextRerouteOutcome,
  MAX_REROUTE_ATTEMPTS,
  FENIX_CITIES,
} from "@/lib/shipments";

describe("delivery status model", () => {
  it("has unique codes and consistent categories", () => {
    const codes = DELIVERY_STATUSES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(categoryOf("entregado")).toBe("delivered");
    expect(categoryOf("por_devolver")).toBe("failure");
    expect(categoryOf("reprogramado")).toBe("rerouting");
    expect(categoryOf("devuelto")).toBe("closed");
  });

  it("flags callable/terminal/failure states", () => {
    expect(isCallable("por_devolver")).toBe(true);
    expect(isCallable("entregado")).toBe(false);
    expect(isTerminal("entregado")).toBe(true);
    expect(isTerminal("devuelto")).toBe(true);
    expect(isTerminal("por_preparar")).toBe(false);
    expect(isFailureState("dejado_almacen")).toBe(true);
    expect(entersRerouteQueue("reprogramado")).toBe(true);
    expect(entersRerouteQueue("en_agencia")).toBe(false);
    expect(isValidStatus("nope")).toBe(false);
  });
});

describe("mapAliclikStatus", () => {
  it("maps canonical and accented Spanish labels", () => {
    expect(mapAliclikStatus("Entregado")).toBe("entregado");
    expect(mapAliclikStatus("POR DEVOLVER")).toBe("por_devolver");
    expect(mapAliclikStatus("Dejado en almacén")).toBe("dejado_almacen");
    expect(mapAliclikStatus("Dejado en almacen")).toBe("dejado_almacen");
    expect(mapAliclikStatus("Remanente en tránsito")).toBe("remanente_transito");
  });
  it("falls back to por_preparar on unknown/empty", () => {
    expect(mapAliclikStatus("")).toBe("por_preparar");
    expect(mapAliclikStatus(null)).toBe("por_preparar");
    expect(mapAliclikStatus("estado raro")).toBe("por_preparar");
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
});

describe("nextRerouteOutcome (decision flow)", () => {
  it("entregado → FIN delivered, closed", () => {
    expect(nextRerouteOutcome("entregado", 1, true)).toEqual({
      status: "entregado",
      outcome: "entregado",
      closed: true,
    });
  });
  it("rechaza → devuelto, closed", () => {
    expect(nextRerouteOutcome("rechaza", 1, true)).toEqual({
      status: "devuelto",
      outcome: "devuelto",
      closed: true,
    });
  });
  it("reprograma → reprogramado, stays open", () => {
    const r = nextRerouteOutcome("reprograma", 2, true);
    expect(r.status).toBe("reprogramado");
    expect(r.closed).toBe(false);
  });
  it("no_contesta keeps the shipment until attempts run out", () => {
    const early = nextRerouteOutcome("no_contesta", 3, true);
    expect(early.status).toBe("dejado_almacen");
    expect(early.closed).toBe(false);
    const last = nextRerouteOutcome("no_contesta", MAX_REROUTE_ATTEMPTS, true);
    expect(last.status).toBe("devuelto");
    expect(last.closed).toBe(true);
  });
  it("ineligible city → sin_cobertura, closed regardless of disposition", () => {
    const r = nextRerouteOutcome("reprograma", 1, false);
    expect(r.outcome).toBe("sin_cobertura");
    expect(r.closed).toBe(true);
    expect(r.status).toBe("por_devolver");
  });
});
