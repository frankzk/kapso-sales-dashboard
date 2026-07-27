import { describe, expect, it } from "vitest";
import {
  MAX_ACCEPTABLE_LOSS,
  collectAmountMismatch,
  linesTotal,
  reconcileToOrderTotal,
} from "@/lib/aliclik-money";

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
    // 6 unidades y total 302,40: los alcanzables son múltiplos de 3 (300), así
    // que se perderían S/2,40. Por encima del techo ⇒ no se crea la guía. Es el
    // único caso de los 6.541 pedidos pendientes que queda bloqueado.
    expect(reconcileToOrderTotal([{ quantity: 6, price: 100 }], 302.4)).toBeNull();
  });

  it("deja pasar los S/2 justos, que es el peor caso aceptado", () => {
    const r = reconcileToOrderTotal([{ quantity: 3, price: 149 }], 302);
    expect(r!.total).toBe(300);
    expect(r!.drift).toBe(-2);
  });

  it("el margen es configurable para poder medir escenarios", () => {
    const r = reconcileToOrderTotal([{ quantity: 6, price: 100 }], 302.4, 3);
    expect(r!.total).toBe(300);
    expect(r!.drift).toBe(-2.4);
  });

  it("minimiza: se queda con el PRIMER importe representable, no con uno cualquiera", () => {
    // Con 3 unidades y total 299, los múltiplos de 3 por debajo son 297, 294,
    // 291… Tiene que elegir 297 (pierde S/2), nunca uno más bajo.
    const r = reconcileToOrderTotal([{ quantity: 3, price: 100 }], 299);
    expect(r!.total).toBe(297);
  });

  it("no se rinde en multi-línea: ajusta otra línea para cuadrar sin bajar el total", () => {
    // 2 y 3 unidades: el reparto proporcional inicial no tiene por qué dejar un
    // resto divisible entre 3, pero quitando céntimos a la línea de 2 sí cuadra.
    // Sin ese ajuste el algoritmo bajaba un sol y perdía dinero de más.
    const r = reconcileToOrderTotal(
      [
        { quantity: 2, price: 100 },
        { quantity: 3, price: 100 },
      ],
      499,
    );
    expect(r!.total).toBe(499);
    expect(r!.drift).toBe(0);
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

describe("reconcileToOrderTotal · minimiza de verdad", () => {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

  // Un total entero T es alcanzable si y solo si 100·T es divisible por el MCD
  // de las cantidades: los importes que se pueden formar son las combinaciones
  // enteras de `precio_en_céntimos × cantidad`. Esta prueba afirma que SIEMPRE
  // que sea alcanzable, el algoritmo lo encuentra — o sea, que nunca se pierde
  // dinero por rendirse antes de tiempo, solo cuando es inevitable.
  it("cuando el total exacto es alcanzable, lo encuentra", () => {
    let checked = 0;
    for (const q1 of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const q2 of [1, 2, 3, 4, 5, 6, 7, 8]) {
        for (let total = 60; total <= 500; total += 7) {
          if ((100 * total) % gcd(q1, q2) !== 0) continue;
          checked++;
          const r = reconcileToOrderTotal(
            [
              { quantity: q1, price: 100 },
              { quantity: q2, price: 60 },
            ],
            total,
            99,
          );
          expect(r, `q=[${q1},${q2}] total=${total}`).not.toBeNull();
          expect(r!.drift, `q=[${q1},${q2}] total=${total}`).toBe(0);
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it("una sola línea da el múltiplo más alto que cabe, no uno cualquiera", () => {
    // Con 3 unidades solo hay múltiplos de 3: de 299 el mejor es 297.
    expect(reconcileToOrderTotal([{ quantity: 3, price: 100 }], 299)!.total).toBe(297);
    expect(reconcileToOrderTotal([{ quantity: 3, price: 100 }], 300)!.total).toBe(300);
    expect(reconcileToOrderTotal([{ quantity: 3, price: 100 }], 301)!.total).toBe(300);
  });
});

describe("collectAmountMismatch", () => {
  it("avisa cuando Aliclik cobra de MÁS, aunque sea poco", () => {
    // El fallo original: guía a S/447 sobre un pedido de S/298.
    const m = collectAmountMismatch(447, 298);
    expect(m?.kind).toBe("cobra_de_mas");
    expect(m?.gap).toBe(149);
    expect(m?.message).toContain("DE MÁS");
  });

  it("un solo céntimo de más ya es un descuadre", () => {
    // Por encima del total no hay excusa: la clienta paga más de lo que se le
    // dijo, y en contraentrega lo descubre con el paquete delante.
    expect(collectAmountMismatch(298.01, 298)?.kind).toBe("cobra_de_mas");
  });

  it("no avisa por la diferencia que nosotros mismos generamos al redondear", () => {
    // Aliclik solo cobra enteros: bajar hasta S/2 es nuestro comportamiento
    // normal, no un fallo que merezca alerta.
    expect(collectAmountMismatch(297, 298)).toBeNull();
    expect(collectAmountMismatch(296, 298)).toBeNull();
  });

  it("avisa cuando cobra MENOS de lo que el redondeo puede explicar", () => {
    const m = collectAmountMismatch(290, 298);
    expect(m?.kind).toBe("cobra_de_menos");
    expect(m?.gap).toBe(8);
  });

  it("cuadra exacto no es descuadre", () => {
    expect(collectAmountMismatch(298, 298)).toBeNull();
  });

  it("sin dato de Aliclik o sin total del pedido, no inventa una alerta", () => {
    expect(collectAmountMismatch(null, 298)).toBeNull();
    expect(collectAmountMismatch(298, null)).toBeNull();
    expect(collectAmountMismatch(0, 298)).toBeNull();
    expect(collectAmountMismatch(298, 0)).toBeNull();
  });
});
