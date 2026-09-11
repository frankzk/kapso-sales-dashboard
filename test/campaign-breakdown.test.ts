import { describe, it, expect } from "vitest";
import { campaignBreakdown, campaignDailyTrend, webNoAtribuido } from "@/lib/metrics";
import type { AdMeta } from "@/lib/meta-ads";
import type { AnuncioMeta, WebAdOrder } from "@/lib/cod-cart-attribution";
import type { LeadRow, MetaAdPerformance, OrderRow } from "@/lib/types";

const orders = [
  { id: "order-1", name: "#1001", customer_phone: "51920582451", total_amount: 219, total_refunded: 0, cancelled_at: null, line_items: [{ title: "Mochila viajera", sku: "MOCH-1", quantity: 1 }] },
  { id: "order-2", name: "#1002", customer_phone: "51933333333", total_amount: 99, total_refunded: 0, cancelled_at: null, line_items: [{ title: "Set Cocina", sku: "COC-1", quantity: 1 }] },
  { id: "unrelated", name: "#9999", customer_phone: "51920582451", total_amount: 999, total_refunded: 0, cancelled_at: null, line_items: [] },
] as unknown as OrderRow[];

const leads = [
  { phone: "51920582451", source: "meta_ad", ad_id: "120246653255450657", ad_headline: "✈️ Viaja Sin Maletas", has_order: true, order_id: "order-1" },
  { phone: "51911111111", source: "meta_ad", ad_id: "120246653255450657", ad_headline: "✈️ Viaja Sin Maletas", has_order: false },
  { phone: "51933333333", source: "meta_ad", ad_id: "999", ad_headline: "🍳 Set Cocina", has_order: true, order_id: "order-2" },
  { phone: "51944444444", source: null, ad_id: null, ad_headline: null, has_order: true }, // organic — excluded
] as unknown as LeadRow[];

describe("campaignBreakdown (revenue half of ROAS)", () => {
  it("attributes only the exact linked order, never unrelated orders from the same phone", () => {
    const rows = campaignBreakdown(leads, orders);
    expect(rows).toHaveLength(2);
    const viaja = rows.find((r) => r.adId === "120246653255450657")!;
    expect(viaja).toMatchObject({ label: "✈️ Viaja Sin Maletas", leads: 2, pedidos: 1, ingresos: 219 });
    expect(viaja.conversion).toBeCloseTo(0.5);
    expect(rows[0]!.adId).toBe("120246653255450657"); // sorted by revenue desc
  });

  it("keeps two ads that SHARE a headline as separate rows, distinguishable by metaAdId", () => {
    // The reported case: two distinct ad_ids with the same CTWA headline ("Madera
    // Como Nueva"). They must stay ad-level (2 rows), told apart by the real ad_id.
    const mixed = [
      { phone: "a", source: "meta_ad", ad_id: "111", ad_headline: "Madera Como Nueva", has_order: false },
      { phone: "b", source: "meta_ad", ad_id: "222", ad_headline: "Madera Como Nueva", has_order: false },
      { phone: "c", source: "meta_ad", ad_id: null, ad_headline: "Madera Como Nueva", has_order: false }, // Meta sent no ad_id
    ] as unknown as LeadRow[];
    const rows = campaignBreakdown(mixed, orders);
    expect(rows).toHaveLength(3); // two ads + the headline-only group — NOT collapsed into one
    expect(rows.find((r) => r.adId === "111")!.metaAdId).toBe("111");
    expect(rows.find((r) => r.adId === "222")!.metaAdId).toBe("222");
    expect(rows.find((r) => r.adId === "Madera Como Nueva")!.metaAdId).toBeNull(); // "sin ad id"
  });

  it("keeps the attributed stores so the product picker searches the right catalogs", () => {
    const storeLeads = [
      { store_id: "store-kenku", source: "meta_ad", ad_id: "shared-ad", ad_headline: "Producto" },
      { store_id: "store-kenku", source: "meta_ad", ad_id: "shared-ad", ad_headline: "Producto" },
      { store_id: "store-aurela", source: "meta_ad", ad_id: "shared-ad", ad_headline: "Producto" },
    ] as unknown as LeadRow[];

    const [row] = campaignBreakdown(storeLeads, []);
    expect(row?.storeIds).toEqual(["store-kenku", "store-aurela"]);
  });

  it("upgrades the label to the real Meta ad name when resolved, else falls back", () => {
    const names: Record<string, AdMeta> = {
      "120246653255450657": {
        accountId: "1253056442078246",
        campaignId: "120246653018520657",
        campaignName: "CBO Msj | TravelersBackpack | 2306 Campaña",
        objective: "OUTCOME_ENGAGEMENT",
        adsetId: "120246653018510657",
        adsetName: "CBO Msj | TravelersBackpack | 2306 Conjunto de anuncios",
        adName: "mochila viral 31",
        status: "ACTIVE",
        fetchedAt: "2026-06-24T00:00:00Z",
        promotedProductName: "Mochila viajera",
        promotedSkus: ["MOCH-1"],
        promotedProductUpdatedAt: "2026-06-24T00:00:00Z",
      },
    };
    const rows = campaignBreakdown(leads, orders, names);

    const viaja = rows.find((r) => r.adId === "120246653255450657")!;
    expect(viaja.label).toBe("mochila viral 31"); // real ad name, not the shared headline
    expect(viaja.resolved).toBe(true);
    expect(viaja.headline).toBe("✈️ Viaja Sin Maletas"); // headline still preserved
    expect(viaja.meta?.campaignName).toBe("CBO Msj | TravelersBackpack | 2306 Campaña");
    expect(viaja.meta?.accountId).toBe("1253056442078246");
    expect(viaja.productMatchRate).toBe(1);

    // The other ad has no lookup entry → degrades to its headline, unresolved.
    const cocina = rows.find((r) => r.adId === "999")!;
    expect(cocina.label).toBe("🍳 Set Cocina");
    expect(cocina.resolved).toBe(false);
    expect(cocina.meta).toBeNull();
  });

  it("classifies cross-sell and calculates the latest delivery outcome", () => {
    const names: Record<string, AdMeta> = {
      "999": {
        accountId: null, campaignId: null, campaignName: null, objective: null,
        adsetId: null, adsetName: null, adName: "Cocina", status: null, fetchedAt: null,
        promotedProductName: "Mochila", promotedSkus: ["MOCH-1"], promotedProductUpdatedAt: null,
      },
    };
    const rows = campaignBreakdown(leads, orders, names, [
      { orderId: "order-2", deliveryStatus: "Entregado", statusCategory: "delivered", createdAt: "2026-07-20T00:00:00Z" },
    ]);
    const cocina = rows.find((row) => row.adId === "999")!;
    expect(cocina.crossSellOrders).toBe(1);
    expect(cocina.productMatchRate).toBe(0);
    expect(cocina.deliveredOrders).toBe(1);
    expect(cocina.deliveryRate).toBe(1);
  });

  it("joins historical Meta delivery and derives weighted cost metrics", () => {
    const performance = [
      {
        storeId: "store-1",
        adId: "999",
        accountId: "act-1",
        currency: "USD",
        metaConversations: 1,
        spend: 24,
        impressions: 12_000,
        reach: 8_000,
        clicks: 120,
        inlineLinkClicks: 90,
        activeDays: 6,
        firstDate: "2026-07-01",
        lastDate: "2026-07-06",
        syncedAt: "2026-07-07T00:00:00Z",
      },
      {
        storeId: "store-1",
        adId: "spent-without-leads",
        accountId: "act-1",
        currency: "USD",
        metaConversations: 3,
        spend: 10,
        impressions: 5_000,
        reach: 4_000,
        clicks: 30,
        inlineLinkClicks: 20,
        activeDays: 3,
        firstDate: "2026-07-01",
        lastDate: "2026-07-03",
        syncedAt: "2026-07-07T00:00:00Z",
      },
    ] satisfies MetaAdPerformance[];
    const rows = campaignBreakdown(leads, orders, {}, [
      { orderId: "order-2", deliveryStatus: "Entregado", statusCategory: "delivered", createdAt: "2026-07-20T00:00:00Z" },
    ], performance);

    const cocina = rows.find((row) => row.adId === "999")!;
    expect(cocina).toMatchObject({
      metaCurrency: "USD",
      spend: 24,
      impressions: 12_000,
      cpm: 2,
      frequency: 1.5,
      cpc: 0.2,
      cpl: 24,
      cpa: 24,
      deliveredCpa: 24,
    });
    expect(cocina.roas).toBeCloseTo(99 / 24);
    expect(cocina.deliveredRoas).toBeCloseTo(99 / 24);

    const noSignal = rows.find((row) => row.adId === "spent-without-leads")!;
    expect(noSignal.leads).toBe(0);
    expect(noSignal.decision).toBe("no_attribution");
  });

  it("does not recommend scaling without verified spend or five delivered orders", () => {
    const cohortLeads = Array.from({ length: 25 }, (_, index) => ({
      id: `lead-${index}`,
      store_id: "store-1",
      source: "meta_ad",
      ad_id: "quality-ad",
      ad_headline: "Quality",
      order_id: index < 5 ? `quality-order-${index}` : null,
    })) as unknown as LeadRow[];
    const cohortOrders = Array.from({ length: 5 }, (_, index) => ({
      id: `quality-order-${index}`,
      name: `#Q${index}`,
      total_amount: 100,
      total_refunded: 0,
      cancelled_at: null,
      line_items: [{ title: "Producto", sku: "SKU", quantity: 1 }],
    })) as unknown as OrderRow[];

    const [withoutSpend] = campaignBreakdown(cohortLeads, cohortOrders);
    expect(withoutSpend?.decision).toBe("data_incomplete");

    const meta = [{
      storeId: "store-1",
      adId: "quality-ad",
      accountId: "act-1",
      currency: "USD",
      metaConversations: 30,
      spend: 50,
      impressions: 10_000,
      reach: 8_000,
      clicks: 100,
      inlineLinkClicks: 80,
      activeDays: 7,
      firstDate: "2026-07-01",
      lastDate: "2026-07-07",
      syncedAt: "2026-07-08T00:00:00Z",
    }] satisfies MetaAdPerformance[];
    const threeDeliveries = Array.from({ length: 3 }, (_, index) => ({
      orderId: `quality-order-${index}`,
      deliveryStatus: "Entregado",
      statusCategory: "delivered",
      createdAt: "2026-07-10T00:00:00Z",
    }));
    const [immature] = campaignBreakdown(cohortLeads, cohortOrders, {}, threeDeliveries, meta);
    expect(immature?.decision).toBe("insufficient");
    expect(immature?.decisionReason).toContain("3/5");

    const fiveDeliveries = Array.from({ length: 5 }, (_, index) => ({
      orderId: `quality-order-${index}`,
      deliveryStatus: "Entregado",
      statusCategory: "delivered",
      createdAt: "2026-07-10T00:00:00Z",
    }));
    const [mature] = campaignBreakdown(cohortLeads, cohortOrders, {}, fiveDeliveries, meta);
    expect(["scale", "promising"]).toContain(mature?.decision);
  });

  it("campaignDailyTrend buckets leads per day per ad (store tz)", () => {
    const trendLeads = [
      { phone: "1", source: "meta_ad", ad_id: "A", ad_headline: "H", first_seen_at: "2026-06-24T10:00:00Z" },
      { phone: "2", source: "meta_ad", ad_id: "A", ad_headline: "H", first_seen_at: "2026-06-25T10:00:00Z" },
      { phone: "3", source: "meta_ad", ad_id: "B", ad_headline: "H2", first_seen_at: "2026-06-25T10:00:00Z" },
    ] as unknown as LeadRow[];
    const t = campaignDailyTrend(trendLeads, {}, "UTC");
    expect(t.rows.map((r) => r.date)).toEqual(["2026-06-24", "2026-06-25"]);
    expect(t.series.map((s) => s.key)).toEqual(["A", "B"]); // A (2 leads) before B (1)
    const d25 = t.rows.find((r) => r.date === "2026-06-25")!;
    expect(d25["A"]).toBe(1);
    expect(d25["B"]).toBe(1);
    expect(t.rows.find((r) => r.date === "2026-06-24")!["B"]).toBe(0);
  });

  it("returns [] when there are no campaign-attributed leads", () => {
    const organic = [
      { phone: "x", source: null, ad_id: null, ad_headline: null, has_order: true },
    ] as unknown as LeadRow[];
    expect(campaignBreakdown(organic, orders)).toEqual([]);
  });
});

// El carrito COD de la web vende sin pasar por WhatsApp: 591 pedidos y S/93.588
// en 30 días, 488 de ellos sin lead ninguno. El panel los ignoraba y enseñaba en
// cero a 32 campañas con S/34.825 de gasto. El porqué está en
// lib/cod-cart-attribution.ts.
describe("los pedidos del carrito COD de la web", () => {
  // Ids con la forma real de Meta: 18 dígitos. Es lo que el resolutor busca, y
  // con un «ad-web» cualquiera las pruebas pasarían sin emparejar nada.
  const AD = "120200000000000001";
  const ADSET = "120200000000000002";
  const CAMP = "120200000000000003";
  const catalogo: AnuncioMeta[] = [
    { adId: AD, adsetId: ADSET, campaignId: CAMP, adName: "creativo uno" },
    { adId: "120200000000000009", adsetId: ADSET, campaignId: CAMP, adName: "creativo dos" },
  ];
  const pedidoWeb = (id: string, total: number, utm: Partial<WebAdOrder["utm"]>): WebAdOrder => ({
    order: {
      id,
      name: `#W${id}`,
      created_at: "2026-09-10T12:00:00Z",
      total_amount: total,
      total_refunded: 0,
      line_items: [{ title: "Aceite Etíope", sku: "ETH-1", quantity: 1 }],
    } as unknown as OrderRow,
    utm: {
      utmId: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmContent: null,
      utmTerm: null,
      ...utm,
    },
  });

  it("se suman al anuncio que los trajo, y se pueden distinguir de los de WhatsApp", () => {
    const rows = campaignBreakdown(
      [],
      [],
      {},
      [],
      [],
      [pedidoWeb("w1", 150, { utmId: CAMP, utmContent: AD })],
      catalogo,
    );
    const fila = rows.find((r) => r.adId === AD)!;
    expect(fila).toMatchObject({ pedidos: 1, ingresos: 150, webPedidos: 1, webIngresos: 150, leads: 0 });
    expect(fila.orders[0]!.code).toBe("#Ww1");
    // El desglose de productos es lo que se ve al abrir la fila. Si los pedidos
    // web no entraran, el anuncio que solo vende por la web se abriría vacío.
    expect(fila.productMix).toEqual([
      { title: "Aceite Etíope", sku: "ETH-1", orders: 1, units: 1 },
    ]);
  });

  // En un negocio COD lo entregado es lo único cobrado, y el ROAS ENTREGADO es
  // lo que se mira para escalar o cortar. Si la entrega de estos pedidos no
  // llegara, el anuncio que vende por la web saldría vendiendo y no entregando.
  it("su entrega cuenta: el ROAS entregado no se queda en cero", () => {
    const gasto = [{
      storeId: "s1", adId: AD, accountId: "act", currency: "PEN", metaConversations: 0,
      spend: 100, impressions: 5000, reach: 4000, clicks: 50, inlineLinkClicks: 40,
      activeDays: 10, firstDate: "2026-09-01", lastDate: "2026-09-10", syncedAt: "2026-09-11T00:00:00Z",
    }] as unknown as MetaAdPerformance[];
    const web = [
      pedidoWeb("w1", 200, { utmId: CAMP, utmContent: AD }),
      pedidoWeb("w2", 100, { utmId: CAMP, utmContent: AD }),
    ];
    const entregas = [
      { orderId: "w1", deliveryStatus: "Entregado", statusCategory: "delivered", createdAt: "2026-09-11T00:00:00Z" },
      { orderId: "w2", deliveryStatus: "Anulado", statusCategory: "cancelled", createdAt: "2026-09-11T00:00:00Z" },
    ];
    const [fila] = campaignBreakdown([], [], {}, entregas, gasto, web, catalogo);
    expect(fila!.deliveredOrders).toBe(1);
    expect(fila!.cancelledOrders).toBe(1);
    expect(fila!.shipmentKnown).toBe(2);
    expect(fila!.deliveredRevenue).toBe(200);
    expect(fila!.deliveredRoas).toBe(2); // 200 entregados sobre 100 de gasto
  });

  // Sin este arreglo la fila decía «Meta registra inversión, pero no hay leads
  // internos vinculados al anuncio» sobre un anuncio que estaba vendiendo.
  it("un anuncio con gasto y ventas web ya no sale como «sin atribución»", () => {
    const gasto = [{
      storeId: "s1", adId: AD, accountId: "act", currency: "PEN", metaConversations: 0,
      spend: 100, impressions: 5000, reach: 4000, clicks: 50, inlineLinkClicks: 40,
      activeDays: 10, firstDate: "2026-09-01", lastDate: "2026-09-10", syncedAt: "2026-09-11T00:00:00Z",
    }] as unknown as MetaAdPerformance[];
    const web = Array.from({ length: 10 }, (_, i) =>
      pedidoWeb(`w${i}`, 50, { utmId: CAMP, utmContent: AD }),
    );
    const [fila] = campaignBreakdown([], [], {}, [], gasto, web, catalogo);
    expect(fila!.decision).not.toBe("no_attribution");
    expect(fila!.roas).toBe(5); // 500 de venta sobre 100 de gasto
    // Es el único anuncio del panel, así que ES el promedio: iguala la
    // referencia, no la supera. Para escalar hay que ir por encima del resto.
    expect(fila!.decision).toBe("promising");
  });

  it("escala cuando su ROAS va por encima del promedio del panel", () => {
    const gasto = [
      {
        storeId: "s1", adId: AD, accountId: "act", currency: "PEN", metaConversations: 0,
        spend: 100, impressions: 5000, reach: 4000, clicks: 50, inlineLinkClicks: 40,
        activeDays: 10, firstDate: "2026-09-01", lastDate: "2026-09-10", syncedAt: "2026-09-11T00:00:00Z",
      },
      {
        storeId: "s1", adId: "120200000000000009", accountId: "act", currency: "PEN", metaConversations: 0,
        spend: 900, impressions: 5000, reach: 4000, clicks: 50, inlineLinkClicks: 40,
        activeDays: 10, firstDate: "2026-09-01", lastDate: "2026-09-10", syncedAt: "2026-09-11T00:00:00Z",
      },
    ] as unknown as MetaAdPerformance[];
    const web = Array.from({ length: 10 }, (_, i) =>
      pedidoWeb(`w${i}`, 50, { utmId: CAMP, utmContent: AD }),
    );
    const rows = campaignBreakdown([], [], {}, [], gasto, web, catalogo);
    const fila = rows.find((r) => r.adId === AD)!;
    expect(fila.roas).toBe(5); // contra un promedio del panel de 500/1000 = 0,5
    expect(fila.decision).toBe("scale");
  });

  // El ROAS es la única vara que tiene un anuncio sin leads, y por debajo de 1
  // no devuelve ni lo que costó por mucho que el panel entero vaya peor.
  it("por debajo de 1 nunca es «prometedor», aunque el promedio del panel sea peor", () => {
    const gasto = [{
      storeId: "s1", adId: AD, accountId: "act", currency: "PEN", metaConversations: 0,
      spend: 1000, impressions: 5000, reach: 4000, clicks: 50, inlineLinkClicks: 40,
      activeDays: 10, firstDate: "2026-09-01", lastDate: "2026-09-10", syncedAt: "2026-09-11T00:00:00Z",
    }] as unknown as MetaAdPerformance[];
    const web = Array.from({ length: 10 }, (_, i) =>
      pedidoWeb(`w${i}`, 20, { utmId: CAMP, utmContent: AD }),
    );
    const [fila] = campaignBreakdown([], [], {}, [], gasto, web, catalogo);
    expect(fila!.roas).toBe(0.2);
    expect(fila!.decision).toBe("review_close");
  });

  // La conversión es pedidos-de-lead partido por leads. Si entraran los del
  // carrito COD saldrían anuncios convirtiendo por encima del 100%.
  it("NO entran en la conversión, que sigue siendo la de los leads", () => {
    const leadsAd = [
      { store_id: "s1", phone: "1", source: "meta_ad", ad_id: AD, ad_headline: "H", order_id: "order-1", first_seen_at: "2026-09-01T00:00:00Z" },
      { store_id: "s1", phone: "2", source: "meta_ad", ad_id: AD, ad_headline: "H", first_seen_at: "2026-09-01T00:00:00Z" },
    ] as unknown as LeadRow[];
    const [fila] = campaignBreakdown(
      leadsAd,
      orders,
      {},
      [],
      [],
      [pedidoWeb("w1", 150, { utmId: CAMP, utmContent: AD })],
      catalogo,
    );
    expect(fila!.leads).toBe(2);
    expect(fila!.pedidos).toBe(2); // uno de lead y uno de la web
    expect(fila!.conversion).toBeCloseTo(0.5); // 1 pedido de lead / 2 leads
    expect(fila!.revenuePerLead).toBe(109.5); // 219 del lead / 2, sin los 150 de la web
  });

  // Pasa en 6 de 591 pedidos. Contarlo dos veces subiría el ROAS del anuncio sin
  // que nada lo delate.
  it("un pedido que YA tiene lead de anuncio no se cuenta dos veces", () => {
    const leadsAd = [
      { store_id: "s1", phone: "1", source: "meta_ad", ad_id: AD, ad_headline: "H", order_id: "order-1", first_seen_at: "2026-09-01T00:00:00Z" },
    ] as unknown as LeadRow[];
    const mismoPedido: WebAdOrder = {
      ...pedidoWeb("order-1", 219, { utmId: CAMP, utmContent: AD }),
    };
    const [fila] = campaignBreakdown(leadsAd, orders, {}, [], [], [mismoPedido], catalogo);
    expect(fila!.pedidos).toBe(1);
    expect(fila!.ingresos).toBe(219);
    expect(fila!.webPedidos).toBe(0);
  });

  // Repartir entre los anuncios de la campaña un pedido que solo llegó a nivel
  // de campaña sería inventar de qué creatividad salió, que es justo lo que se
  // decide mirando esta tabla.
  it("lo que solo llega a nivel de campaña se cuenta aparte, no se reparte", () => {
    const web = [
      pedidoWeb("w1", 300, { utmId: CAMP, utmSource: "facebook" }), // sin pista de anuncio
      pedidoWeb("w2", 150, { utmId: CAMP, utmContent: AD }),
    ];
    const rows = campaignBreakdown([], [], {}, [], [], web, catalogo);
    expect(rows.reduce((sum, r) => sum + r.webIngresos, 0)).toBe(150);
    expect(webNoAtribuido([], web, catalogo)).toEqual({ pedidos: 1, ingresos: 300 });
  });

  // El promedio contra el que se compara la conversión sale SOLO de pedidos de
  // lead. Si entraran los del carrito COD, el divisor seguiría siendo los leads
  // y el promedio se dispararía: el anuncio de WhatsApp que convierte igual que
  // siempre caería a «revisar o cerrar» por lo que vendió OTRO anuncio en la web.
  it("los pedidos web NO inflan el promedio con el que se juzga a los de WhatsApp", () => {
    const leadsWa = Array.from({ length: 20 }, (_, i) => ({
      store_id: "s1", phone: `5199${i}`, source: "meta_ad", ad_id: "120200000000000077",
      ad_headline: "WhatsApp", first_seen_at: "2026-09-01T00:00:00Z",
      order_id: i < 6 ? `wa-${i}` : null,
    })) as unknown as LeadRow[];
    const pedidosWa = Array.from({ length: 6 }, (_, i) => ({
      id: `wa-${i}`, name: `#WA${i}`, created_at: "2026-09-02T00:00:00Z",
      total_amount: 100, total_refunded: 0, cancelled_at: null, line_items: [],
    })) as unknown as OrderRow[];
    const entregas = pedidosWa.map((o) => ({
      orderId: o.id!, deliveryStatus: "Entregado", statusCategory: "delivered",
      createdAt: "2026-09-03T00:00:00Z",
    }));
    const gasto = [
      {
        storeId: "s1", adId: "120200000000000077", accountId: "act", currency: "PEN",
        metaConversations: 0, spend: 100, impressions: 5000, reach: 4000, clicks: 50,
        inlineLinkClicks: 40, activeDays: 10, firstDate: "2026-09-01", lastDate: "2026-09-10",
        syncedAt: "2026-09-11T00:00:00Z",
      },
    ] as unknown as MetaAdPerformance[];
    // 50 pedidos web de OTRO anuncio, que es lo que inflaría el promedio.
    const web = Array.from({ length: 50 }, (_, i) =>
      pedidoWeb(`w${i}`, 50, { utmId: CAMP, utmContent: AD }),
    );
    const rows = campaignBreakdown(leadsWa, pedidosWa, {}, entregas, gasto, web, catalogo);
    const wa = rows.find((r) => r.adId === "120200000000000077")!;
    expect(wa.conversion).toBeCloseTo(0.3); // 6 pedidos de lead / 20 leads
    expect(wa.decision).toBe("promising");
  });

  // La vara del ROAS es para el anuncio que NO genera leads, porque ahí no hay
  // conversión que medir. El que sí los genera se sigue juzgando por su
  // conversión: si unas cuantas ventas web le dispararan el ROAS, un anuncio
  // que trae leads y no los cierra saldría como «escalar».
  it("un anuncio que SÍ trae leads se sigue juzgando por conversión, no por ROAS", () => {
    const leadsWa = Array.from({ length: 20 }, (_, i) => ({
      store_id: "s1", phone: `5199${i}`, source: "meta_ad", ad_id: AD,
      ad_headline: "WhatsApp", first_seen_at: "2026-09-01T00:00:00Z",
      order_id: i < 6 ? `wa-${i}` : null,
    })) as unknown as LeadRow[];
    const pedidosWa = Array.from({ length: 6 }, (_, i) => ({
      id: `wa-${i}`, name: `#WA${i}`, created_at: "2026-09-02T00:00:00Z",
      total_amount: 100, total_refunded: 0, cancelled_at: null, line_items: [],
    })) as unknown as OrderRow[];
    const entregas = pedidosWa.map((o) => ({
      orderId: o.id!, deliveryStatus: "Entregado", statusCategory: "delivered",
      createdAt: "2026-09-03T00:00:00Z",
    }));
    const gasto = [
      {
        storeId: "s1", adId: AD, accountId: "act", currency: "PEN", metaConversations: 0,
        spend: 100, impressions: 5000, reach: 4000, clicks: 50, inlineLinkClicks: 40,
        activeDays: 10, firstDate: "2026-09-01", lastDate: "2026-09-10", syncedAt: "2026-09-11T00:00:00Z",
      },
      {
        storeId: "s1", adId: "120200000000000009", accountId: "act", currency: "PEN", metaConversations: 0,
        spend: 900, impressions: 5000, reach: 4000, clicks: 50, inlineLinkClicks: 40,
        activeDays: 10, firstDate: "2026-09-01", lastDate: "2026-09-10", syncedAt: "2026-09-11T00:00:00Z",
      },
    ] as unknown as MetaAdPerformance[];
    // 50 ventas web para el MISMO anuncio: ROAS 31 contra un promedio de 3,1.
    const web = Array.from({ length: 50 }, (_, i) =>
      pedidoWeb(`w${i}`, 50, { utmId: CAMP, utmContent: AD }),
    );
    const fila = campaignBreakdown(leadsWa, pedidosWa, {}, entregas, gasto, web, catalogo)
      .find((r) => r.adId === AD)!;
    expect(fila.webPedidos).toBe(50);
    expect(fila.roas).toBe(31);
    expect(fila.decision).toBe("promising"); // por su conversión de 0,30, no por el 31×
    expect(fila.decisionReason).toContain("Conversión");
  });

  it("el resumen de lo no atribuido no cuenta lo que ya acreditó un lead", () => {
    const leadsAd = [
      { store_id: "s1", phone: "1", source: "meta_ad", ad_id: AD, ad_headline: "H", order_id: "w1" },
    ] as unknown as LeadRow[];
    const web = [pedidoWeb("w1", 300, { utmId: CAMP, utmSource: "facebook" })];
    expect(webNoAtribuido(leadsAd, web, catalogo)).toEqual({ pedidos: 0, ingresos: 0 });
  });
});
