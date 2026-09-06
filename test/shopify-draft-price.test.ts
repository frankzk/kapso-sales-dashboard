import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  createDraftOrder,
  isUnknownFieldError,
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

// El desajuste puede detectarse perfectamente y no decírselo a nadie — que es
// justo lo que pasaba antes, con la mutación respondiendo "ok".
describe("la asesora se entera", () => {
  const src = readFileSync(new URL("../app/dashboard/leads/actions.ts", import.meta.url), "utf8");

  it("el aviso nombra el producto y las dos cifras", () => {
    expect(src).toContain("Shopify cambió ");
    expect(src).toContain("pediste ${currency} ${d.pedido.toFixed(2)}");
    expect(src).toContain("Corrígelo en Shopify ANTES de despachar.");
  });

  it("el aviso llega al texto que ve la asesora", () => {
    expect(src).toContain("${phoneNote}${precioNote}`");
  });

  it("se le pasa la moneda a Shopify, que priceOverride necesita", () => {
    expect(src).toContain("currencyCode: currency");
  });
});
