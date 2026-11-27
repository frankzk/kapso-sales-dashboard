// Pedido nuevo: primero Swayp (owner, 27-11-2026; MOM §11.14). «queremos poner de
// primera opcion a los pedidos nuevos de cuando tenemos el stock commpleto en
// Swayp, la opcion que es si no se entrega, regresa a "Por confimar"»: nuevo es
// la primera salida y 48 h o menos; Aliclik deja de ser la sugerencia sin
// bloquearse; lo envía la asesora con el botón.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SWAYP_PRIMERO_MAX_HOURS,
  SWAYP_PRIMERO_NOTE,
  SWAYP_PRIMERO_TITLE,
  swaypPrimero,
} from "@/lib/swayp-desde-confirmacion-offer";
import {
  SWAYP_PRIMERO_ALICLIK_REASON,
  SWAYP_PRIMERO_ROUTE_REASON,
  buildOrderRoutePlan,
  type SwaypRouteCheck,
} from "@/lib/order-route-plan";
import { defaultLeadPostOrderChoice, leadPostOrderChoices, type LeadPostOrderInput } from "@/lib/lead-post-order";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

const NOW = new Date("2026-11-27T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
const STOCK: SwaypRouteCheck = { known: true, covered: true, stockOk: true, city: "huancayo", uncovered: [], unlinked: [] };
const row = (extra: Record<string, unknown> = {}) => ({
  macro_stage: "por_confirmar",
  macro_substage: "por_contactar",
  coverage: "provincia_cod",
  order_created_at: hoursAgo(3),
  ...extra,
});

describe("qué es un pedido nuevo para Swayp", () => {
  it("provincia COD en Por confirmar, sin guías, de 48 h o menos y con stock completo", () => {
    expect(SWAYP_PRIMERO_MAX_HOURS).toBe(48);
    expect(swaypPrimero({ row: row(), outputs: 0, swayp: STOCK, now: NOW })).toBe(true);
    expect(swaypPrimero({ row: row({ order_created_at: hoursAgo(48) }), outputs: 0, swayp: STOCK, now: NOW })).toBe(true);
  });

  it("no es nuevo: ya tuvo una guía, pasaron 48 h o no se sabe cuándo se creó", () => {
    expect(swaypPrimero({ row: row(), outputs: 1, swayp: STOCK, now: NOW })).toBe(false);
    expect(swaypPrimero({ row: row({ order_created_at: hoursAgo(48.1) }), outputs: 0, swayp: STOCK, now: NOW })).toBe(false);
    expect(swaypPrimero({ row: row({ order_created_at: null }), outputs: 0, swayp: STOCK, now: NOW })).toBe(false);
  });

  it("solo en Por confirmar de provincia COD, y nunca en «Swayp no entregó»", () => {
    expect(swaypPrimero({ row: row({ macro_stage: "preparacion" }), outputs: 0, swayp: STOCK, now: NOW })).toBe(false);
    expect(swaypPrimero({ row: row({ macro_substage: "swayp_no_entrego" }), outputs: 0, swayp: STOCK, now: NOW })).toBe(false);
    expect(swaypPrimero({ row: row({ coverage: "lima" }), outputs: 0, swayp: STOCK, now: NOW })).toBe(false);
    expect(swaypPrimero({ row: row({ coverage: "agencia" }), outputs: 0, swayp: STOCK, now: NOW })).toBe(false);
  });

  it("stock completo: cobertura, todos los productos vinculados y con stock", () => {
    for (const swayp of [
      null,
      { known: false },
      { ...STOCK, covered: false },
      { ...STOCK, stockOk: false, uncovered: ["Magnesio 12 en 1"] },
      { ...STOCK, unlinked: ["Producto sin vínculo"] },
    ] as (SwaypRouteCheck | null)[]) {
      expect(swaypPrimero({ row: row(), outputs: 0, swayp, now: NOW }), JSON.stringify(swayp)).toBe(false);
    }
  });
});

describe("la Mesa de ruta", () => {
  const plan = (swaypFirst: boolean, swayp: SwaypRouteCheck = STOCK) =>
    buildOrderRoutePlan({ operation: "provincia_cod", outputs: [], paymentState: "sin_pago", swayp, swaypFirst });

  it("Swayp primero y sugerido, con «sale sin confirmar»; Aliclik segundo, se puede elegir igual", () => {
    const p = plan(true);
    expect(p.swaypFirst).toBe(true);
    expect(p.candidates.map((c) => c.key).slice(0, 2)).toEqual(["swayp", "aliclik"]);
    const swayp = p.candidates.find((c) => c.key === "swayp")!;
    expect(swayp).toMatchObject({ recommended: true, availability: "available", reason: SWAYP_PRIMERO_ROUTE_REASON("huancayo") });
    const aliclik = p.candidates.find((c) => c.key === "aliclik")!;
    expect(aliclik).toMatchObject({ recommended: false, reason: SWAYP_PRIMERO_ALICLIK_REASON });
    expect(aliclik.availability).not.toBe("blocked");
    expect(p.candidates.filter((c) => c.recommended)).toHaveLength(1);
  });

  it("sin pedido nuevo, como siempre: Aliclik primero y sugerido", () => {
    const p = plan(false);
    expect(p.swaypFirst).toBe(false);
    expect(p.candidates[0]).toMatchObject({ key: "aliclik", recommended: true, reason: "Primera ruta sugerida para Provincia COD." });
  });

  it("si Swayp no puede, la sugerencia vuelve a Aliclik; y en Lima no aplica", () => {
    const sinStock = plan(true, { ...STOCK, stockOk: false, uncovered: ["X"] });
    expect(sinStock.swaypFirst).toBe(false);
    expect(sinStock.candidates[0]).toMatchObject({ key: "aliclik", recommended: true, reason: "Primera ruta sugerida para Provincia COD." });
    const lima = buildOrderRoutePlan({ operation: "lima", outputs: [], swayp: STOCK, swaypFirst: true });
    expect(lima.swaypFirst).toBe(false);
  });
});

describe("Leads, después de «Generar pedido»", () => {
  const base: LeadPostOrderInput = {
    orderId: "o1",
    orderName: "#KP1",
    row: {
      current_courier: null,
      shipping_mode: "cod",
      macro_stage: "por_confirmar",
      macro_substage: "por_contactar",
      macro_reasons: [],
      coverage: "provincia_cod",
      swayp_availability: null,
      payment_state: "sin_pago",
      financial_status: "pending",
      total_refunded: 0,
      payment_gateway: "cod",
      guide_code: null,
    },
    routePlan: plan(true),
    travelsInCompanion: false,
    guides: [],
    brief: null,
    shalomDraft: null,
    perms: { canEdit: true, canCreateGuide: true, canCreateShalomGuide: true },
  };
  function plan(swaypFirst: boolean) {
    return buildOrderRoutePlan({ operation: "provincia_cod", outputs: [], paymentState: "sin_pago", swayp: STOCK, swaypFirst });
  }

  it("«Swayp hoy» va primero y se abre sola, aunque la pasada horaria todavía no lo evaluó", () => {
    const c = leadPostOrderChoices(base);
    expect(c.swayp).toEqual({ offered: true, reason: null, guides: [], first: true });
    expect(c.aliclik.offered).toBe(true);
    expect(defaultLeadPostOrderChoice(c)).toBe("swayp");
  });

  it("sin pedido nuevo se abre Aliclik, como antes", () => {
    const c = leadPostOrderChoices({ ...base, row: { ...base.row, swayp_availability: "ok" }, routePlan: plan(false) });
    expect(c.swayp.first).toBe(false);
    expect(defaultLeadPostOrderChoice(c)).toBe("aliclik");
  });

  it("con la guía Swayp ya creada, ya no es «primero»: dice la guía", () => {
    const c = leadPostOrderChoices({
      ...base,
      guides: [{ courier: "fenix", guide_code: "50000170000", delivery_status: "pendiente" }],
    });
    expect(c.swayp).toMatchObject({ offered: false, guides: ["50000170000"], first: false });
    expect(defaultLeadPostOrderChoice(c)).toBe("swayp");
  });
});

describe("dónde se ve", () => {
  it("la ficha: arriba de las llamadas con el botón principal, y la tarjeta de Swayp envía desde Por confirmar", () => {
    const drawer = read("components/order-drawer.tsx");
    const desk = drawer.indexOf("<ConfirmationDesk");
    const first = drawer.indexOf("{detail.routePlan.swaypFirst && (");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(desk);
    expect(drawer.slice(first, desk)).toContain('setSwaypOrigen("por_confirmar");');
    expect(drawer.slice(first, desk)).toContain("first");
    expect(drawer).toContain('setSwaypOrigen(detail?.routePlan.swaypFirst ? "por_confirmar" : undefined);');
    const loader = read("lib/orders-master-access.ts");
    expect(loader).toContain("swaypFirst: swaypPrimero({ row, outputs: guides.length, swayp, now: new Date() }),");
  });

  it("el bloque dice que es la primera opción y qué pasa si Swayp no entrega", () => {
    const block = read("components/swayp-desde-confirmacion-offer.tsx");
    expect(block).toContain("{first ? SWAYP_PRIMERO_TITLE");
    expect(block).toContain("? SWAYP_PRIMERO_NOTE");
    expect(block).toContain('variant={first ? "primary" : undefined}');
    expect(SWAYP_PRIMERO_TITLE).toBe("Pedido nuevo: primero Swayp");
  });

  it("la Mesa de ruta nombra el botón y Leads ordena las tarjetas sin duplicarlas", () => {
    expect(read("components/order-route-desk.tsx")).toContain('route.action === "swayp" && plan.swaypFirst\n                    ? "Enviar por Swayp"');
    const leads = read("components/lead-post-order-choices.tsx");
    expect(leads).toContain("{swayp.first ? [swaypTile, aliclikTile] : [aliclikTile, swaypTile]}");
    expect(leads.match(/\slabel="Guía Aliclik"/g)).toHaveLength(1);
    expect(leads.match(/\slabel="Swayp hoy"/g)).toHaveLength(1);
  });
});

describe("el MOM (§11.14)", () => {
  const mom = flat(read("docs/mom/master-pedidos-v1.md"));
  it("las palabras del owner, sus respuestas y los textos tal cual", () => {
    expect(mom).toContain("### 11.14 Pedido nuevo: primero Swayp (27-11-2026)");
    expect(mom).toContain(
      "«queremos poner de primera opcion a los pedidos nuevos de cuando tenemos el stock commpleto en Swayp, la opcion que es si no se entrega, regresa a \"Por confimar\"»",
    );
    expect(mom).toContain("«que se bloquee Aliclik como primera opcion para estos pedidos. La idea es darle pedidos nuevos y limpios a Swayp»");
    expect(mom).toContain("**Pedido nuevo** es la primera salida y 48 h o menos desde que se creó");
    expect(mom).toContain("**Aliclik deja de ser la sugerencia, sin bloquearse** («Solo sugerencia»)");
    expect(mom).toContain("**Lo envía la asesora, con el botón.**");
    expect(mom).toContain(`«${SWAYP_PRIMERO_ROUTE_REASON("<ciudad>")}»`);
    expect(mom).toContain(`«${SWAYP_PRIMERO_ALICLIK_REASON}»`);
    expect(mom).toContain(`«${SWAYP_PRIMERO_TITLE}»`);
    expect(mom).toContain(`«${SWAYP_PRIMERO_NOTE}»`);
    expect(mom).toContain("Swayp primero, desde Por confirmar (§11.14).");
  });
});
