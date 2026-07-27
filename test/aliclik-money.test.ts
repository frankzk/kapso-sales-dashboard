import { describe, expect, it } from "vitest";
import { linesTotal, reconcileToOrderTotal } from "@/lib/aliclik-money";

describe("reconcileToOrderTotal", () => {
  it("arregla el caso real: 3× S/149 con S/149 de descuento debe cobrar S/298", () => {
    // Pedido #KP124759. Se creó la guía cobrando S/447 (3 × el precio de lista
    // de Shopify) cuando el Total del pedido era S/298.
    const r = reconcileToOrderTotal([{ quantity: 3, price: 149 }], 298);
    expect(r).not.toBeNull();
    // 298 / 3 = 99,3333… no es alcanzable con un precio unitario de 2 decimales,
    // así que se queda a un céntimo POR DEBAJO. Nunca por encima.
    expect(r!.total).toBe(297.99);
    expect(r!.drift).toBe(-0.01);
    expect(r!.total).toBeLessThanOrEqual(298);
  });

  it("no toca nada cuando el pedido no lleva descuento", () => {
    const r = reconcileToOrderTotal([{ quantity: 2, price: 50 }], 100);
    expect(r!.items[0]!.price).toBe(50);
    expect(r!.total).toBe(100);
  });

  it("reparte proporcionalmente entre productos de precios distintos", () => {
    // 200 + 100 = 300 de subtotal, total real 150 ⇒ mitad de precio cada uno.
    const r = reconcileToOrderTotal(
      [
        { quantity: 1, price: 200 },
        { quantity: 1, price: 100 },
      ],
      150,
    );
    expect(r!.items[0]!.price).toBe(100);
    expect(r!.items[1]!.price).toBe(50);
    expect(r!.total).toBe(150);
  });

  it("cuando el céntimo no es repartible, se queda por debajo — jamás por encima", () => {
    // 100 / 3 = 33,333… — el redondeo por línea nunca sumaría 100 solo.
    const r = reconcileToOrderTotal([{ quantity: 3, price: 40 }], 100);
    expect(r!.total).toBe(99.99);
    expect(r!.drift).toBe(-0.01);
  });

  it("cuadra también cuando el total SUBE respecto al subtotal (envío cobrado)", () => {
    const r = reconcileToOrderTotal([{ quantity: 1, price: 90 }], 100);
    expect(r!.items[0]!.price).toBe(100);
    expect(r!.total).toBe(100);
  });

  it("devuelve null si el total del pedido no se conoce — quien llama debe bloquear", () => {
    // Es el punto entero de esta función: ante la duda NO se manda el precio de
    // Shopify tal cual, porque es justo el que cobra de más.
    expect(reconcileToOrderTotal([{ quantity: 1, price: 10 }], null)).toBeNull();
    expect(reconcileToOrderTotal([{ quantity: 1, price: 10 }], 0)).toBeNull();
    expect(reconcileToOrderTotal([{ quantity: 1, price: 10 }], -5)).toBeNull();
    expect(reconcileToOrderTotal([], 100)).toBeNull();
  });

  it("nunca deja un precio negativo o cero", () => {
    const r = reconcileToOrderTotal(
      [
        { quantity: 1, price: 1000 },
        { quantity: 1, price: 1 },
      ],
      2,
    );
    for (const i of r!.items) expect(i.price).toBeGreaterThan(0);
  });

  it("linesTotal calcula como Aliclik: suma de precio × cantidad", () => {
    expect(linesTotal([{ quantity: 3, price: 149 }])).toBe(447);
  });
});

describe("reconcileToOrderTotal · nunca cobra de más", () => {
  // El redondeo al más cercano se pasaría: 200/3 = 66,6667 → 66,67 × 3 = 200,01.
  // Cobrar un céntimo de más es un error de caja para la clienta y para nosotros.
  it("no se pasa cuando el redondeo al más cercano sí lo haría", () => {
    // Con 3 unidades solo son alcanzables los múltiplos de 0,03: el más cercano
    // por debajo de 200 es 199,98 (66,66 × 3), no 199,99.
    const r = reconcileToOrderTotal([{ quantity: 3, price: 100 }], 200);
    expect(r!.total).toBeLessThanOrEqual(200);
    expect(r!.total).toBe(199.98);
  });

  it("en ningún reparto el total supera el del pedido", () => {
    for (let total = 1; total <= 600; total += 7) {
      for (const qty of [1, 2, 3, 4, 5, 6]) {
        const r = reconcileToOrderTotal([{ quantity: qty, price: 149 }], total);
        if (!r) continue;
        expect(r.total).toBeLessThanOrEqual(total);
        // Y nunca se aleja más de lo que un céntimo por unidad puede explicar.
        expect(total - r.total).toBeLessThan(qty * 0.01 + 1e-9);
      }
    }
  });
});
