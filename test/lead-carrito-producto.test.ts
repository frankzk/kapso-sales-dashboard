import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cartProductHandle } from "@/lib/leads-ingest";
import { productHandleOf } from "@/lib/shopify";
import type { OrderLineItem } from "@/lib/types";

/**
 * EL PRODUCTO DEL CARRITO, POR HANDLE Y NO POR TÍTULO.
 *
 * EL CASO REAL. Los leads con carrito o navegación abandonada caían en «Sin
 * producto» aunque son los que más claro tienen qué quieren. Lo único que
 * guardábamos de ellos era `cart_summary`, un TÍTULO:
 *
 *   carrito:  «Nails Repairing – Sérum Tea Tree Ginger para Uñas (30ml)»
 *   link:     nails-repairing-suero-reparador-de-unas
 *
 * El mismo producto escrito de dos maneras. Emparejar título con handle es
 * adivinar, y juntar mal dos productos manda a la asesora con el argumentario
 * equivocado. Así que el handle se le pide a quien lo tiene: Shopify.
 */

const item = (over: Partial<OrderLineItem> = {}): OrderLineItem => ({
  title: "Producto",
  quantity: 1,
  sku: null,
  product_id: null,
  variant_id: null,
  price: null,
  ...over,
});

describe("el handle viene de Shopify, no se deriva del título", () => {
  it("lo lee del borrador, donde cuelga de `product`", () => {
    expect(productHandleOf({ product: { handle: "beewax-cera-de-abeja" } })).toBe(
      "beewax-cera-de-abeja",
    );
  });

  it("y del pedido, donde cuelga de `variant.product`", () => {
    // Las dos formas existen en la API y las dos tienen que servir: si solo se
    // leyera una, la mitad de los carritos se quedaría sin producto y nadie
    // sabría por qué.
    expect(productHandleOf({ variant: { product: { handle: "softflex" } } })).toBe("softflex");
  });

  it("normaliza a minúsculas para empatar con el del link", () => {
    // Todo el objetivo es que el carrito y la ficha caigan en el MISMO balde.
    expect(productHandleOf({ product: { handle: "  SoftFlex  " } })).toBe("softflex");
  });

  it("sin handle devuelve null, no una cadena vacía", () => {
    // Una cadena vacía se cuela como valor y abre un balde sin nombre.
    expect(productHandleOf({ product: { handle: "" } })).toBeNull();
    expect(productHandleOf({})).toBeNull();
    expect(productHandleOf(null)).toBeNull();
  });
});

describe("un carrito de un solo producto lo dice; uno de tres, no", () => {
  it("con un producto, ese es el handle", () => {
    expect(cartProductHandle([item({ product_handle: "beewax" })])).toBe("beewax");
  });

  it("dos líneas del MISMO producto siguen siendo uno", () => {
    // Dos tallas del mismo producto son dos líneas y un solo producto.
    expect(
      cartProductHandle([item({ product_handle: "softflex" }), item({ product_handle: "softflex" })]),
    ).toBe("softflex");
  });

  it("con productos DISTINTOS no elige ninguno", () => {
    // Elegir uno de tres sería decir que el lead quiere ese, cuando lo que se
    // sabe es que quiere tres. `cart_summary` los sigue nombrando a todos para
    // quien llama; lo que no se hace es fingir una respuesta única.
    expect(
      cartProductHandle([item({ product_handle: "beewax" }), item({ product_handle: "softflex" })]),
    ).toBeNull();
  });

  it("un carrito sin handles no inventa", () => {
    expect(cartProductHandle([item({ title: "Beewax Cera de Abeja" })])).toBeNull();
    expect(cartProductHandle([])).toBeNull();
  });
});

describe("las piezas en el código", () => {
  const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

  it("la consulta de borradores PIDE el handle", () => {
    // Sin este campo en el GraphQL, todo lo demás es correcto y no llega nada.
    const source = read("lib/shopify.ts");
    const start = source.indexOf("export function buildDraftOrdersQuery(");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain("product { handle }");
  });

  it("el carrito escribe en SU columna, no en la del último enlazado", () => {
    // Son dos escritores distintos —la sync de conversaciones y la de
    // borradores— y no llegan en orden garantizado. Compartiendo columna, un
    // carrito viejo borraría el link que el cliente mandó esta mañana.
    const source = read("lib/leads-ingest.ts");
    expect(source).toContain("cart_product_handle: cartProductHandle(d.line_items)");
    const start = source.indexOf("async function upsertDraftCartLead(");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).not.toContain("last_product_handle");
  });

  it("el Flow de navegación NO deriva el handle del título", () => {
    // Quitar tildes y cambiar espacios por guiones daría un handle plausible y
    // falso, que se junta con el balde equivocado sin que nadie lo note.
    const source = read("lib/leads-ingest.ts");
    const start = source.indexOf("function browseProductHandle(");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain("productHandle");
    expect(body).not.toContain("productTitle");
    expect(body).not.toMatch(/normalize|replace\(\/\\s/);
  });

  it("la cola lo consulta después del último link y antes del primer mensaje", () => {
    // Después del link porque ese es más reciente; antes del primer mensaje
    // porque el carrito es posterior a la apertura de la conversación.
    const source = read("components/leads.tsx");
    expect(source).toMatch(
      /\(l\.last_product_handle \?\? ""\)\.trim\(\) \|\|[\s\S]{0,400}?\(l\.cart_product_handle \?\? ""\)\.trim\(\) \|\|[\s\S]{0,300}?leadProductHandle\(l\.first_inbound_text\)/,
    );
  });

  it("y la columna sobrevive a que la migración no haya corrido", () => {
    // Sin esto la cola entera se dibuja VACÍA entre el deploy y la migración.
    // Ya pasó una vez en este repo.
    expect(read("lib/leads-access.ts")).toMatch(
      /COLUMNAS_CON_MIGRACION_PENDIENTE[\s\S]{0,200}"cart_product_handle"/,
    );
  });
});
