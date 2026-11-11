import { describe, expect, it } from "vitest";
import { attributedProductHandle, buildProductMatcher, customerProductSignals, type ProductMessage } from "@/lib/lead-products";

const catalogue = [
  { handle: "aceite-negro", title: "SUPER HUMAN Ethiopian Black Seed Oil – Aceite de Semilla Negra Etíope Alta Potencia (60 Cápsulas)" },
  { handle: "astaxantina", title: "ASTAXANTINA – Antioxidante De Alta Potencia (120 Cápsulas)" },
  { handle: "cayenne", title: "Cayenne Pepper – Suplemento Botánico para Circulación Saludable" },
];
const msg = (text: string, extra: Partial<ProductMessage> = {}): ProductMessage => ({ text,
  direction: "inbound", at: "2026-11-10T14:00:00Z", id: "1", ...extra });
const match = buildProductMatcher(catalogue);

describe("producto consultado por el cliente", () => {
  it.each([
    ["Hola, información del aceite de semilla negra", "aceite-negro"],
    ["¿Precio de la ASTAXANTINA?", "astaxantina"],
    ["Tengo una consulta sobre Cayenne Pepper", "cayenne"],
    ["https://kenku.pe/products/aceite-negro?variant=12", "aceite-negro"],
    ["https://kenku.pe/product/astaxantina/", "astaxantina"],
    ["Hola quiero información", null],
    ["Tengo problemas de circulación", null],
    ["SUPERHUMAN", null],
    ["No quiero astaxantina", null],
    ["¿Tienen magnesio?", null],
    ["https://kenku.pe/products/desconocido", null],
  ])("%s → %s", (text, handle) => expect(match(msg(text))?.handle ?? null).toBe(handle));

  it("nunca toma recomendaciones salientes del bot", () => {
    expect(match(msg("Te recomiendo astaxantina", { direction: "outbound" }))).toBeNull();
  });
  it("no cruza el catálogo de otra tienda", () => {
    expect(buildProductMatcher([{ handle: "calzon", title: "Calzón Faja Modeladora" }])(msg("Astaxantina"))).toBeNull();
  });
  it("una mención compartida por dos presentaciones queda ambigua", () => {
    const shared = buildProductMatcher([...catalogue, { handle: "astaxantina-30", title: "ASTAXANTINA – 30 Cápsulas" }]);
    expect(shared(msg("Quiero astaxantina"))?.source).toBe("ambiguous");
    expect(shared(msg("ASTAXANTINA – 30 Cápsulas"))?.handle).toBe("astaxantina-30");
  });
  it("dos productos explícitos no elige arbitrariamente uno", () => {
    expect(match(msg("Astaxantina y Cayenne Pepper"))?.source).toBe("ambiguous");
  });
  it("distingue una alternativa del producto rechazado", () => {
    expect(match(msg("No quiero astaxantina, quiero Cayenne Pepper"))?.handle).toBe("cayenne");
  });
  it("conserva mensaje, evidencia y fecha; ordena cronológicamente", () => {
    const signals = customerProductSignals(catalogue, [msg("Astaxantina", { at: "2026-11-10T15:00:00Z", id: "later" }), msg("Black Seed Oil")]);
    expect(signals.map((s) => s.handle)).toEqual(["aceite-negro", "astaxantina"]);
    expect(signals[1]).toMatchObject({ message_id: "later", evidence: "Astaxantina", at: "2026-11-10T15:00:00.000Z", source: "customer_text" });
  });
  it("rechaza fechas inválidas", () => expect(match(msg("Astaxantina", { at: "?" }))).toBeNull());
});

describe("faceta de producto", () => {
  const entry = match(msg("Black Seed Oil"))!;
  const current = match(msg("Astaxantina"))!;
  it("separa entrada de interés sin cambiar el anuncio", () => {
    const lead = { entry_product: entry, interest_product: current };
    expect(attributedProductHandle(lead, "entry", null, "cayenne")).toBe("aceite-negro");
    expect(attributedProductHandle(lead, "current", null, "cayenne")).toBe("astaxantina");
  });
  it("una consulta ambigua no reaparece con el producto antiguo", () => {
    expect(attributedProductHandle({ interest_product: match(msg("Astaxantina y Cayenne Pepper")), last_product_handle: "aceite-negro" }, "current", null, null)).toBeNull();
  });
  it("respeta los links, carritos y declaraciones heredadas", () => {
    expect(attributedProductHandle({ last_product_handle: "cayenne", entry_product: entry }, "current", null, null)).toBe("cayenne");
    expect(attributedProductHandle({}, "entry", null, "cayenne")).toBe("cayenne");
  });
  it("los contadores y el filtrado usan la misma identidad", () => {
    const rows = [{ entry_product: entry }, { interest_product: current }, {}];
    const keys = rows.map((l) => attributedProductHandle(l, "current", null, null));
    const counts = new Map<string | null, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(rows.length);
    for (const [key, count] of counts) expect(keys.filter((k) => k === key)).toHaveLength(count);
  });
});
