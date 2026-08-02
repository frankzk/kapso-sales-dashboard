import { describe, it, expect } from "vitest";
import {
  leadPriorityScore,
  segmentWeightsFor,
  sortLeadsByPriority,
} from "@/lib/lead-priority";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const AURELA = segmentWeightsFor("Aurela");
const KENKU = segmentWeightsFor("Kenku Peru");

// Señales mínimas por segmento (misma definición que leadSegment).
const carrito = (over = {}) => ({ id: "c", cart_item_count: 1, last_interaction_at: daysAgo(0), ...over });
const distrito = (over = {}) => ({ id: "d", district: "Miraflores", last_interaction_at: daysAgo(0), ...over });
const converso = (over = {}) => ({ id: "v", inbound_count: 3, last_interaction_at: daysAgo(0), ...over });
const frio = (over = {}) => ({ id: "f", last_interaction_at: daysAgo(0), ...over });

describe("segmentWeightsFor", () => {
  it("usa los pesos medidos de cada tienda", () => {
    expect(AURELA.carrito).toBe(20);
    expect(AURELA.distrito).toBe(4); // en Aurela llamar al distrito rinde poco (3,7%)
    expect(KENKU.carrito).toBe(14);
    expect(KENKU.distrito).toBe(9); // en Kenku sí rinde (9,2%)
  });

  it("cae a un promedio que conserva el orden en una tienda sin medir", () => {
    const w = segmentWeightsFor("Tienda Nueva");
    expect(w.carrito).toBeGreaterThan(w.distrito);
    expect(w.distrito).toBeGreaterThan(w.converso);
    expect(w.converso).toBeGreaterThan(w.frio);
  });

  it("no depende de mayúsculas ni espacios", () => {
    expect(segmentWeightsFor("  KENKU PERU ")).toEqual(KENKU);
  });
});

describe("leadPriorityScore", () => {
  it("respeta el orden medido: carrito > distrito > conversó > frío", () => {
    const s = (lead: Parameters<typeof leadPriorityScore>[0]) => leadPriorityScore(lead, KENKU, NOW);
    expect(s(carrito())).toBeGreaterThan(s(distrito()));
    expect(s(distrito())).toBeGreaterThan(s(converso()));
    expect(s(converso())).toBeGreaterThan(s(frio()));
  });

  it("entre dos carritos manda el ticket", () => {
    const barato = leadPriorityScore(carrito({ cart_value: 50 }), KENKU, NOW);
    const caro = leadPriorityScore(carrito({ cart_value: 250 }), KENKU, NOW);
    expect(caro).toBeGreaterThan(barato);
  });

  it("el bono de ticket está topado: un carrito enorme no aplasta la señal", () => {
    const grande = leadPriorityScore(carrito({ cart_value: 100_000 }), KENKU, NOW);
    expect(grande).toBeLessThanOrEqual(KENKU.carrito + 10);
  });

  // El desgaste por antigüedad es criterio; los pesos son dato medido. Por eso el
  // reloj degrada dentro de una escala pero nunca invierte el orden de segmentos.
  it("la antigüedad nunca hunde un lead por debajo del piso de frescura", () => {
    const antiquisimo = leadPriorityScore(carrito({ last_interaction_at: daysAgo(3650) }), KENKU, NOW);
    expect(antiquisimo).toBeGreaterThan(0);
    expect(antiquisimo).toBeCloseTo(KENKU.carrito * 0.4, 5);
  });

  it("castiga la antigüedad", () => {
    const hoy = leadPriorityScore(carrito({ last_interaction_at: daysAgo(0) }), KENKU, NOW);
    const viejo = leadPriorityScore(carrito({ last_interaction_at: daysAgo(10) }), KENKU, NOW);
    expect(viejo).toBeLessThan(hoy);
  });

  // El punto del puntaje: la intención pesa más que el reloj. Hoy la cola ordena
  // al revés y por eso los carritos quedan enterrados entre fríos recientes.
  it("un carrito VIEJO sigue por encima de un frío RECIÉN llegado", () => {
    const carritoViejo = leadPriorityScore(carrito({ last_interaction_at: daysAgo(60) }), KENKU, NOW);
    const frioNuevo = leadPriorityScore(frio({ last_interaction_at: daysAgo(0) }), KENKU, NOW);
    expect(carritoViejo).toBeGreaterThan(frioNuevo);
  });

  it("sin fecha alguna no revienta ni castiga", () => {
    const sinFecha = leadPriorityScore({ cart_item_count: 1 }, KENKU, NOW);
    expect(sinFecha).toBe(KENKU.carrito);
  });

  it("una fecha inválida no rompe el puntaje", () => {
    const roto = leadPriorityScore(carrito({ last_interaction_at: "no-es-fecha" }), KENKU, NOW);
    expect(Number.isFinite(roto)).toBe(true);
  });

  it("los pesos por tienda cambian el resultado: el distrito rinde distinto", () => {
    const enAurela = leadPriorityScore(distrito(), AURELA, NOW);
    const enKenku = leadPriorityScore(distrito(), KENKU, NOW);
    expect(enKenku).toBeGreaterThan(enAurela);
  });
});

describe("sortLeadsByPriority", () => {
  it("ordena de mayor a menor prioridad", () => {
    const rows = [
      { id: "frio", last_interaction_at: daysAgo(0) },
      { id: "carrito", cart_item_count: 1, last_interaction_at: daysAgo(2) },
      { id: "converso", inbound_count: 5, last_interaction_at: daysAgo(0) },
      { id: "distrito", district: "Wanchaq", last_interaction_at: daysAgo(1) },
    ];
    expect(sortLeadsByPriority(rows, KENKU, NOW).map((r) => r.id)).toEqual([
      "carrito",
      "distrito",
      "converso",
      "frio",
    ]);
  });

  it("no muta la lista original", () => {
    const rows = [
      { id: "a", last_interaction_at: daysAgo(0) },
      { id: "b", cart_item_count: 1, last_interaction_at: daysAgo(0) },
    ];
    const copia = [...rows];
    sortLeadsByPriority(rows, KENKU, NOW);
    expect(rows).toEqual(copia);
  });

  it("empates estables: mismo puntaje mantiene siempre el mismo orden", () => {
    const rows = [
      { id: "zzz", cart_item_count: 1, last_interaction_at: daysAgo(0) },
      { id: "aaa", cart_item_count: 1, last_interaction_at: daysAgo(0) },
    ];
    expect(sortLeadsByPriority(rows, KENKU, NOW).map((r) => r.id)).toEqual(["aaa", "zzz"]);
    // dos pasadas seguidas no pueden dar órdenes distintos
    expect(sortLeadsByPriority(rows, KENKU, NOW).map((r) => r.id)).toEqual(
      sortLeadsByPriority(rows, KENKU, NOW).map((r) => r.id),
    );
  });
});
