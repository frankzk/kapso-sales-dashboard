import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { lineSubtotal, orderTotals, totalUnits, totalsWorthShowing } from "@/lib/order-totals";

/**
 * El desglose de productos dice qué lleva el pedido y cuánto suma.
 *
 * Mostraba el título y «×1». La variante, el SKU y el precio estaban en
 * `OrderLineItem` desde siempre y la pantalla no los pintaba, así que para
 * responder «¿cuánto se cobra y por qué?» —mientras se confirma por teléfono—
 * había que abrir el admin de Shopify en otra pestaña.
 */

const bloque = readFileSync(resolve(process.cwd(), "components/order-line-items.tsx"), "utf8");
// La ficha del pedido (antes dentro de orders-master.tsx) es quien pinta las líneas.
const pedidos = readFileSync(resolve(process.cwd(), "components/order-drawer.tsx"), "utf8");
const envios = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");

describe("el subtotal de una línea es aritmética nuestra", () => {
  it("precio por cantidad", () => {
    expect(lineSubtotal({ price: 99, quantity: 2 })).toBe(198);
    expect(lineSubtotal({ price: 29.99, quantity: 1 })).toBeCloseTo(29.99, 2);
  });

  it("sin precio no se inventa un cero", () => {
    // Un cero se lee «es gratis»; la ausencia de precio es otra cosa.
    expect(lineSubtotal({ price: null, quantity: 3 })).toBeNull();
  });

  it("una cantidad negativa no resta", () => {
    expect(lineSubtotal({ price: 50, quantity: -2 })).toBe(0);
  });

  it("las unidades no son los productos", () => {
    expect(totalUnits([{ quantity: 2 }, { quantity: 3 }])).toBe(5);
    expect(totalUnits([])).toBe(0);
  });
});

describe("los importes del pedido se leen, no se recalculan", () => {
  it("la forma REST trae el desglose entero", () => {
    const t = orderTotals({
      subtotal_price: "99.00",
      total_discounts: "10.00",
      total_shipping_price_set: { shop_money: { amount: "0.00", currency_code: "PEN" } },
      total_price: "89.00",
    });
    expect(t).toEqual({ subtotal: 99, discounts: 10, shipping: 0, total: 89 });
  });

  it("la forma GraphQL no lo trae, y entonces el total cae al del Master", () => {
    // Es el 88% de los pedidos: `raw` solo tiene el total, en otra forma.
    const t = orderTotals({ totalPriceSet: { shopMoney: { amount: "99.00" } } }, 99);
    expect(t.subtotal).toBeNull();
    expect(t.shipping).toBeNull();
    expect(t.total).toBe(99);
  });

  it("un `raw` ausente o basura no rompe nada", () => {
    for (const raw of [null, undefined, 42, "hola", []]) {
      expect(() => orderTotals(raw, 10), String(raw)).not.toThrow();
      expect(orderTotals(raw, 10).total, String(raw)).toBe(10);
    }
  });
});

describe("el bloque de totales se calla cuando no puede cuadrar", () => {
  /**
   * La regla que importa: sin subtotal de Shopify no se rellena sumando
   * líneas. Medido, esa suma difiere del total en 7.949 de 21.017 pedidos
   * (38%), con S/ 101,51 de diferencia promedio.
   */
  it("sin subtotal de Shopify, no se pinta", () => {
    const soloTotal = orderTotals({ totalPriceSet: {} }, 200);
    expect(totalsWorthShowing(soloTotal, 1)).toBe(false);
    expect(totalsWorthShowing(soloTotal, 5)).toBe(false);
  });

  it("con subtotal y varias líneas, sí", () => {
    const t = orderTotals({ subtotal_price: "150.00", total_price: "150.00" });
    expect(totalsWorthShowing(t, 2)).toBe(true);
  });

  it("con una sola línea y nada que sumar, no repite lo de arriba", () => {
    const t = orderTotals({ subtotal_price: "99.00", total_price: "99.00" });
    expect(totalsWorthShowing(t, 1)).toBe(false);
  });

  it("pero una sola línea con descuento o con envío sí se explica", () => {
    const conDescuento = orderTotals({ subtotal_price: "99.00", total_discounts: "9.00", total_price: "90.00" });
    expect(totalsWorthShowing(conDescuento, 1)).toBe(true);
    const conEnvio = orderTotals({
      subtotal_price: "99.00",
      total_shipping_price_set: { shop_money: { amount: "15.00" } },
      total_price: "114.00",
    });
    expect(totalsWorthShowing(conEnvio, 1)).toBe(true);
  });
});

describe("qué muestra la fila", () => {
  it("la variante solo cuando existe", () => {
    // Viene en el 17,9% de los ítems: una línea fija quedaría vacía en cuatro
    // de cada cinco filas.
    expect(bloque).toContain("{item.variant_title && (");
  });

  it("el SKU y el precio unitario por cantidad", () => {
    expect(bloque).toContain("{item.sku && (");
    expect(bloque).toContain("`${soles(item.price)} × ${item.quantity}`");
  });

  it("hay hueco de miniatura, con la inicial mientras no haya foto", () => {
    // Shopify no manda imagen en el line item (0 de 15.726). El hueco se dibuja
    // igual para que traerla sea un cambio de datos, no un rediseño.
    expect(bloque).toContain("function Thumb(");
    expect(bloque).toContain('aria-hidden="true"');
  });

  it("un envío en cero dice «Gratis», que es información", () => {
    expect(bloque).toContain('totals.shipping === 0 ? "Gratis"');
  });
});

describe("un solo bloque para las dos pantallas", () => {
  it("Pedidos y Envíos usan el mismo componente", () => {
    expect(pedidos).toContain("<OrderLineItems items={detail.lineItems} totals={detail.totals} />");
    expect(envios).toContain("<OrderLineItems items={order.line_items}");
  });

  it("y ninguna conserva su lista escrita a mano", () => {
    // Estaban escritas dos veces y ya habían divergido: Envíos mostraba el SKU
    // y Pedidos no.
    expect(pedidos).not.toContain("×{li.quantity}");
    expect(envios).not.toContain("{item.quantity}×");
  });

  it("el payload de Shopify no cruza al navegador", () => {
    // Pesa decenas de kB por pedido; al cliente van cuatro cifras resueltas.
    // El componente no recibe `raw` ni lo parsea: recibe los totales hechos.
    expect(bloque).toContain("totals?: OrderTotals | null;");
    expect(bloque).not.toMatch(/\braw\s*[?:]/);
    expect(bloque).not.toContain("orderTotals(");
  });
});
