import { describe, expect, it } from "vitest";
import { shopifyOrderNote } from "@/lib/shopify-address";

// LA NOTA DEL PEDIDO.
//
// Es texto libre, pero en la operación no es un adorno: es donde la asesora
// apunta lo que Shopify no tiene dónde guardar. El caso que lo motivó
// (#KP128879) decía «dni 42771213 shalom SAN JUAN DE MARCONA» — el documento del
// destinatario y la agencia de destino, que son los dos datos que el modal de
// Shalom pide a mano porque «el pedido no los trae». Los traía.
//
// Lo que se fija acá es que se devuelve TAL CUAL y que los vacíos de Shopify no
// se cuelan como si fueran una nota: un bloque con una cadena en blanco pintaría
// un recuadro vacío en cada pedido que no la usa.

describe("shopifyOrderNote — la nota, sin interpretar", () => {
  it("devuelve la nota tal como se escribió", () => {
    expect(shopifyOrderNote({ note: "dni 42771213 shalom SAN JUAN DE MARCONA" })).toBe(
      "dni 42771213 shalom SAN JUAN DE MARCONA",
    );
  });

  it("conserva los saltos de línea de quien la escribió", () => {
    // El drawer los pinta con `whitespace-pre-wrap`; si se normalizaran acá, esa
    // decisión de presentación se perdería antes de llegar.
    expect(shopifyOrderNote({ note: "dni 42771213\nagencia: SAN JUAN DE MARCONA" })).toBe(
      "dni 42771213\nagencia: SAN JUAN DE MARCONA",
    );
  });

  it("recorta los bordes pero no toca el interior", () => {
    expect(shopifyOrderNote({ note: "  dni 42771213  " })).toBe("dni 42771213");
  });

  it("una nota vacía es NO HAY NOTA, no una nota en blanco", () => {
    // Shopify manda `""` cuando el campo se dejó vacío, y `null` cuando nunca se
    // tocó. Las dos tienen que dar lo mismo, o el recuadro aparecería vacío.
    expect(shopifyOrderNote({ note: "" })).toBeNull();
    expect(shopifyOrderNote({ note: "   " })).toBeNull();
    expect(shopifyOrderNote({ note: null })).toBeNull();
    expect(shopifyOrderNote({})).toBeNull();
  });

  it("aguanta un payload que no es un objeto", () => {
    // `orders.raw` es `unknown`: puede faltar, o llegar como cualquier cosa si
    // una fila vieja se guardó de otra forma.
    expect(shopifyOrderNote(null)).toBeNull();
    expect(shopifyOrderNote(undefined)).toBeNull();
    expect(shopifyOrderNote("una cadena")).toBeNull();
    expect(shopifyOrderNote({ note: 42 })).toBeNull();
  });
});
