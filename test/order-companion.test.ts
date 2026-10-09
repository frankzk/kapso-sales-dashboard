// Pedido acompañante (MOM §32): un pedido que viaja en la caja —salida y
// guía— de otro. Los casos son los reales del 15-09 al 02-10-2026: la misma
// clienta con un pedido de Kenku y otro de Aurela, una sola guía de Aliclik.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPANION_LINKED,
  COMPANION_UNLINKED,
  activeCompanionLinks,
  borrowedHostEvents,
  companionCollectTotal,
  companionDoorFollowers,
  companionLabelContent,
  companionLinkProblem,
  companionPartnerIds,
  companionTotalsByHost,
  lentShipment,
  normalizeOrderNameInput,
  phoneKey,
  shipmentLendsState,
  type CompanionEventLike,
  type CompanionLinkCheck,
} from "@/lib/order-companion";
import { resolveOrderState, type GuideSnapshot } from "@/lib/order-status";
import {
  MACRO_SUBSTAGES_BY_STAGE,
  macroSubstageLabel,
  resolveMacroStage,
  type MacroGuideSnapshot,
  type ResolveMacroStageInput,
} from "@/lib/order-macro-stage";
import { reconcileLine, type SettlementLineInput } from "@/lib/settlements";
import { routeDeskGate } from "@/lib/order-route-plan";
import { recomputeOrderMaster } from "@/lib/order-master";

const HOST = "order-aur177622";
const COMPANION = "order-kp137851";
const BOX = "ship-aur5xaur177622";

function linkEvent(
  orderId: string,
  role: "companion" | "host",
  over: Partial<CompanionEventLike> & { kind?: string } = {},
  payload: Record<string, unknown> = {},
): CompanionEventLike {
  return {
    order_id: orderId,
    kind: COMPANION_LINKED,
    occurred_at: "2026-10-05T15:00:00.000Z",
    shipment_id: BOX,
    ...over,
    payload: {
      role,
      link_id: "link-1",
      companion_order_id: COMPANION,
      companion_order_name: "#KP137851",
      host_order_id: HOST,
      host_order_name: "#AUR177622",
      host_shipment_id: BOX,
      host_guide_code: "AUR5XAUR177622",
      ...payload,
    },
  };
}

describe("el vínculo vigente lo dice el lado acompañante", () => {
  it("un companion_linked del acompañante es un vínculo; el espejo del principal no cuenta solo", () => {
    expect(activeCompanionLinks([linkEvent(HOST, "host")])).toEqual([]);
    const [link] = activeCompanionLinks([linkEvent(COMPANION, "companion"), linkEvent(HOST, "host")]);
    expect(link).toMatchObject({
      companionOrderId: COMPANION,
      hostOrderId: HOST,
      hostShipmentId: BOX,
      hostOrderName: "#AUR177622",
      hostGuideCode: "AUR5XAUR177622",
    });
  });

  it("desvincular después lo apaga; volver a vincular a otra caja lo mueve", () => {
    const linked = linkEvent(COMPANION, "companion");
    const unlinked = linkEvent(COMPANION, "companion", { kind: COMPANION_UNLINKED, occurred_at: "2026-10-06T10:00:00.000Z" });
    expect(activeCompanionLinks([linked, unlinked])).toEqual([]);
    const relinked = linkEvent(
      COMPANION,
      "companion",
      { occurred_at: "2026-10-07T10:00:00.000Z", shipment_id: "ship-swayp" },
      { host_shipment_id: "ship-swayp", host_guide_code: "SW-1" },
    );
    expect(activeCompanionLinks([relinked, linked, unlinked])[0]?.hostShipmentId).toBe("ship-swayp");
  });

  it("un hecho que dice ser del acompañante pero vive en otro pedido no se cree", () => {
    expect(activeCompanionLinks([linkEvent(HOST, "companion")])).toEqual([]);
  });

  it("los dos lados se nombran entre sí, para recalcularlos juntos", () => {
    expect(companionPartnerIds([linkEvent(COMPANION, "companion")])).toEqual([HOST]);
    expect(companionPartnerIds([linkEvent(HOST, "host")])).toEqual([COMPANION]);
    expect(companionPartnerIds([{ order_id: HOST, kind: "comment", occurred_at: "x" }])).toEqual([]);
  });
});

describe("qué caja presta su estado (regla 9)", () => {
  const box = {
    id: BOX,
    order_id: HOST,
    courier: "aliclik",
    guide_code: "AUR5XAUR177622",
    delivery_status: "entregado",
  };

  it("viva, entregada o de vuelta, presta; anulada sin salir, no", () => {
    expect(shipmentLendsState({ delivery_status: "pendiente" })).toBe(true);
    expect(shipmentLendsState({ delivery_status: "entregado" })).toBe(true);
    expect(shipmentLendsState({ delivery_status: "anulado" })).toBe(false);
    expect(shipmentLendsState({ delivery_status: "anulado", dispatched_at: "2026-10-01T10:00:00Z" })).toBe(true);
    expect(shipmentLendsState({ delivery_status: "anulado", custody_transferred_at: "2026-10-01T10:00:00Z" })).toBe(true);
  });

  it("si la salida ya es de otro pedido, el vínculo se queda sin caja", () => {
    const link = { hostOrderId: HOST, hostShipmentId: BOX };
    expect(lentShipment(link, new Map([[BOX, box]]))).toBe(box);
    expect(lentShipment(link, new Map([[BOX, { ...box, order_id: "otro" }]]))).toBeNull();
    expect(lentShipment(null, new Map([[BOX, box]]))).toBeNull();
  });

  it("hereda los hechos de esa caja y la liquidación, no las decisiones del principal", () => {
    const hostEvents = [
      { kind: "return_received", shipment_id: BOX },
      { kind: "return_received", shipment_id: "otra-caja" },
      { kind: "liquidation_closed", shipment_id: null },
      { kind: "liquidation_observed", shipment_id: "otra-caja" },
      { kind: "status_override", shipment_id: null },
      { kind: "guide_registered", shipment_id: BOX },
      { kind: "comment", shipment_id: BOX },
      { kind: "order_finalized", shipment_id: null },
      { kind: COMPANION_LINKED, shipment_id: BOX },
    ];
    expect(borrowedHostEvents(hostEvents, BOX).map((e) => `${e.kind}:${e.shipment_id}`)).toEqual([
      `return_received:${BOX}`,
      "liquidation_closed:null",
      "liquidation_observed:otra-caja",
    ]);
  });
});

function check(over: {
  companion?: Partial<CompanionLinkCheck["companion"]>;
  host?: Partial<CompanionLinkCheck["host"]>;
  shipment?: Partial<CompanionLinkCheck["shipment"]>;
  reason?: string | null;
} = {}): CompanionLinkCheck {
  return {
    companion: {
      orderId: COMPANION,
      orderName: "#KP137851",
      phone: "51965702673",
      cancelledAt: null,
      macroStage: "preparacion",
      liveOwnOutputs: 0,
      hostsCompanions: false,
      activeLink: null,
      ...over.companion,
    },
    host: { orderId: HOST, orderName: "#AUR177622", phone: "965702673", isCompanion: false, ...over.host },
    shipment: {
      id: BOX,
      order_id: HOST,
      courier: "aliclik",
      guide_code: "AUR5XAUR177622",
      delivery_status: "pendiente",
      ...over.shipment,
    },
    reason: over.reason === undefined ? "Misma clienta, sale en una sola guía" : over.reason,
  };
}

describe("quién puede viajar en qué caja (reglas 2 y 3)", () => {
  it("el caso real se puede vincular, también con la caja ya entregada", () => {
    expect(companionLinkProblem(check())).toBeNull();
    expect(companionLinkProblem(check({ shipment: { delivery_status: "entregado" } }))).toBeNull();
    expect(companionLinkProblem(check({ shipment: { delivery_status: "en_ruta" } }))).toBeNull();
  });

  it("la vista previa no pide motivo; vincular sí", () => {
    expect(companionLinkProblem(check({ reason: null }))).toBeNull();
    expect(companionLinkProblem(check({ reason: "corto" }))).toMatch(/8 caracteres/);
  });

  it("solo Aliclik, con guía, y no anulada sin salir", () => {
    expect(companionLinkProblem(check({ shipment: { courier: "shalom" } }))).toMatch(/solo una guía de Aliclik/);
    expect(companionLinkProblem(check({ shipment: { guide_code: null } }))).toMatch(/todavía no tiene guía/);
    expect(companionLinkProblem(check({ shipment: { delivery_status: "anulado" } }))).toMatch(/anuló sin salir/);
    expect(
      companionLinkProblem(check({ shipment: { delivery_status: "anulado", dispatched_at: "2026-10-01T10:00:00Z" } })),
    ).toBeNull();
    expect(companionLinkProblem(check({ shipment: { order_id: "otro" } }))).toMatch(/ya no es de/);
  });

  it("una caja va a una sola clienta: el teléfono tiene que coincidir", () => {
    expect(companionLinkProblem(check({ host: { phone: "51999888777" } }))).toMatch(/no coinciden/);
    expect(companionLinkProblem(check({ companion: { phone: null } }))).toMatch(/Falta el teléfono/);
  });

  it("sin cadenas, sin salida propia viva, sin anulados ni finalizados", () => {
    expect(companionLinkProblem(check({ companion: { orderId: HOST } }))).toMatch(/su propia caja/);
    expect(companionLinkProblem(check({ host: { isCompanion: true } }))).toMatch(/viaja a su vez/);
    expect(companionLinkProblem(check({ companion: { hostsCompanions: true } }))).toMatch(/ya lleva otros/);
    expect(companionLinkProblem(check({ companion: { liveOwnOutputs: 1 } }))).toMatch(/salida propia viva/);
    expect(companionLinkProblem(check({ companion: { cancelledAt: "2026-10-01T00:00:00Z" } }))).toMatch(/anulado en Shopify/);
    expect(companionLinkProblem(check({ companion: { macroStage: "finalizado" } }))).toMatch(/finalizado/);
  });

  it("ya vinculado: a esta caja o a otra", () => {
    const [link] = activeCompanionLinks([linkEvent(COMPANION, "companion")]);
    expect(companionLinkProblem(check({ companion: { activeLink: link! } }))).toMatch(/Ya viaja en esta caja/);
    expect(companionLinkProblem(check({ companion: { activeLink: { ...link!, hostShipmentId: "otra" } } }))).toMatch(
      /Desvincúlalo primero/,
    );
  });

  it("el nombre del pedido y el teléfono se leen como los escribe la gente", () => {
    expect(normalizeOrderNameInput(" aur177622 ")).toBe("#AUR177622");
    expect(normalizeOrderNameInput("#KP137851")).toBe("#KP137851");
    expect(normalizeOrderNameInput("hola mundo")).toBeNull();
    expect(phoneKey("+51 965 702 673")).toBe("965702673");
    expect(phoneKey("965702673")).toBe("965702673");
    expect(phoneKey("1234")).toBeNull();
  });
});

describe("el cobro de la caja es la suma (regla 11)", () => {
  it("la guía cobra el principal más sus acompañantes", () => {
    expect(companionCollectTotal(116.1, [104])).toBe(220.1);
    expect(companionCollectTotal(215, [149, null])).toBe(364);
  });

  it("los totales se agrupan por principal", () => {
    const totals = companionTotalsByHost(
      [
        { companionOrderId: "c1", hostOrderId: "h1" },
        { companionOrderId: "c2", hostOrderId: "h1" },
        { companionOrderId: "c3", hostOrderId: "h2" },
      ],
      new Map([
        ["c1", 104],
        ["c2", 62],
        ["c3", null],
      ]),
    );
    expect(totals).toEqual(new Map([["h1", 166], ["h2", 0]]));
  });

  it("la fila de #AUR176985 por S/ 364 coincide con #KP134433 dentro", () => {
    const line: SettlementLineInput = {
      id: "l1",
      order_id: "aur176985",
      guide_code: "AUR5X634236483775",
      order_name: "#AUR176985",
      declared_status: "entregado",
      declared_amount: 364,
      match_status: "ok",
    };
    const facts = {
      order_id: "aur176985",
      general_status: "entregado",
      order_total: 215,
      current_courier: "aliclik",
      region: null,
      province: null,
      district: null,
      store_id: "aurela",
    };
    expect(reconcileLine(line, facts).verdict).toBe("cobro_de_mas");
    const withCompanion = reconcileLine(line, { ...facts, companion_total: 149 });
    expect(withCompanion).toMatchObject({ verdict: "conforme", expected: 364, difference: 0 });
  });

  it("el rótulo interno lista los productos de los dos y cobra lo que aún deben", () => {
    const host = { items: [{ quantity: 1, name: "Colágeno", variant: null }], total: 116.1, paid: false };
    const kp = { orderName: "#KP137851", items: [{ quantity: 2, name: "Faja", variant: "M" }], total: 104, paid: false };
    expect(companionLabelContent(host, [])).toEqual({ items: host.items, collectAmount: 116.1, paid: false });
    const content = companionLabelContent(host, [kp]);
    expect(content.items.map((item) => item.name)).toEqual(["Colágeno", "Faja (#KP137851)"]);
    expect(content.collectAmount).toBe(220.1);
    expect(content.paid).toBe(false);
    // El acompañante ya pagado por el checkout no se cobra en la puerta.
    expect(companionLabelContent(host, [{ ...kp, paid: true }]).collectAmount).toBe(116.1);
    expect(companionLabelContent({ ...host, paid: true }, [{ ...kp, paid: true }])).toMatchObject({
      collectAmount: 0,
      paid: true,
    });
  });
});

describe("la puerta del Master entrega al acompañante con su principal (regla 12)", () => {
  const ride = (companionOrderId: string, hostOrderId: string, status: string | null) => ({
    link: { companionOrderId, hostOrderId },
    shipment: status ? { delivery_status: status } : null,
  });

  it("solo los de un principal entregado, con su caja viva o entregada, una vez", () => {
    const rides = [
      ride("c1", "h1", "en_ruta"),
      ride("c2", "h1", "anulado"),
      ride("c3", "h1", null),
      ride("c4", "h2", "entregado"),
      ride("c1", "h1", "en_ruta"),
    ];
    expect(companionDoorFollowers(["h1"], rides).map((r) => r.link.companionOrderId)).toEqual(["c1"]);
    expect(companionDoorFollowers(["h1"], rides, ["c1"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Estado y macroetapa con la caja prestada.
// ---------------------------------------------------------------------------

const T_OVERRIDE = "2026-09-30T14:41:57.968Z";
const T_LINK = "2026-10-05T15:00:00.000Z";

function statusGuide(over: Partial<GuideSnapshot> = {}): GuideSnapshot {
  return {
    id: BOX,
    courier: "aliclik",
    guide_code: "AUR5XAUR177622",
    delivery_status: "entregado",
    attempts: 0,
    assigned_at: "2026-09-30T14:40:25.000Z",
    dispatched_at: "2026-10-01T10:00:00.000Z",
    out_for_delivery_at: null,
    rescheduled_at: null,
    closed_at: "2026-10-03T16:05:48.628Z",
    returned_at: null,
    pickup_state: null,
    agency_branch: null,
    agency_arrived_at: null,
    agency_expires_at: null,
    created_at: "2026-09-30T14:40:25.000Z",
    updated_at: "2026-10-03T16:05:48.628Z",
    ...over,
  };
}

describe("el candado cede al vincular (regla 7)", () => {
  const order = { created_at: "2026-09-30T06:40:23Z", cancelled_at: null, financial_status: "pending", shipping_mode: "cod" };
  const override = { general_status: "pendiente" as const, operational_status: "sin_confirmar", occurred_at: T_OVERRIDE };

  it("con el «comparte guía» puesto como nota y sin vínculo, el pedido sigue congelado", () => {
    const state = resolveOrderState({ order, guides: [], events: [], override });
    expect(state).toMatchObject({ general: "pendiente", overrideApplied: true });
  });

  it("vinculado después, sigue a la caja: entregado por Aliclik", () => {
    const state = resolveOrderState({
      order,
      guides: [statusGuide()],
      events: [
        { kind: COMPANION_LINKED, occurred_at: T_LINK, courier: "aliclik", new_status: null, new_operational: null },
      ],
      override,
    });
    expect(state).toMatchObject({
      general: "entregado",
      overrideApplied: false,
      guideCode: "AUR5XAUR177622",
      deliveredCourier: "aliclik",
    });
  });

  it("un cambio manual POSTERIOR al vínculo vuelve a mandar", () => {
    const state = resolveOrderState({
      order,
      guides: [statusGuide()],
      events: [
        { kind: COMPANION_LINKED, occurred_at: T_LINK, courier: "aliclik", new_status: null, new_operational: null },
      ],
      override: { ...override, occurred_at: "2026-10-06T10:00:00.000Z" },
    });
    expect(state.overrideApplied).toBe(true);
  });
});

function macroGuide(over: Partial<MacroGuideSnapshot> = {}): MacroGuideSnapshot {
  return {
    id: BOX,
    courier: "aliclik",
    delivery_status: "pendiente",
    attempts: 0,
    assigned_at: "2026-10-02T16:08:00.000Z",
    dispatched_at: null,
    out_for_delivery_at: null,
    rescheduled_at: null,
    returned_at: null,
    pickup_state: null,
    preparation_state: "en_armado",
    custody_state: "empresa",
    borrowed: true,
    ...over,
  };
}

function macro(over: Partial<ResolveMacroStageInput> = {}) {
  return resolveMacroStage({
    order: {
      created_at: "2026-10-02T10:00:00.000Z",
      cancelled_at: null,
      financial_status: "pending",
      shipping_mode: "cod",
      coverage: "provincia_cod",
      region: "La Libertad",
      province: "Trujillo",
      district: "Trujillo",
    },
    guides: [macroGuide()],
    events: [],
    legacy: { general: "en_proceso", operational: "asignado_a_courier", since: "2026-10-02T16:08:00.000Z" },
    now: "2026-10-05T12:00:00.000Z",
    ...over,
  });
}

describe("la macroetapa del acompañante (regla 6)", () => {
  it("con la caja del principal aún en la empresa: Preparación · Viaja en la caja de otro pedido", () => {
    const result = macro();
    expect(result).toMatchObject({ stage: "preparacion", substage: "en_caja_de_otro_pedido" });
    expect(macroSubstageLabel(result.substage)).toBe("Viaja en la caja de otro pedido");
    expect(MACRO_SUBSTAGES_BY_STAGE.preparacion).toContain("en_caja_de_otro_pedido");
  });

  it("ni «Por despachar» cuando la caja ya está lista: no es un paquete suyo", () => {
    expect(macro({ guides: [macroGuide({ preparation_state: "listo_despacho" })] }).substage).toBe(
      "en_caja_de_otro_pedido",
    );
  });

  it("la misma caja sin prestar —propia— sigue siendo Por armar / Por despachar", () => {
    expect(macro({ guides: [macroGuide({ borrowed: false })] }).substage).toBe("por_armar");
    expect(macro({ guides: [macroGuide({ borrowed: false, preparation_state: "listo_despacho" })] }).stage).toBe(
      "por_despachar",
    );
  });

  it("cuando la caja sale, sigue a su caja: En curso", () => {
    const result = macro({ guides: [macroGuide({ delivery_status: "en_ruta", dispatched_at: "2026-10-03T10:00:00Z", custody_state: "courier" })] });
    expect(result.stage).toBe("en_curso");
  });

  it("entregada y sin liquidar: Por cerrar · Pendiente de liquidación; con la del principal cerrada, Finalizado", () => {
    const delivered = macroGuide({ delivery_status: "entregado", dispatched_at: "2026-10-01T10:00:00Z", custody_state: "courier" });
    const legacy = { general: "entregado", operational: "entregado", since: "2026-10-03T16:05:48Z" };
    expect(macro({ guides: [delivered], legacy })).toMatchObject({
      stage: "por_cerrar",
      substage: "pendiente_liquidacion",
    });
    // El cierre de liquidación del principal llega como hecho prestado.
    expect(
      macro({
        guides: [delivered],
        legacy,
        events: [{ kind: "liquidation_closed", occurred_at: "2026-10-08T10:00:00Z", shipment_id: null }],
      }),
    ).toMatchObject({ stage: "finalizado", substage: "entregado_cerrado" });
  });
});

describe("la mesa de rutas del acompañante se cierra (regla 8)", () => {
  it("bloquea todas las modalidades y manda a Salidas y guías", () => {
    const gate = routeDeskGate({
      macroStage: "preparacion",
      generalStatus: "en_proceso",
      companionOf: { hostOrderName: "#AUR177622", guideCode: "AUR5XAUR177622" },
    });
    expect(gate.blockedActions.sort()).toEqual(["aliclik", "manual", "shalom", "swayp", "tanders"]);
    expect(gate.blockers[0]).toMatchObject({ target: "guias" });
    expect(gate.blockers[0]!.text).toContain("#AUR177622");
    expect(routeDeskGate({ macroStage: "preparacion", generalStatus: "pendiente" }).blockedActions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Recálculo de punta a punta, con un Supabase falso que SÍ filtra: la caja
// prestada depende de leer los eventos y salidas del OTRO pedido.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function filteringAdmin(tables: Record<string, Row[]>) {
  const upserts: Row[] = [];
  const admin = {
    from(table: string) {
      let rows: Row[] = tables[table] ?? [];
      let mutation = false;
      const builder: any = {
        select() {
          return builder;
        },
        in(column: string, values: unknown[]) {
          if (!mutation) rows = rows.filter((row) => values.includes(row[column]));
          return builder;
        },
        eq(column: string, value: unknown) {
          if (!mutation) rows = rows.filter((row) => row[column] === value);
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        upsert(batch: Row[]) {
          upserts.push(...batch);
          return Promise.resolve({ data: null, error: null });
        },
        update() {
          mutation = true;
          return builder;
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve({ data: mutation ? null : rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    // La cobertura canónica (0104): Trujillo es Provincia COD, como en la base.
    rpc(fn: string, args: { p_rows?: { order_id: string }[] }) {
      if (fn !== "order_coverage_batch") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({
        data: (args?.p_rows ?? []).map((probe) => ({ order_id: probe.order_id, coverage: "provincia_cod" })),
        error: null,
      });
    },
  };
  return { admin: admin as any, upserts };
}

const NOW = "2026-10-05T16:00:00.000Z";

function order(id: string, name: string, total: number, storeId: string) {
  return {
    id,
    store_id: storeId,
    shopify_order_id: id,
    name,
    created_at: "2026-09-30T06:00:00.000Z",
    cancelled_at: null,
    financial_status: "pending",
    shipping_mode: "cod",
    customer_phone: "51965702673",
    total_amount: total,
    total_refunded: 0,
    raw: {
      shippingAddress: {
        address1: "Av. Los Tulipanes",
        city: "Trujillo",
        province: "La Libertad",
        name: "Jheny Tecsi",
        phone: "965702673",
      },
    },
  };
}

function boxRow(over: Row = {}): Row {
  return {
    id: BOX,
    order_id: HOST,
    store_id: "aurela",
    courier: "aliclik",
    guide_code: "AUR5XAUR177622",
    delivery_status: "entregado",
    status_category: "delivered",
    created_at: "2026-09-30T14:40:25.000Z",
    updated_at: "2026-10-03T16:05:48.628Z",
    assigned_at: "2026-09-30T14:40:25.000Z",
    dispatched_at: "2026-10-01T10:00:00.000Z",
    closed_at: "2026-10-03T16:05:48.628Z",
    custody_state: "courier",
    district: "Trujillo",
    province: "Trujillo",
    region: "La Libertad",
    ...over,
  };
}

function event(orderId: string, storeId: string, kind: string, occurredAt: string, over: Row = {}): Row {
  return {
    order_id: orderId,
    store_id: storeId,
    shipment_id: null,
    kind,
    occurred_at: occurredAt,
    actor: "user-1",
    courier: null,
    new_status: null,
    new_operational: null,
    reason: null,
    note: null,
    payload: {},
    ...over,
  };
}

/** Los hechos del caso #KP137851 / #AUR177622 tal como estaban el 05-10. */
function realCase(extra: { box?: Row; hostEvents?: Row[]; companionEvents?: Row[] } = {}) {
  const linkPayload = (role: string) => ({
    role,
    link_id: "link-1",
    companion_order_id: COMPANION,
    companion_order_name: "#KP137851",
    host_order_id: HOST,
    host_order_name: "#AUR177622",
    host_shipment_id: BOX,
    host_guide_code: "AUR5XAUR177622",
  });
  return {
    orders: [order(HOST, "#AUR177622", 116.1, "aurela"), order(COMPANION, "#KP137851", 104, "kenku")],
    shipments: [boxRow(extra.box)],
    order_events: [
      event(HOST, "aurela", "status_override", "2026-09-30T14:42:29.485Z", {
        new_status: "en_proceso",
        new_operational: "asignado_a_courier",
        reason: "cOMPARTE GUIA CON EL PEDIDO #KP137851 // AUR5XAUR177622",
      }),
      event(COMPANION, "kenku", "confirmed", "2026-09-30T14:41:29.116Z"),
      event(COMPANION, "kenku", "status_override", T_OVERRIDE, {
        new_status: "pendiente",
        new_operational: "sin_confirmar",
        reason: "COMPARTE GUIA CON EL PEDIDO #AUR177622 // AUR5XAUR177622",
      }),
      event(COMPANION, "kenku", COMPANION_LINKED, T_LINK, { shipment_id: BOX, payload: linkPayload("companion") }),
      event(HOST, "aurela", COMPANION_LINKED, T_LINK, { shipment_id: BOX, payload: linkPayload("host") }),
      ...(extra.hostEvents ?? []),
      ...(extra.companionEvents ?? []),
    ],
  };
}

describe("recomputeOrderMaster con un pedido acompañante", () => {
  it("recalcular el acompañante arrastra al principal y le presta su caja", async () => {
    const stub = filteringAdmin(realCase());
    const result = await recomputeOrderMaster(stub.admin, [COMPANION], { now: NOW });
    expect(result.written).toBe(2);
    const companion = stub.upserts.find((row) => row.order_id === COMPANION)!;
    const host = stub.upserts.find((row) => row.order_id === HOST)!;
    expect(companion).toMatchObject({
      general_status: "entregado",
      status_locked: false,
      guide_code: "AUR5XAUR177622",
      delivered_courier: "aliclik",
      macro_stage: "por_cerrar",
      macro_substage: "pendiente_liquidacion",
      // El flete se paga una vez y está en el principal.
      logistics_cost: 0,
      order_total: 104,
    });
    // El candado del «comparte guía» del principal también cede.
    expect(host).toMatchObject({ general_status: "entregado", status_locked: false, macro_stage: "por_cerrar" });
  });

  it("recalcular el principal —lo que hace un reporte de Aliclik— arrastra al acompañante", async () => {
    const stub = filteringAdmin(realCase());
    await recomputeOrderMaster(stub.admin, [HOST], { now: NOW });
    expect(stub.upserts.map((row) => row.order_id).sort()).toEqual([HOST, COMPANION].sort());
    expect(stub.upserts.find((row) => row.order_id === COMPANION)).toMatchObject({ general_status: "entregado" });
  });

  it("con la caja aún en la empresa, el acompañante no entra a las colas del almacén", async () => {
    const stub = filteringAdmin(
      realCase({
        box: {
          delivery_status: "pendiente",
          status_category: "pending",
          dispatched_at: null,
          closed_at: null,
          custody_state: "empresa",
          preparation_state: "rotulo_generado",
        },
      }),
    );
    await recomputeOrderMaster(stub.admin, [COMPANION], { now: NOW });
    expect(stub.upserts.find((row) => row.order_id === COMPANION)).toMatchObject({
      macro_stage: "preparacion",
      macro_substage: "en_caja_de_otro_pedido",
    });
    // El principal sigue siendo un paquete normal por armar.
    expect(stub.upserts.find((row) => row.order_id === HOST)).toMatchObject({ macro_substage: "por_armar" });
  });

  it("cerrar la liquidación del principal finaliza al acompañante sin firmarlo aparte", async () => {
    const stub = filteringAdmin(
      realCase({ hostEvents: [event(HOST, "aurela", "liquidation_closed", "2026-10-08T10:00:00.000Z")] }),
    );
    await recomputeOrderMaster(stub.admin, [HOST], { now: NOW });
    expect(stub.upserts.find((row) => row.order_id === COMPANION)).toMatchObject({
      macro_stage: "finalizado",
      macro_substage: "entregado_cerrado",
    });
  });

  it("desvincularlo lo devuelve a su propia situación, sin resucitar el candado viejo", async () => {
    const unlink = event(COMPANION, "kenku", COMPANION_UNLINKED, "2026-10-06T10:00:00.000Z", {
      shipment_id: BOX,
      payload: {
        role: "companion",
        companion_order_id: COMPANION,
        host_order_id: HOST,
        host_shipment_id: BOX,
      },
    });
    const stub = filteringAdmin(realCase({ companionEvents: [unlink] }));
    await recomputeOrderMaster(stub.admin, [COMPANION], { now: NOW });
    const companion = stub.upserts.find((row) => row.order_id === COMPANION)!;
    expect(companion).toMatchObject({ general_status: "pendiente", status_locked: false, guide_code: null });
    expect(companion.macro_stage).toBe("preparacion");
    expect(companion.macro_substage).toBe("por_generar_rotulo");
  });

  it("una caja anulada sin salir deja de prestar: el acompañante vuelve a Preparación", async () => {
    const stub = filteringAdmin(
      realCase({
        box: { delivery_status: "anulado", dispatched_at: null, closed_at: null, custody_state: "empresa" },
      }),
    );
    await recomputeOrderMaster(stub.admin, [COMPANION], { now: NOW });
    expect(stub.upserts.find((row) => row.order_id === COMPANION)).toMatchObject({
      general_status: "pendiente",
      guide_code: null,
      macro_stage: "preparacion",
    });
  });

  it("sin vínculos no cambia nada: un pedido solo se recalcula solo", async () => {
    const stub = filteringAdmin({ orders: [order(HOST, "#AUR177622", 116.1, "aurela")], shipments: [boxRow()] });
    const result = await recomputeOrderMaster(stub.admin, [HOST], { now: NOW });
    expect(result).toEqual({ requested: 1, written: 1 });
  });
});

describe("las piezas están conectadas", () => {
  const read = (path: string) => readFileSync(path, "utf8");

  it("el MOM escribe la regla", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("## 32. Pedido acompañante: una caja y una guía para dos pedidos");
    expect(mom).toContain("«Preparación · Viaja en la caja de otro pedido»");
    expect(mom).toContain("`companion_total`");
    expect(mom).toContain("### Pedido acompañante");
  });

  it("el candado cede con companion_linked", () => {
    expect(read("lib/order-status.ts")).toContain('new Set(["guide_registered", "guide_created", COMPANION_LINKED])');
  });

  it("la liquidación, la puerta, el rótulo y la ficha leen el vínculo", () => {
    expect(read("lib/settlements-access.ts")).toContain("companion_total: companionTotal");
    expect(read("lib/master-door.ts")).toContain("await followCompanions(admin, items, result);");
    expect(read("app/api/pedidos/rotulos/route.ts")).toContain("companionLabelContent(");
    const drawer = read("components/order-drawer.tsx");
    expect(drawer).toContain("<OrderCompanionPanel");
    expect(drawer).toContain("!detail?.companion.travelsIn &&");
    expect(read("lib/orders-master-access.ts")).toContain("companionOf: companion.travelsIn");
  });

  it("vincular y desvincular escriben los dos hechos en un solo insert y recalculan a los dos", () => {
    const actions = read("app/dashboard/pedidos/companion-actions.ts");
    expect(actions).toContain('payload: { ...base, role: "companion" }');
    expect(actions).toContain('payload: { ...base, role: "host" }');
    expect(actions.match(/recomputeOrderMasterSafe\(admin, \[auth\.row\.order_id, host\.order_id\]\)/g)).toHaveLength(2);
    expect(actions).toContain('perms.can("master.edit")');
  });
});
