import { describe, expect, it } from "vitest";
import { planOlvaLink, type OrderOutputForLink } from "@/lib/olva/link";

// «Vincular a pedido» de Cotejar Olva (MOM §12): alguien eligió el pedido a
// mano; esto decide en qué salida va el tracking sin inventar nada.
const ID = { tracking: "2609756", emision: "26" };
const out = (o: Partial<OrderOutputForLink>): OrderOutputForLink => ({
  id: "s1",
  courier: "olva",
  deliveryStatus: "pendiente",
  olvaTracking: null,
  olvaEmision: null,
  ...o,
});

describe("dónde va el tracking que alguien vincula a mano", () => {
  it("pedido sin ninguna salida (#KP136585, «sin asignar courier»): se crea la de Olva", () => {
    expect(planOlvaLink([], ID)).toEqual({ kind: "create" });
    // Una salida de otro courier no es la de Olva.
    expect(planOlvaLink([out({ courier: "por_definir" })], ID)).toEqual({ kind: "create" });
  });

  it("una salida de Olva sin tracking («Carlos Carlos», #KP136660): va ahí", () => {
    expect(planOlvaLink([out({ id: "olva-1" })], ID)).toEqual({ kind: "set", shipmentId: "olva-1" });
  });

  it("ya lo tenía: no hace nada", () => {
    expect(planOlvaLink([out({ olvaTracking: "2609756", olvaEmision: "26" })], ID)).toEqual({ kind: "done" });
  });

  it("otro tracking en su salida de Olva: no lo pisa", () => {
    const r = planOlvaLink([out({ olvaTracking: "2600000", olvaEmision: "26" })], ID);
    expect(r).toMatchObject({ kind: "error", error: expect.stringContaining("2600000-26") });
  });

  it("dos salidas de Olva libres: no adivina cuál", () => {
    expect(planOlvaLink([out({ id: "a" }), out({ id: "b" })], ID)).toMatchObject({ kind: "error" });
  });

  it("una salida de Olva anulada no cuenta", () => {
    expect(planOlvaLink([out({ deliveryStatus: "anulado" })], ID)).toEqual({ kind: "create" });
  });
});
