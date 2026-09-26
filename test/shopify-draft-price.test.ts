import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  createDraftOrder,
  deleteDraftOrder,
  isUnknownFieldError,
  priceMismatchRejection,
  priceMismatches,
  resetDraftPriceFieldMode,
  updateDraftOrder,
} from "@/lib/shopify";

// Shopify IGNORABA en silencio el precio que le mandábamos para las líneas con
// `variantId` y facturaba el de catálogo. Medido sobre 30 días: de 1.256 líneas
// creadas por Kapta (97 productos) NINGUNA salió a un precio distinto al de
// lista ni a S/ 0, mientras que los otros canales tienen 52 líneas a cero y 33
// productos vendidos a más de un precio. Así se perdían los regalos de las
// promos: #AUR176302 llevaba el papel de freidora a S/ 0 en el carrito y salió
// cobrado a S/ 79.

/** Captura lo que se le manda a Shopify y responde lo que se le indique. */
function espia(respuestas: unknown[]): { fetchImpl: typeof fetch; enviados: any[] } {
  const enviados: any[] = [];
  let i = 0;
  const fetchImpl = (async (_url: unknown, init: unknown) => {
    const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
    enviados.push(body);
    const payload = respuestas[Math.min(i++, respuestas.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, enviados };
}

const draftOk = (lineas: { title: string; quantity: number; amount: string }[]) => ({
  data: {
    draftOrderCreate: {
      draftOrder: {
        id: "gid://shopify/DraftOrder/5",
        name: "#D5",
        lineItems: {
          edges: lineas.map((l) => ({
            node: {
              title: l.title,
              quantity: l.quantity,
              originalUnitPriceSet: { shopMoney: { amount: l.amount } },
            },
          })),
        },
      },
      userErrors: [],
    },
  },
});

const REGALO = [
  { variantId: "gid://shopify/ProductVariant/1", title: "EggMixer", quantity: 1, unitPrice: 89 },
  { variantId: "gid://shopify/ProductVariant/2", title: "Papel Freidora", quantity: 1, unitPrice: 0 },
];

beforeEach(() => resetDraftPriceFieldMode());

describe("el precio pactado se manda con priceOverride", () => {
  it("usa priceOverride, no el campo viejo que Shopify ignora", async () => {
    const { fetchImpl, enviados } = espia([
      draftOk([
        { title: "EggMixer", quantity: 1, amount: "89.00" },
        { title: "Papel Freidora", quantity: 1, amount: "0.00" },
      ]),
    ]);
    await createDraftOrder({
      domain: "x.myshopify.com",
      token: "t",
      input: { lineItems: REGALO, currencyCode: "PEN" },
      fetchImpl,
    });
    const li = enviados[0].variables.input.lineItems;
    expect(li[0].priceOverride).toEqual({ amount: "89.00", currencyCode: "PEN" });
    expect(li[0].originalUnitPrice).toBeUndefined();
  });

  // El caso que se perdía: un regalo son S/ 0, y 0 es falsy. Una guarda escrita
  // con `if (li.unitPrice)` en vez de `!= null` lo tiraría y Shopify volvería a
  // cobrar el precio de lista.
  it("un regalo de S/ 0 SÍ viaja: 0 no es 'sin precio'", async () => {
    const { fetchImpl, enviados } = espia([
      draftOk([
        { title: "EggMixer", quantity: 1, amount: "89.00" },
        { title: "Papel Freidora", quantity: 1, amount: "0.00" },
      ]),
    ]);
    await createDraftOrder({
      domain: "x.myshopify.com",
      token: "t",
      input: { lineItems: REGALO, currencyCode: "PEN" },
      fetchImpl,
    });
    expect(enviados[0].variables.input.lineItems[1].priceOverride).toEqual({
      amount: "0.00",
      currencyCode: "PEN",
    });
  });

  it("sin precio pedido no se manda nada y manda el catálogo", async () => {
    const { fetchImpl, enviados } = espia([draftOk([{ title: "X", quantity: 1, amount: "50.00" }])]);
    await createDraftOrder({
      domain: "x.myshopify.com",
      token: "t",
      input: { lineItems: [{ variantId: "gid://v/1", quantity: 1, unitPrice: null }] },
      fetchImpl,
    });
    const li = enviados[0].variables.input.lineItems[0];
    expect(li.priceOverride).toBeUndefined();
    expect(li.originalUnitPrice).toBeUndefined();
  });
});

// EL CASO QUE ESTAS PRUEBAS NO CUBRÍAN. Todas las de arriba llevan `variantId`.
// Una línea LIBRE —solo título, la asesora la escribe a mano— no tiene precio
// de catálogo que sustituir, y Shopify le ignora `priceOverride` sin error ni
// userError: la deja a S/ 0,00 y el pedido nace «pagado», porque S/ 0 ya está
// pagado. Así salieron #AUR177106 y #AUR177461 (17/09 y 25/09: S/ 89 pactados,
// S/ 0 facturados) desde que #552 mandó priceOverride a TODAS las líneas.
// Hasta el 05/09 la línea libre iba con originalUnitPrice y salía bien
// (#D104777 a S/ 89, #D93481 a S/ 99): de 4 líneas libres con precio creadas
// por Kapta después del cambio, las 4 salieron a cero.
describe("una línea libre no tiene catálogo: su precio va en originalUnitPrice", () => {
  const LIBRE = { title: "CloudSlides™ - Sandalias 36-37 / CELESTE", quantity: 1, unitPrice: 89 };

  it("sin variantId manda originalUnitPrice y NUNCA priceOverride (#AUR177461)", async () => {
    const { fetchImpl, enviados } = espia([
      draftOk([{ title: LIBRE.title, quantity: 1, amount: "89.00" }]),
    ]);
    await createDraftOrder({
      domain: "x.myshopify.com",
      token: "t",
      input: { lineItems: [LIBRE], currencyCode: "PEN" },
      fetchImpl,
    });
    const li = enviados[0].variables.input.lineItems[0];
    expect(li.title).toBe(LIBRE.title);
    expect(li.variantId).toBeUndefined();
    expect(li.originalUnitPrice).toBe("89.00");
    expect(li.priceOverride).toBeUndefined();
  });

  it("en un pedido mixto cada línea lleva SU campo: la variante priceOverride, la libre originalUnitPrice", async () => {
    const { fetchImpl, enviados } = espia([
      draftOk([
        { title: "Cinturón", quantity: 1, amount: "99.00" },
        { title: "KeyGrip", quantity: 1, amount: "0.00" },
      ]),
    ]);
    await createDraftOrder({
      domain: "x.myshopify.com",
      token: "t",
      input: {
        lineItems: [
          { variantId: "gid://shopify/ProductVariant/1", title: "Cinturón", quantity: 1, unitPrice: 99 },
          { title: "KeyGrip", quantity: 1, unitPrice: 0 },
        ],
        currencyCode: "PEN",
      },
      fetchImpl,
    });
    const [variante, libre] = enviados[0].variables.input.lineItems;
    expect(variante.priceOverride).toEqual({ amount: "99.00", currencyCode: "PEN" });
    expect(variante.originalUnitPrice).toBeUndefined();
    // El regalo libre a S/ 0 también viaja: 0 no es «sin precio».
    expect(libre.originalUnitPrice).toBe("0.00");
    expect(libre.priceOverride).toBeUndefined();
  });

  it("y el desajuste que producía el bug se detecta: pedido S/ 89, aplicado S/ 0", () => {
    expect(priceMismatches([LIBRE], [{ title: LIBRE.title, quantity: 1, unitPrice: 0 }])).toEqual([
      { title: LIBRE.title, pedido: 89, aplicado: 0 },
    ]);
  });
});

describe("respaldo: si Shopify no conoce priceOverride, se usa el campo viejo", () => {
  const noConoce = {
    errors: [{ message: "InputObject 'DraftOrderLineItemInput' doesn't accept argument 'priceOverride'" }],
  };

  it("reintenta con originalUnitPrice y el pedido sale igual", async () => {
    const { fetchImpl, enviados } = espia([
      noConoce,
      draftOk([{ title: "EggMixer", quantity: 1, amount: "89.00" }]),
    ]);
    const r = await createDraftOrder({
      domain: "x.myshopify.com",
      token: "t",
      input: { lineItems: [{ variantId: "gid://v/1", quantity: 1, unitPrice: 89 }] },
      fetchImpl,
    });
    expect(r.gid).toBe("gid://shopify/DraftOrder/5");
    expect(enviados).toHaveLength(2);
    expect(enviados[0].variables.input.lineItems[0].priceOverride).toBeDefined();
    expect(enviados[1].variables.input.lineItems[0].originalUnitPrice).toBe("89.00");
  });

  // Sin memoria, CADA pedido pagaría el viaje de descubrimiento.
  it("recuerda el modo: el segundo pedido no reintenta", async () => {
    const primero = espia([noConoce, draftOk([{ title: "A", quantity: 1, amount: "10.00" }])]);
    await createDraftOrder({
      domain: "x.myshopify.com",
      token: "t",
      input: { lineItems: [{ variantId: "gid://v/1", quantity: 1, unitPrice: 10 }] },
      fetchImpl: primero.fetchImpl,
    });
    const segundo = espia([draftOk([{ title: "A", quantity: 1, amount: "10.00" }])]);
    await createDraftOrder({
      domain: "x.myshopify.com",
      token: "t",
      input: { lineItems: [{ variantId: "gid://v/1", quantity: 1, unitPrice: 10 }] },
      fetchImpl: segundo.fetchImpl,
    });
    expect(segundo.enviados).toHaveLength(1);
    expect(segundo.enviados[0].variables.input.lineItems[0].originalUnitPrice).toBe("10.00");
  });

  // Si un error CUALQUIERA disparara el respaldo, un fallo real de permisos o de
  // variante acabaría creando el pedido con el campo que sabemos que no funciona
  // — y volveríamos a facturar precio de lista sin enterarnos.
  it("un error que NO es de campo desconocido sube tal cual, sin reintentar", async () => {
    const { fetchImpl, enviados } = espia([{ errors: [{ message: "Access denied for draftOrderCreate" }] }]);
    await expect(
      createDraftOrder({
        domain: "x.myshopify.com",
        token: "t",
        input: { lineItems: [{ variantId: "gid://v/1", quantity: 1, unitPrice: 10 }] },
        fetchImpl,
      }),
    ).rejects.toThrow(/Access denied/);
    expect(enviados).toHaveLength(1);
  });
});

describe("isUnknownFieldError", () => {
  it("reconoce las dos formas en que GraphQL rechaza un campo", () => {
    expect(
      isUnknownFieldError(
        new Error("InputObject 'DraftOrderLineItemInput' doesn't accept argument 'priceOverride'"),
        "priceOverride",
      ),
    ).toBe(true);
    expect(
      isUnknownFieldError(
        new Error("Field 'priceOverride' is not defined by type 'DraftOrderLineItemInput'"),
        "priceOverride",
      ),
    ).toBe(true);
  });

  it("no confunde otros errores que mencionan el campo", () => {
    expect(isUnknownFieldError(new Error("priceOverride must be positive"), "priceOverride")).toBe(false);
    expect(isUnknownFieldError(new Error("Access denied"), "priceOverride")).toBe(false);
    expect(isUnknownFieldError(null, "priceOverride")).toBe(false);
  });
});

describe("priceMismatches", () => {
  it("detecta el regalo convertido en precio de lista", () => {
    const d = priceMismatches(REGALO, [
      { title: "EggMixer", quantity: 1, unitPrice: 89 },
      { title: "Papel Freidora", quantity: 1, unitPrice: 79 },
    ]);
    expect(d).toEqual([{ title: "Papel Freidora", pedido: 0, aplicado: 79 }]);
  });

  it("calla cuando todo coincide", () => {
    expect(
      priceMismatches(REGALO, [
        { title: "EggMixer", quantity: 1, unitPrice: 89 },
        { title: "Papel Freidora", quantity: 1, unitPrice: 0 },
      ]),
    ).toEqual([]);
  });

  it("ignora las líneas sin precio pedido: ahí el catálogo es lo correcto", () => {
    expect(
      priceMismatches([{ variantId: "gid://v/1", quantity: 1, unitPrice: null }], [
        { title: "X", quantity: 1, unitPrice: 50 },
      ]),
    ).toEqual([]);
  });

  // Shopify devuelve cadenas; un céntimo de redondeo no es motivo de alarma,
  // pero un regalo perdido (0 → 79) está a años luz de esa tolerancia.
  it("tolera el redondeo, no un cambio real", () => {
    const pedidas = [{ variantId: "gid://v/1", quantity: 1, unitPrice: 89 }];
    expect(priceMismatches(pedidas, [{ title: "A", quantity: 1, unitPrice: 89.001 }])).toEqual([]);
    expect(priceMismatches(pedidas, [{ title: "A", quantity: 1, unitPrice: 89.5 }])).toHaveLength(1);
  });

  // Dos unidades del mismo producto a precios distintos —una pagada y otra de
  // regalo— es un caso REAL de promo. Emparejar por título las confundiría.
  it("empareja por posición, no por título", () => {
    const pedidas = [
      { variantId: "gid://v/1", title: "Pulsera", quantity: 1, unitPrice: 99 },
      { variantId: "gid://v/1", title: "Pulsera", quantity: 1, unitPrice: 0 },
    ];
    const d = priceMismatches(pedidas, [
      { title: "Pulsera", quantity: 1, unitPrice: 99 },
      { title: "Pulsera", quantity: 1, unitPrice: 99 },
    ]);
    expect(d).toEqual([{ title: "Pulsera", pedido: 0, aplicado: 99 }]);
  });
});

describe("updateDraftOrder también verifica", () => {
  it("devuelve el desajuste al reescribir un carrito", async () => {
    const resp = {
      data: {
        draftOrderUpdate: {
          draftOrder: {
            id: "gid://shopify/DraftOrder/9",
            name: "#D9",
            lineItems: {
              edges: [
                { node: { title: "EggMixer", quantity: 1, originalUnitPriceSet: { shopMoney: { amount: "89.00" } } } },
                { node: { title: "Papel Freidora", quantity: 1, originalUnitPriceSet: { shopMoney: { amount: "79.00" } } } },
              ],
            },
          },
          userErrors: [],
        },
      },
    };
    const { fetchImpl } = espia([resp]);
    const r = await updateDraftOrder({
      domain: "x.myshopify.com",
      token: "t",
      gid: "gid://shopify/DraftOrder/9",
      input: { lineItems: REGALO, currencyCode: "PEN" },
      fetchImpl,
    });
    expect(r.priceMismatches).toEqual([{ title: "Papel Freidora", pedido: 0, aplicado: 79 }]);
  });
});

// EL DESAJUSTE RECHAZA LA VENTA. Antes se avisaba con el pedido ya creado, en
// una frase al final de «Pedido generado ✓» que nadie leyó: cuatro ventas
// salieron a S/ 0 con el aviso puesto (#AUR177461, #AUR177106, #KP133922,
// #KP134910). Un pedido con otro precio del pactado no se adorna: no se crea.
describe("el rechazo dice qué pasó, con producto, cifras y borrador", () => {
  const LIBRE = { title: "CloudSlides™ 36-37 / CELESTE", pedido: 89, aplicado: 0 };

  it("borrador propio borrado: error para la asesora y nota para el lead (#AUR177461)", () => {
    const r = priceMismatchRejection({ desajustes: [LIBRE], currency: "PEN", draftName: "#D105703", cleanup: "deleted" });
    expect(r.error).toMatch(/^Pedido NO generado: /);
    expect(r.error).toContain("«CloudSlides™ 36-37 / CELESTE» (pediste PEN 89.00, Shopify guardó PEN 0.00)");
    expect(r.error).toContain("El borrador #D105703 se eliminó.");
    expect(r.error).toContain("vuelve a intentarlo");
    expect(r.note).toMatch(/^⛔ Venta NO generada · /);
    expect(r.note).toContain("pediste PEN 89.00, Shopify guardó PEN 0.00");
    expect(r.note).toContain("El borrador #D105703 se eliminó.");
  });

  it("el carrito del cliente no se borra: se deja sin completar", () => {
    const r = priceMismatchRejection({ desajustes: [LIBRE], currency: "PEN", draftName: "#D9", cleanup: "kept_cart" });
    expect(r.error).toContain("El carrito #D9 quedó sin completar.");
    expect(r.error).not.toContain("se eliminó");
  });

  it("si el borrado falla, lo dice y pide borrarlo a mano", () => {
    const r = priceMismatchRejection({ desajustes: [LIBRE], currency: "PEN", draftName: "#D9", cleanup: "delete_failed" });
    expect(r.error).toContain("No se pudo eliminar el borrador #D9: bórralo en Shopify.");
    expect(r.note).toContain("bórralo en Shopify");
  });

  it("varias líneas y una sin precio: todas nombradas", () => {
    const r = priceMismatchRejection({
      desajustes: [LIBRE, { title: "KeyGrip", pedido: 0, aplicado: null }],
      currency: "PEN",
      draftName: null,
      cleanup: "deleted",
    });
    expect(r.error).toContain("(pediste PEN 89.00, Shopify guardó PEN 0.00); «KeyGrip» (pediste PEN 0.00, Shopify guardó sin precio)");
    expect(r.error).toContain("El borrador de Shopify se eliminó.");
  });
});

describe("deleteDraftOrder", () => {
  it("manda la mutación de borrado con el id y devuelve el borrado", async () => {
    const { fetchImpl, enviados } = espia([
      { data: { draftOrderDelete: { deletedId: "gid://shopify/DraftOrder/5", userErrors: [] } } },
    ]);
    const r = await deleteDraftOrder({ domain: "x.myshopify.com", token: "t", draftGid: "gid://shopify/DraftOrder/5", fetchImpl });
    expect(r).toBe("gid://shopify/DraftOrder/5");
    expect(enviados).toHaveLength(1);
    expect(enviados[0].query).toContain("draftOrderDelete(input: $input)");
    expect(enviados[0].variables).toEqual({ input: { id: "gid://shopify/DraftOrder/5" } });
  });

  // Un borrador suelto con precio malo es la venta a S/ 0 de mañana si alguien
  // lo completa desde el admin: quien llama tiene que saber que sigue ahí.
  it("si Shopify se niega, lanza con el motivo", async () => {
    const { fetchImpl } = espia([
      { data: { draftOrderDelete: { deletedId: null, userErrors: [{ field: ["id"], message: "Draft order is completed" }] } } },
    ]);
    await expect(
      deleteDraftOrder({ domain: "x.myshopify.com", token: "t", draftGid: "gid://shopify/DraftOrder/5", fetchImpl }),
    ).rejects.toThrow(/Draft order is completed/);
  });
});

// La regla puede estar bien escrita y no aplicarse: si la acción completa el
// borrador antes de mirar el desajuste, el pedido a S/ 0 existe igual. Estas
// guardas leen el fuente para probar que el rechazo LLEGA al flujo y en qué
// orden; la parte pura está probada arriba por comportamiento.
describe("el desajuste BLOQUEA la venta, no la adorna", () => {
  const src = readFileSync(new URL("../app/dashboard/leads/actions.ts", import.meta.url), "utf8");
  // Otra acción más arriba también completa borradores: se busca DESDE la venta
  // manual, que es la que arma `runDraft`, y no desde el principio del fichero.
  const venta = src.indexOf("const runDraft = async (withPhone: boolean)");
  const inicio = src.indexOf("if (desajustes.length) {", venta);
  const completar = src.indexOf("completed = await completeDraftOrder(", inicio);
  const bloque = src.slice(inicio, completar);

  it("se comprueba ANTES de completar el borrador", () => {
    expect(venta).toBeGreaterThan(-1);
    expect(inicio).toBeGreaterThan(venta);
    expect(completar).toBeGreaterThan(inicio);
  });

  it("borra el borrador propio y deja el carrito del cliente sin completar", () => {
    expect(bloque).toContain("deleteDraftOrder({ ...sclient, draftGid: draftGid! })");
    expect(bloque).toContain('cleanup = "kept_cart"');
    expect(bloque).toContain('cleanup = "delete_failed"');
  });

  it("queda constancia en el lead y la asesora recibe el ERROR, no un aviso", () => {
    expect(bloque).toContain('kind: "system"');
    expect(bloque).toContain("note: rechazo.note");
    expect(bloque).toContain("return { error: rechazo.error }");
    expect(src).not.toContain("precioNote");
    expect(src).not.toContain("Corrígelo en Shopify ANTES de despachar.");
  });

  it("se le pasa la moneda a Shopify, que priceOverride necesita", () => {
    expect(src).toContain("currencyCode: currency");
  });
});
