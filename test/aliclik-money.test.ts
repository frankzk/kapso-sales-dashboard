import { describe, expect, it } from "vitest";
import { MAX_ACCEPTABLE_LOSS, linesTotal, reconcileToOrderTotal } from "@/lib/aliclik-money";

describe("reconcileToOrderTotal", () => {
  it("arregla el caso real: 3× S/149 con S/149 de descuento", () => {
    // Pedido #KP124759. Se creó la guía cobrando S/447 (3 × el precio de lista
    // de Shopify) cuando el Total del pedido era S/298.
    const r = reconcileToOrderTotal([{ quantity: 3, price: 149 }], 298);
    expect(r).not.toBeNull();
    // Con 3 unidades el total solo puede ser múltiplo de 3, así que 298 no es
    // alcanzable: se cobra S/297, el entero más alto sin pasarse.
    expect(r!.total).toBe(297);
    expect(r!.items[0]!.price).toBe(99);
    expect(r!.drift).toBe(-1);
  });

  it("el total SIEMPRE es un entero de soles", () => {
    for (const qty of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      for (const total of [99, 149, 199, 298, 347.5, 89.9, 1234.56]) {
        const r = reconcileToOrderTotal([{ quantity: qty, price: 100 }], total);
        if (!r) continue;
        expect(Number.isInteger(r.total)).toBe(true);
        expect(r.total).toBeLessThanOrEqual(total);
      }
    }
  });

  it("no toca nada cuando el pedido no lleva descuento y ya cuadra", () => {
    const r = reconcileToOrderTotal([{ quantity: 2, price: 50 }], 100);
    expect(r!.items[0]!.price).toBe(50);
    expect(r!.total).toBe(100);
    expect(r!.drift).toBe(0);
  });

  it("una unidad siempre cuadra exacto contra un total entero", () => {
    const r = reconcileToOrderTotal([{ quantity: 1, price: 149 }], 99);
    expect(r!.items[0]!.price).toBe(99);
    expect(r!.total).toBe(99);
  });

  it("dos unidades usan el céntimo del precio unitario para cuadrar un total impar", () => {
    // 149 / 2 = 74,50 — el precio unitario SÍ admite céntimos.
    const r = reconcileToOrderTotal([{ quantity: 2, price: 100 }], 149);
    expect(r!.items[0]!.price).toBe(74.5);
    expect(r!.total).toBe(149);
    expect(r!.drift).toBe(0);
  });

  it("reparte entre productos distintos y cuadra a entero", () => {
    const r = reconcileToOrderTotal(
      [
        { quantity: 1, price: 200 },
        { quantity: 1, price: 100 },
      ],
      150,
    );
    expect(r!.total).toBe(150);
    expect(linesTotal(r!.items)).toBe(150);
    // El caro sigue costando más que el barato: el reparto es proporcional.
    expect(r!.items[0]!.price).toBeGreaterThan(r!.items[1]!.price);
  });

  it("con varias líneas aprovecha una para absorber y no pierde soles", () => {
    // 3 unidades de uno + 1 del otro: la línea de 1 unidad puede absorber
    // cualquier resto, así que el total exacto SÍ es alcanzable.
    const r = reconcileToOrderTotal(
      [
        { quantity: 3, price: 100 },
        { quantity: 1, price: 100 },
      ],
      298,
    );
    expect(r!.total).toBe(298);
    expect(r!.drift).toBe(0);
  });

  it("nunca cobra de más, con ningún total ni cantidad", () => {
    for (let total = 1; total <= 600; total += 7) {
      for (const qty of [1, 2, 3, 4, 5, 6]) {
        const r = reconcileToOrderTotal([{ quantity: qty, price: 149 }], total);
        if (!r) continue;
        expect(r.total).toBeLessThanOrEqual(total);
        expect(r.drift).toBeLessThanOrEqual(0);
      }
    }
  });

  it("un total con céntimos se recorta hacia abajo, nunca hacia arriba", () => {
    const r = reconcileToOrderTotal([{ quantity: 1, price: 100 }], 149.9);
    expect(r!.total).toBe(149);
  });

  it("devuelve null si el total no se conoce — quien llama debe bloquear", () => {
    // Es el punto entero de esta función: ante la duda NO se manda el precio de
    // Shopify tal cual, porque es justo el que cobra de más.
    expect(reconcileToOrderTotal([{ quantity: 1, price: 10 }], null)).toBeNull();
    expect(reconcileToOrderTotal([{ quantity: 1, price: 10 }], 0)).toBeNull();
    expect(reconcileToOrderTotal([{ quantity: 1, price: 10 }], -5)).toBeNull();
    expect(reconcileToOrderTotal([], 100)).toBeNull();
    expect(reconcileToOrderTotal([{ quantity: 0, price: 10 }], 100)).toBeNull();
  });

  it("nunca deja un precio en cero o negativo", () => {
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

describe("reconcileToOrderTotal · tope de pérdida aceptable", () => {
  it("bloquea cuando habría que dejar de cobrar más del margen", () => {
    // 3 unidades y total 302: los alcanzables son múltiplos de 3 (300), así que
    // se perderían S/2. Por encima del tope ⇒ no se crea la guía.
    expect(reconcileToOrderTotal([{ quantity: 3, price: 149 }], 302)).toBeNull();
  });

  it("deja pasar lo que cabe justo en el margen", () => {
    // 298 con 3 unidades pierde S/1: cabe en S/1,20.
    const r = reconcileToOrderTotal([{ quantity: 3, price: 149 }], 298);
    expect(r!.total).toBe(297);
    expect(r!.drift).toBe(-1);
  });

  it("el margen es configurable para poder medir escenarios", () => {
    const r = reconcileToOrderTotal([{ quantity: 3, price: 149 }], 302, 3);
    expect(r!.total).toBe(300);
    expect(r!.drift).toBe(-2);
  });

  it("ninguna guía creada pierde más del margen, con ningún total ni cantidad", () => {
    for (let total = 1; total <= 900; total += 3) {
      for (const qty of [1, 2, 3, 4, 5, 6, 7, 8, 10, 15]) {
        const r = reconcileToOrderTotal([{ quantity: qty, price: 149 }], total);
        if (!r) continue; // bloqueado: correcto
        expect(-r.drift).toBeLessThanOrEqual(MAX_ACCEPTABLE_LOSS + 1e-9);
        expect(Number.isInteger(r.total)).toBe(true);
      }
    }
  });
});
