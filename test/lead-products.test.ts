import { describe, expect, it } from "vitest";
import { attributedProductHandle, buildProductMatcher, customerProductSignals, mergeLeadProductCatalog, productTitleText, clarifyAmbiguousProduct, type ProductMessage } from "@/lib/lead-products";

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

describe("barrido de catálogo: nombres de campañas y migración de tienda", () => {
  const seven = [
    { query: "HeatLessCurls", handle: "rizador-de-cabello-sin-calor-con-accesorios", title: "HeatLessCurls – Pack de 2 Rizadores de Cabello sin Calor con Accesorios" },
    { query: "RestPro", handle: "restpro-almohada-de-traccion-inversa", title: "RestPro: Almohada de Tracción Inversa Ergonómica para un Descanso Óptimo" },
    { query: "Bolso Charlotte", handle: "bolso-de-hombro-charlotte-con-diseno-moderno-a-cuadros-con-gran-capacidad", title: "Bolso de Hombro Charlotte con Diseño Moderno a Cuadros con Gran Capacidad" },
    { query: "UROCONTROL", handle: "urocontrol-control-de-vejiga-y-urgencia-urinaria-60-capsulas", title: "UROCONTROL – Control de Vejiga y Urgencia Urinaria (60 cápsulas)" },
    { query: "Cayenne", handle: "sovexa-cayenne-pepper-suplemento-botanico-para-circulacion-saludable-60-capsulas", title: "Cayenne Pepper – Suplemento Botánico para Circulación Saludable" },
    { query: "Prozenix", handle: "prozenith-pro-capsules-capsulas-metabolicas-para-control-de-antojos-y-bienestar-metabolico-60-capsulas-superhuman", title: "Prozenix Pro Lipozem Capsules – Cápsulas Metabólicas para Control de Antojos" },
    { query: "Turkesterone", handle: "turkesterone-capsulas-de-ajuga-turkestanica-con-tongkat-ali-para-resistencia-fuerza-y-vitalidad-masculina-120-capsulas-superhuman", title: "Turkesterone – Cápsulas de Ajuga Turkestanica con Tongkat Ali" },
  ];
  it.each(seven)("reconoce el nombre corto de $handle sin exigir el subtítulo", p => {
    expect(buildProductMatcher(seven)(msg(`Hola, quiero información de ${p.query}`))?.handle).toBe(p.handle);
  });
  it("respeta rechazos, nombres personales y ambigüedades entre los siete productos", () => {
    const resolve = buildProductMatcher(seven);
    expect(resolve(msg("Hola, soy Charlotte"))).toBeNull();
    expect(resolve(msg("Quiero una almohada o un bolso"))).toBeNull();
    expect(resolve(msg("No quiero RestPro, quiero HeatLessCurls"))?.handle).toBe(seven[0]!.handle);
    expect(resolve(msg("RestPro y HeatLessCurls"))?.source).toBe("ambiguous");
    expect(buildProductMatcher([...seven, { ...seven[0]!, handle: "heatless-otro" }])(msg("HeatLessCurls"))?.source).toBe("ambiguous");
  });
  const magic = { handle: "aceite-corporal-magic-100-ml", title: "Aceite Corporal Magic™ &#8211; 100 ml: Rellena, Tensa, Reafirma e Hidrata tu Piel" };
  const biru = { handle: "shampoo-biru-anticaspa-ideaslabco", title: "Shampoo Biru™ Anticaspa con Menta y Té Verde – Purifica y Refresca el Cuero Cabelludo &#8211; IdeasLabCo™" };
  const magnesium = { handle: "magnesio-puro", title: "Magnesio Puro – Spray Corporal de Magnesio de Grado Terapéutico (237 ml)" };
  const twelve = { handle: "magnesio-12-en-1", title: "Magnesio 12 en 1 Complex – Cápsulas para Energía, Relajación Muscular y Bienestar Integral" };
  const resolved = buildProductMatcher([magic, biru, magnesium, twelve]);
  it("reconoce Icefit sin exigir el subtítulo del catálogo y conserva ambigüedades", () => {
    const ice = { handle: "icefit-molde-de-hielo", title: "IceFit &#8211; Molde de Hielo Compatible con Termo y Tomatodo Stanley" };
    const resolve = buildProductMatcher([ice, biru]);
    expect(resolve(msg("Hola, quiero información del IceFit"))?.handle).toBe(ice.handle);
    expect(resolve(msg("¿Precio de Ice fit?"))?.handle).toBe(ice.handle);
    expect(resolve(msg("Icefit y Shampoo Biru"))?.source).toBe("ambiguous");
    expect(resolve(msg("Necesito hielo"))).toBeNull();
    expect(buildProductMatcher([ice, { ...ice, handle: "icefit-otro" }])(msg("Icefit"))?.source).toBe("ambiguous");
  });
  it.each([
    ["Hola, quiero información del Aceite Magic", magic.handle],
    ["Quiero más información sobre el Shampoo Biru", biru.handle],
    ["¿Cuánto está Biru?", biru.handle],
    ["Hola información de Magnesio Puro", magnesium.handle],
    ["Quiero magnesio en spray", magnesium.handle],
    ["Quiero Magnesio 12 en 1", twelve.handle],
    ["Quiero magnesio", null],
  ])("reconoce %s sin inventar una presentación", (text, handle) => expect(resolved(msg(text))?.handle ?? null).toBe(handle));
  it("une el slug histórico con ™ y el actual sin duplicar el producto", () => {
    const products = mergeLeadProductCatalog([{ ...magic, handle: "aceite-corporal-magic™-100-ml", title: productTitleText(magic.title) }], [magic]);
    expect(products).toHaveLength(1);
    const m = buildProductMatcher(products);
    expect(m(msg("Aceite Magic"))?.handle).toBe(magic.handle);
    expect(m(msg("https://kenku.pe/products/aceite-corporal-magic%E2%84%A2-100-ml"))?.handle).toBe(magic.handle);
  });
  it("decodifica entidades HTML antes de comparar identidades y nombres", () => {
    expect(productTitleText("Biru&trade; &#8211; Menta &amp; T&eacute;" )).toContain("Biru™ – Menta &");
    expect(mergeLeadProductCatalog([{ ...biru, title: productTitleText(biru.title) }], [biru])).toHaveLength(1);
  });
  it("dos productos actuales distintos de nombre idéntico siguen ambiguos", () => {
    const products = mergeLeadProductCatalog([biru], [biru, { ...biru, handle: "other-biru" }]);
    expect(products).toHaveLength(2);
    expect(buildProductMatcher(products)(msg("Shampoo Biru"))?.source).toBe("ambiguous");
  });
  it("un enlace concreto desambigua el nombre compartido de dos presentaciones", () => {
    const variants = [biru, { handle: "biru-30", title: "Shampoo Biru – 30 ml" }];
    expect(buildProductMatcher(variants)(msg(`Quiero shampoo biru https://kenku.pe/products/${biru.handle}`))?.handle).toBe(biru.handle);
  });
  it("solo aclara evidencia ambigua cuando conserva el texto completo", () => {
    const old = { ...resolved(msg("Shampoo Biru"))!, source: "ambiguous" as const, handle: null, title: null };
    expect(clarifyAmbiguousProduct(old, resolved)?.handle).toBe(biru.handle);
    expect(clarifyAmbiguousProduct({ ...old, evidence: "Shampoo Biru".padEnd(400, " ") }, resolved)?.handle).toBeNull();
    expect(clarifyAmbiguousProduct({ ...old, evidence: "Shampoo Biru y Aceite Magic" }, resolved)?.handle).toBeNull();
  });
  it("no une tamaños diferentes ni archivos de una misma plataforma por título", () => {
    const sizes = [{ handle: "biru-100", title: "Shampoo Biru – 100 ml" }, { handle: "biru-200", title: "Shampoo Biru – 200 ml" }];
    expect(mergeLeadProductCatalog(sizes, sizes)).toHaveLength(2);
    expect(mergeLeadProductCatalog([biru, { ...biru, handle: "other" }], [])).toHaveLength(2);
  });
});
