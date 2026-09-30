import { describe, it, expect } from "vitest";
import { cartsInWindow } from "@/lib/leads-ingest";

// cart_count_48h (0207): carritos de la clienta en las 48 h que terminan en el
// carrito de la fila. Es la señal que sube la prioridad en lib/lead-priority.ts.
describe("cartsInWindow", () => {
  const cart = "2026-09-29T10:00:00+00:00";

  it("cuenta los carritos de las 48 h anteriores, incluido el propio", () => {
    expect(
      cartsInWindow(cart, [
        "2026-09-27T10:00:00+00:00", // justo 48 h antes: cuenta
        "2026-09-28T20:00:00+00:00",
        cart,
      ]),
    ).toBe(3);
  });

  it("no cuenta los de antes de la ventana ni los posteriores al carrito", () => {
    expect(
      cartsInWindow(cart, [
        "2026-09-27T09:59:00+00:00", // 48 h y un minuto antes
        cart,
        "2026-09-29T11:00:00+00:00", // después: no se sabía al armar este
      ]),
    ).toBe(1);
  });

  it("compara instantes, no texto: -05:00 contra +00:00", () => {
    // 20:00 del 28 en Lima = 01:00Z del 29: dentro de la ventana.
    expect(cartsInWindow(cart, ["2026-09-28T20:00:00-05:00", cart])).toBe(2);
  });

  it("nunca menos de 1: el carrito de la fila existe aunque la consulta no lo traiga", () => {
    expect(cartsInWindow(cart, [])).toBe(1);
    expect(cartsInWindow(null, ["2026-09-28T20:00:00+00:00"])).toBe(1);
  });
});
