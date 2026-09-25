import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProductos, productosSinVinculo } from "@/lib/swayp-productos";
import { buildOrderRoutePlan } from "@/lib/order-route-plan";
import { evaluateDirectFenixStock } from "@/lib/fenix";

/**
 * «Stock Swayp disponible para todo el pedido» sobre un producto que Swayp no
 * conoce.
 *
 * #KP134541, 15-09-2026. Lima no lleva control de cantidad, así que el stock
 * siempre sale en verde; lo que de verdad decide es el vínculo del catálogo, y
 * nadie lo preguntaba hasta dentro de la llamada a la API. Ahí fallaba, el flujo
 * caía al código local y la guía se creaba igual: una caja despachada contra un
 * número que Swayp nunca emitió.
 */

const PULSERA = { title: "Pulsera Magnética de Cobre Saludable", quantity: 1, sku: "5463456456" };
/** El mapa real de Kenku tenía la pulsera, pero con OTRO SKU (otra variante). */
const MAPA = new Map([["64565434", { codbar: "AURE018", nombre: "PULSERA MAGNÉTICA" }]]);

describe("productosSinVinculo", () => {
  it("el caso de #KP134541: el producto existe en el mapa con otro SKU y no cuenta", () => {
    expect(productosSinVinculo([PULSERA], MAPA)).toEqual([
      "Pulsera Magnética de Cobre Saludable",
    ]);
  });

  it("con el SKU vinculado no falta nada", () => {
    expect(productosSinVinculo([{ ...PULSERA, sku: "64565434" }], MAPA)).toEqual([]);
  });

  it("normaliza el SKU igual que el mapa: espacios y minúsculas no separan", () => {
    expect(productosSinVinculo([{ ...PULSERA, sku: " 64565434 " }], MAPA)).toEqual([]);
  });

  it("una línea sin SKU falta: no hay nada que buscar", () => {
    expect(productosSinVinculo([{ title: "Algo", quantity: 1, sku: null }], MAPA)).toEqual(["Algo"]);
  });

  it("sin título se nombra por el SKU, y sin ninguno de los dos se dice así", () => {
    expect(productosSinVinculo([{ title: "", quantity: 1, sku: "XYZ" }], MAPA)).toEqual(["XYZ"]);
    expect(productosSinVinculo([{ title: "", quantity: 1, sku: null }], MAPA)).toEqual([
      "(producto sin nombre)",
    ]);
  });

  /**
   * EL INTERRUPTOR. Una tienda que todavía no vinculó nada no puede quedarse sin
   * poder crear guías el día del despliegue; es la misma regla que ya gobernaba
   * `buildProductos`.
   */
  it("mapa vacío o ausente = función apagada, no «todo falta»", () => {
    expect(productosSinVinculo([PULSERA], new Map())).toEqual([]);
    expect(productosSinVinculo([PULSERA], null)).toEqual([]);
    expect(productosSinVinculo([PULSERA], undefined)).toEqual([]);
  });

  it("nombra EXACTAMENTE los mismos productos que la reja de la API", () => {
    const armados = buildProductos([PULSERA, { ...PULSERA, sku: "64565434" }], MAPA);
    expect(armados.ok).toBe(false);
    if (armados.ok) return;
    expect(armados.faltan).toEqual(productosSinVinculo([PULSERA, { ...PULSERA, sku: "64565434" }], MAPA));
  });
});

describe("en Lima el stock nunca dice que no, y por eso el vínculo es lo que decide", () => {
  it("evaluateDirectFenixStock da luz verde con la tabla vacía", () => {
    // No es un fallo: la bodega de Lima repone sola y no lleva renglones. Es la
    // razón por la que el panel salía en verde con la pulsera sin vincular.
    const check = evaluateDirectFenixStock("lima", [], [PULSERA]);
    expect(check.ok).toBe(true);
    expect(check.uncovered).toEqual([]);
  });

  it("la mesa de ruta bloquea Swayp por el vínculo aunque el stock esté OK", () => {
    const plan = buildOrderRoutePlan({
      operation: "lima",
      outputs: [],
      swayp: {
        known: true,
        city: "lima",
        covered: true,
        stockOk: true,
        uncovered: [],
        unlinked: ["Pulsera Magnética de Cobre Saludable"],
      },
    });
    const swayp = plan.candidates.find((c) => c.key === "swayp")!;
    expect(swayp.availability).toBe("blocked");
    expect(swayp.reason).toContain("Pulsera Magnética de Cobre Saludable");
    expect(swayp.reason).toContain("Catálogo de productos");
    expect(swayp.recommended).toBe(false);
  });

  it("sin productos sin vincular, la tarjeta vuelve a ofrecerse", () => {
    const plan = buildOrderRoutePlan({
      operation: "lima",
      outputs: [],
      swayp: { known: true, city: "lima", covered: true, stockOk: true, uncovered: [], unlinked: [] },
    });
    expect(plan.candidates.find((c) => c.key === "swayp")!.availability).not.toBe("blocked");
  });
});

describe("el modal avisa y apaga el botón", () => {
  const ui = readFileSync(resolve(process.cwd(), "components/direct-fenix-guide-modal.tsx"), "utf8");

  it("el botón de crear exige que no falte ningún vínculo", () => {
    expect(ui).toContain("const blockedByLink = !!preview && preview.unlinked.length > 0;");
    expect(ui).toContain("!blockedByLink");
  });

  it("hay una alerta propia, no solo la columna de la lista", () => {
    expect(ui).toContain("no están en el inventario de Swayp");
    expect(ui).toContain("Catálogo de productos");
  });

  it("cada producto sin vínculo se marca en su renglón", () => {
    expect(ui).toContain("✗ sin vínculo Swayp");
  });

  it("y el resumen ya no puede decir «disponible» con un vínculo faltando", () => {
    expect(ui).toContain("preview.stockOk && !blockedByLink");
  });
});

/**
 * LA REGLA, dicha por la operación el 16-09-2026: sin vínculo de codbar no se
 * genera guía Swayp, y el botón tiene que decir por qué está apagado.
 *
 * Son TRES puertas que paren una guía —la reprogramación confirmada, el reenvío
 * de una anulada y el alta con número a mano— y todas pasan por
 * `spinOffFenixGuide`. La reja vive ahí para que una cuarta puerta no nazca sin
 * ella.
 */
describe("las tres puertas de Envíos", () => {
  const src = readFileSync(resolve(process.cwd(), "app/dashboard/envios/actions.ts"), "utf8");
  const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");

  it("la reja está en el cuello por el que pasan las tres", () => {
    // Vive en lib/swayp-reenvio.ts: la comparte el agente de voz (MOM §11.8).
    const lib = readFileSync(resolve(process.cwd(), "lib/swayp-reenvio.ts"), "utf8");
    const fn = lib.slice(lib.indexOf("async function spinOffFenixGuide"));
    const cuerpo = fn.slice(0, fn.indexOf('.from("shipments")\n    .insert('));
    expect(cuerpo).toContain("const faltan = await swaypSinVinculo(");
    expect(cuerpo).toContain("if (faltan.length) return { error: avisoSinVinculoSwayp(faltan) };");
  });

  it("la reprogramación lo comprueba antes, junto al stock", () => {
    const bloque = src.slice(src.indexOf('input.disposition === "confirma" && reprogramProvider === "fenix"'));
    expect(bloque.slice(0, 2000)).toContain("const sinCodbar = await swaypSinVinculo(");
  });

  /**
   * El aviso vive en `lib/`, NO junto a las acciones: un archivo `"use server"`
   * solo puede exportar funciones async, y una función pura exportada desde
   * ahí rompe `next build` —no `tsc`, así que el fallo no aparece hasta el
   * despliegue—. Pasó en el commit 232c80d.
   */
  it("el aviso lo escribe una sola función, y vive fuera de las acciones", () => {
    const lib = readFileSync(resolve(process.cwd(), "lib/swayp-productos.ts"), "utf8");
    expect(lib).toContain("export function avisoSinVinculoSwayp(");
    expect(lib).toContain("Catálogo de productos");
    expect(src).not.toContain("export function avisoSinVinculoSwayp(");
    expect(src).toContain('avisoSinVinculoSwayp, normalizeSku, productosSinVinculo } from "@/lib/swayp-productos"');
  });


  it("el drawer recibe los productos que faltan", () => {
    expect(src).toContain("swaypUnlinked: await swaypSinVinculo(");
    expect(ui).toContain('const swaypUnlinked = detail && !("error" in detail) ? detail.swaypUnlinked : [];');
  });

  it("apaga las tres puertas de la interfaz", () => {
    // Reprogramación: la ruta Swayp deja de ofrecerse…
    expect(ui).toContain(
      'const fenixRouteAvailable =\n    !!shipment && (shipment.courier !== "aliclik" || shipment.fenix_eligible) && !swaypSinCodbar;',
    );
    // …el reenvío de una anulada…
    expect(ui).toContain('const cancelledExceptionUnavailable = fenixReason !== "ok" || swaypSinCodbar;');
    // …y el alta a mano.
    expect(ui).toContain("swaypSinCodbar ||");
  });

  it("y DICE por qué, en vez de solo apagarse", () => {
    expect(ui).toContain("const swaypSinCodbarAviso = swaypSinCodbar");
    // El motivo manda sobre los demás en el bloque de gestión…
    expect(ui).toContain("const gestionBlockReason = swaypSinCodbarAviso");
    // …la etiqueta del botón lo nombra…
    expect(ui).toContain('"Sin vínculo de codbar"');
    // …y el reenvío y el alta a mano lo enseñan como texto.
    expect(ui).toContain("{swaypSinCodbarAviso}");
    expect(ui).toContain("{swaypSinCodbarAviso\n                      ? swaypSinCodbarAviso");
  });
});

describe("el servidor no se fía del modal", () => {
  const src = readFileSync(resolve(process.cwd(), "app/dashboard/envios/actions.ts"), "utf8");

  it("la creación rechaza antes de llamar a Swayp", () => {
    // Acotado a `createDirectFenixGuide`: el archivo llama a la API de Swayp
    // desde varios sitios, y el primero es el de la reprogramación.
    const inicio = src.indexOf("export async function createDirectFenixGuide");
    expect(inicio).toBeGreaterThan(-1);
    const cuerpo = src.slice(inicio);
    const gate = cuerpo.indexOf("const sinVinculo = productosSinVinculo(");
    const apiCall = cuerpo.indexOf("createFenixGuideViaApi({");
    expect(gate).toBeGreaterThan(-1);
    expect(apiCall).toBeGreaterThan(gate);
  });

  /**
   * Lo que pasaba sin la reja: la API fallaba con «Falta vincular a Swayp», el
   * flujo caía al código local y la guía se creaba igual.
   *
   * El 16-09-2026 ese respaldo se retiró del todo —ver `swayp-caminos-api`—, así
   * que ahora un vínculo que falta y una ciudad sin bodega acaban igual: sin
   * guía y con el motivo dicho. Aquí se fija que no vuelva a colarse.
   */
  it("ya no queda ningún respaldo de código local", () => {
    expect(src).not.toContain("quedó con código manual");
  });

  it("la vista previa trae el vínculo resuelto", () => {
    expect(src).toContain("const unlinked = productosSinVinculo(lineItems, mapaSwayp);");
  });

  it("una tienda sin ningún vínculo no se bloquea, pero se avisa", () => {
    // La reja está apagada ahí, y callarlo dejaría a Swayp buscando los
    // productos por nombre sin que nadie lo sepa.
    expect(src).toContain("if (mapaSwayp.size === 0)");
    expect(src).toContain("la vía inestable");
  });
});
