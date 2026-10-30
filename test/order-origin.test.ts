// «Origen» en la ficha del Master (MOM §3, «Origen en la ficha», 30-10-2026).
// Los casos tienen la forma de pedidos reales de producción (sin datos
// personales): #KP200370, #KP200371, #AUR900053, #KP200286, #AUR900041,
// #KP200281, #KP144007, #KP142983, #AUR178649, #AUR178669, #AUR178670, #KP144031.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { orderOrigin, orderOriginRawFacts, type OrderOriginFacts } from "@/lib/order-origin";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const NO_RAW = { wooCreatedVia: null, wooPaymentMethod: null, kaptaChannel: null, sourceName: null };

function facts(over: Partial<OrderOriginFacts>): OrderOriginFacts {
  return {
    platform: "shopify",
    tags: [],
    kapsoConversationId: null,
    paymentGateway: null,
    raw: NO_RAW,
    sale: null,
    draftName: null,
    autoOrderTrial: false,
    ...over,
  };
}

const woo = (created_via: string, kapta_channel: string, payment_method = "cod") =>
  orderOriginRawFacts({
    woo: { created_via, payment_method },
    note_attributes: [{ name: "kapta_channel", value: kapta_channel }],
  });

describe("orderOriginRawFacts", () => {
  it("lee created_via, payment_method y kapta_channel de la copia de WooCommerce", () => {
    expect(woo("cod-core-form", "web_formulario", "flowpayment")).toEqual({
      wooCreatedVia: "cod-core-form",
      wooPaymentMethod: "flowpayment",
      kaptaChannel: "web_formulario",
      sourceName: null,
    });
  });
  it("acepta el atributo con la forma de GraphQL y sin raw no falla", () => {
    expect(orderOriginRawFacts({ customAttributes: [{ key: "_Kapta_Channel", value: "Kapso" }] }).kaptaChannel).toBe("kapso");
    expect(orderOriginRawFacts(null)).toEqual(NO_RAW);
  });
});

describe("orderOrigin", () => {
  it("#KP200370: formulario COD de WooCommerce", () => {
    const o = orderOrigin(facts({ platform: "woocommerce", tags: ["easysell_cod_form"], paymentGateway: "cod", raw: woo("cod-core-form", "web_formulario") }));
    expect(o.label).toBe("Web · formulario contra entrega");
    expect(o.evidence).toContain("kapta_channel = web_formulario");
  });

  it("#KP200286: el checkout con Flow", () => {
    const o = orderOrigin(
      facts({ platform: "woocommerce", tags: ["easysell_cod_form"], paymentGateway: "checkout", raw: woo("cod-core-form", "web_formulario", "flowpayment") }),
    );
    expect(o.label).toBe("Web · checkout (Flow)");
  });

  it("#AUR178649: checkout de Shopify, con el borrador en la evidencia", () => {
    const o = orderOrigin(
      facts({ tags: ["draft_order_for_checkout_button", "easysell_cod_form"], paymentGateway: "checkout", draftName: "#D106553" }),
    );
    expect(o.label).toBe("Web · checkout");
    expect(o.evidence.join(" ")).toContain("#D106553");
  });

  it("#KP200371 / #AUR900053: Generar pedido de Kapta Leads, por la asesora", () => {
    const o = orderOrigin(
      facts({
        platform: "woocommerce",
        tags: ["venta_manual"],
        raw: woo("kapta", "venta_manual"),
        sale: { sellerName: "asesora@kapta.pe", source: "sale_action", leadSource: "meta_ad" },
      }),
    );
    expect(o.label).toBe("Kapta Leads · Generar pedido · por asesora@kapta.pe");
    expect(o.evidence[0]).toContain("order_sales");
  });

  it("Generar pedido en Shopify: su propio borrador no es un carrito", () => {
    const o = orderOrigin(
      facts({ tags: ["venta_manual"], draftName: "#D104501", sale: { sellerName: "a@k.pe", source: "sale_action", leadSource: "cod_cart" } }),
    );
    expect(o.label).toBe("Kapta Leads · Generar pedido · por a@k.pe");
  });

  it("#KP144007: la asesora completó el carrito, gana a las etiquetas de EasySell (§17.3)", () => {
    const o = orderOrigin(
      facts({
        tags: ["easysell-abandoned-checkout", "easysell_cod_form"],
        draftName: "#D105563",
        sale: { sellerName: "a@k.pe", source: "sale_action", leadSource: "cod_cart" },
      }),
    );
    expect(o.label).toBe("Kapta Leads · completó el carrito #D105563 · por a@k.pe");
  });

  it("#KP142983: venta telefónica sobre un carrito", () => {
    const o = orderOrigin(
      facts({
        tags: ["easysell-abandoned-checkout"],
        draftName: "#D104473",
        sale: { sellerName: "a@k.pe", source: "sale_action", leadSource: "manual" },
      }),
    );
    expect(o.label).toBe("Venta telefónica · carrito #D104473 · por a@k.pe");
    expect(orderOrigin(facts({ tags: ["venta_manual"], sale: { sellerName: "a@k.pe", source: "sale_action", leadSource: "manual" } })).label).toBe(
      "Venta telefónica · por a@k.pe",
    );
  });

  it("una venta sin nombre legible no inventa asesora", () => {
    expect(orderOrigin(facts({ tags: ["venta_manual"], sale: { sellerName: null, source: "backfill_match", leadSource: null } })).label).toBe("Kapta Leads");
  });

  it("carrito completado sin asesora: no dice quién lo cerró", () => {
    const o = orderOrigin(facts({ tags: ["easysell-abandoned-checkout", "easysell_cod_form"], draftName: "#D105563" }));
    expect(o.label).toBe("Carrito completado · #D105563");
    expect(o.evidence.join(" ")).toContain("la clienta o un bot");
    expect(orderOrigin(facts({ tags: ["easysell-abandoned-checkout"] })).label).toBe("Web · carrito completado");
  });

  it("#AUR900041: Chatby recuperó el carrito (created_via = cod-core-chatby)", () => {
    const o = orderOrigin(
      facts({ platform: "woocommerce", tags: ["easysell-abandoned-checkout"], draftName: "#F11212", raw: woo("cod-core-chatby", "web_carrito") }),
    );
    expect(o.label).toBe("Chatby · carrito recuperado #F11212");
  });

  it("la recompra automática gana al canal de sus etiquetas", () => {
    const o = orderOrigin(facts({ tags: ["easysell-abandoned-checkout"], draftName: "#D1", autoOrderTrial: true }));
    expect(o.label).toBe("Recompra automática · carrito #D1");
  });

  it("#KP200281 / #AUR178654: el bot de WhatsApp (Kapso)", () => {
    expect(orderOrigin(facts({ platform: "woocommerce", tags: ["kapso", "whatsapp", "promo-whatsapp"], raw: woo("rest-api", "whatsapp_bot") })).label).toBe(
      "Bot de WhatsApp (Kapso)",
    );
    expect(orderOrigin(facts({ tags: [], kapsoConversationId: "conv" })).label).toBe("Bot de WhatsApp (Kapso)");
  });

  it("#AUR178669 y #AUR178670: bot de carritos externo y catálogo", () => {
    expect(orderOrigin(facts({ tags: ["BOT", "CARRITO RECUPERADO"] })).label).toBe("Bot de carritos externo · carrito recuperado");
    expect(orderOrigin(facts({ tags: ["catalogo-wsp", "Perú"] })).label).toBe("Catálogo de WhatsApp");
  });

  it("venta_manual sin venta registrada: wp-admin o el botón, según created_via", () => {
    expect(orderOrigin(facts({ platform: "woocommerce", tags: ["venta_manual"], raw: woo("admin", "venta_manual") })).label).toBe("Cargado en wp-admin");
    expect(orderOrigin(facts({ platform: "woocommerce", tags: ["venta_manual"], raw: woo("kapta", "venta_manual") })).label).toBe(
      "Kapta Leads · Generar pedido",
    );
    expect(orderOrigin(facts({ tags: ["venta_manual"] })).label).toBe("Asesora · sin venta registrada");
  });

  it("#KP144031: sin etiqueta de canal, lo que diga Shopify; si nada, «Sin marca»", () => {
    expect(orderOrigin(facts({ tags: ["CONFIRMADO"], draftName: "#D106600" })).label).toBe("Shopify admin · borrador #D106600");
    expect(orderOrigin(facts({ raw: { ...NO_RAW, sourceName: "shopify_draft_order" } })).label).toBe("Shopify admin · borrador");
    expect(orderOrigin(facts({ raw: { ...NO_RAW, sourceName: "4310925" } })).label).toBe("App de Shopify");
    const none = orderOrigin(facts({ tags: ["mafer alicklic"] }));
    expect(none.label).toBe("Sin marca");
    expect(none.evidence.length).toBeGreaterThan(0);
    expect(orderOrigin(facts({ platform: "woocommerce", raw: woo("admin", "") })).label).toBe("Cargado en wp-admin");
  });
});

describe("la ficha y el MOM", () => {
  it("el cajón muestra «Origen» con su evidencia, y el detalle lo arma sin consultas por fila", () => {
    const drawer = read("components/order-drawer.tsx");
    expect(drawer).toContain(">Origen</dt>");
    expect(drawer).toContain("detail.origin.label");
    expect(drawer).toContain("detail.origin.evidence");
    const access = read("lib/orders-master-access.ts");
    expect(access).toMatch(/ORDER_DETAIL_COLUMNS = "[^"]*tags,kapso_conversation_id/);
    expect(access).toContain("loadOrderOriginSources(sb, row, orderId)");
  });

  it("el MOM documenta el campo y su regla", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**Origen en la ficha (30-10-2026");
    expect(mom).toContain("«Web · checkout (Flow)»");
    expect(mom).toContain("«Chatby · carrito recuperado #F…»");
    expect(mom).toContain("`lib/order-origin.ts`");
  });
});
