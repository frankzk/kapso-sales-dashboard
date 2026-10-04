import { describe, expect, it } from "vitest";
import { resolveOseIds } from "@/lib/shalom/ose-backfill";
import type { ShalomAccountOrder } from "@/lib/shalom/types";

// 01-10-2026: 21 guías de Kenku creadas a mano en Shalom Pro, sin OSE ID, y
// sus 25 avisos fallaron porque el ticket se baja con él. El listado de la
// cuenta trae esas guías con un `id`; solo se usa si se comprueba, con las
// guías creadas por API, que ese `id` ES el OSE ID.
const order = (guia: string, id: number): ShalomAccountOrder => ({ id, guia });

describe("el OSE ID de las guías creadas a mano", () => {
  const orders = [order("97891149", 101363195), order("97891201", 101363247), order("97950001", 101420001)];
  const known = [
    { guideCode: "97891149", oseId: 101363195 },
    { guideCode: "97891201", oseId: 101363247 },
  ];

  it("si las guías de la API confirman que id = OSE ID, la manual toma el suyo", () => {
    const r = resolveOseIds(orders, known, ["97950001", "97959999"]);
    expect(r.trusted).toBe(true);
    expect(r.verified).toBe(2);
    expect(r.resolved.get("97950001")).toBe(101420001);
    // Una guía que no está en el listado se queda sin OSE ID: no se inventa.
    expect(r.resolved.has("97959999")).toBe(false);
  });

  it("una sola contradicción y no se escribe nada", () => {
    const r = resolveOseIds([order("97891149", 555), ...orders.slice(1)], known, ["97950001"]);
    expect(r).toMatchObject({ trusted: false, reason: expect.stringContaining("97891149") });
    expect(r.resolved.size).toBe(0);
  });

  it("sin ninguna guía conocida en el listado no hay con qué comprobar", () => {
    const r = resolveOseIds([order("97950001", 101420001)], known, ["97950001"]);
    expect(r.trusted).toBe(false);
    expect(r.resolved.size).toBe(0);
  });

  it("una guía repetida en el listado no se adivina", () => {
    const r = resolveOseIds([...orders, order("97950001", 101420002)], known, ["97950001"]);
    expect(r.trusted).toBe(true);
    expect(r.resolved.has("97950001")).toBe(false);
  });
});
