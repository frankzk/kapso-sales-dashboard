// Almacén: «Swayp por salir · Lima» (lib/warehouse-swayp.ts; fase 1, solo
// lectura, owner 03-11-2026). La proyección pura desde las filas crudas: el día
// (fecha UTC), quién arma (macro_operation), qué está armado (la propia
// salida), qué salió de la lista y por qué, la hora real de creación de la
// guía, dónde está la caja, el tono de la víspera, el escáner, la copia local
// tras un escaneo y lo que se le dice a la asesora.
//
// Los lotes del 03-11 y del 04-11 son los de producción (leídos con SELECT el
// 03-11-2026), con nombres de clientes y personas inventados.

import { describe, expect, it, vi } from "vitest";
import {
  applySwaypScan,
  buildWarehouseSwayp,
  emptyWarehouseSwayp,
  swaypAddedLate,
  swaypArmedChip,
  swaypAutoRefreshActive,
  swaypBoxWhereabouts,
  swaypCell,
  swaypDayLabel,
  swaypDirectSourceDay,
  swaypDispatchDay,
  swaypExitReason,
  swaypGuideOrigin,
  swaypHintAfterScan,
  swaypHoyUrgent,
  swaypLotIsCurrent,
  swaypLotNotice,
  swaypTaken,
  swaypScanHint,
  swaypShortDayLabel,
  swaypSuggestedDispatchDay,
  swaypZoneDays,
  swaypZoneHeadline,
  swaypZoneTone,
  swaypZoneTitle,
  SWAYP_ASESORA_CREATED,
  SWAYP_ASESORA_NOCHE,
  SWAYP_ASESORA_TARDE,
  SWAYP_CHIP_ARMADA_POR_DEFINIR,
  SWAYP_CHIP_ERA_POR_DEFINIR,
  SWAYP_CHIP_SALIDA_NUEVA,
  SWAYP_CHIP_SIN_ARMAR,
  SWAYP_CREATOR_AUTOMATIC,
  SWAYP_EMPTY,
  SWAYP_ERROR,
  SWAYP_HELP,
  SWAYP_HOY_FALTA_TOMADA,
  SWAYP_SCAN_FUERA,
  SWAYP_HOY_NOTE,
  SWAYP_SALIO_ANULADA,
  SWAYP_SALIO_ARMADA,
  SWAYP_SALIO_CANCELADA,
  SWAYP_SALIO_PEDIDO_ANULADO,
  SWAYP_SCAN_ANULADA,
  SWAYP_SCAN_CANCELADA,
  SWAYP_CLOSED_AFTER_PICKUP_STATES,
  SWAYP_PROVINCIA,
  SWAYP_TITLE,
  SWAYP_TONE_COMPLETO,
  SWAYP_TONE_TOMADAS,
  SWAYP_TONE_VISPERA,
  type SwaypCallRow,
  type SwaypEmissionRow,
  type SwaypInput,
  type SwaypOrderRow,
  type SwaypShipmentRow,
  type WarehouseSwaypData,
} from "@/lib/warehouse-swayp";
import { SWAYP_HOY_FALTA_ENTREGA } from "@/lib/swayp-handover";
import { swaypDispatchDayOptions } from "@/lib/swayp-dispatch-days";
import { SWAYP_RETURN_STATES, mapSwaypState } from "@/lib/swayp";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORE = "s1";
/** Mar 3 nov, 17:42 de Lima: el lote de hoy salió; el del miércoles se está armando. */
const NOW = new Date("2026-11-03T22:42:00Z");
/** Un instante de Lima (UTC−5). */
const lima = (day: string, time: string): Date => new Date(`${day}T${time}:00-05:00`);

function shipment(id: string, extra: Partial<SwaypShipmentRow> = {}): SwaypShipmentRow {
  return {
    id, store_id: STORE, courier: "fenix", guide_code: null, swayp_guide: null, swayp_state: 1,
    delivery_status: "en_ruta", status_category: "in_route", order_id: `o-${id}`, order_name: null,
    customer_name: "Cliente", product: "Producto", district: "Surco", city: "lima", province: null,
    next_followup_at: "2026-11-04T00:00:00+00:00", created_at: "2026-11-03T15:00:00Z", output_code: `${id}-S01`,
    output_number: 1, preparation_state: "no_iniciado", custody_state: "empresa", ready_at: null, ready_by: null,
    custody_transferred_at: null, dispatched_at: null, returned_at: null, ...extra,
  };
}

function order(orderId: string, extra: Partial<SwaypOrderRow> = {}): SwaypOrderRow {
  return {
    order_id: orderId, store_id: STORE, order_name: `#${orderId}`, customer_name: "Cliente", macro_operation: "lima",
    general_status: "en_proceso", product_titles: ["Producto"], district: "Surco", province: "Lima", region: "Lima (provincia)",
    cancelled_at: null, ...extra,
  };
}

function emission(id: string, extra: Partial<SwaypEmissionRow> = {}): SwaypEmissionRow {
  return { id, source_key: id, order_id: null, store_id: STORE, automatic: false, state: "created", guide_code: null, child_id: null, created_at: "2026-11-03T15:00:00Z", ...extra };
}

function call(shipmentId: string, occurredAt: string, extra: Partial<SwaypCallRow> = {}): SwaypCallRow {
  return { shipment_id: shipmentId, agent: "u-asesora-b", kind: "reroute", note: "Guía Swayp directa creada", occurred_at: occurredAt, next_followup_at: null, ...extra };
}

/** Una guía Swayp de Lima con su pedido, su emisión directa y la gestión de quien la creó. */
function limaGuide(code: string, opts: {
  id?: string;
  day?: string;
  guide: string;
  district?: string;
  createdAt: string;
  emittedAt: string;
  readyAt?: string | null;
  readyBy?: string | null;
  agent?: string | null;
  extra?: Partial<SwaypShipmentRow>;
  orderExtra?: Partial<SwaypOrderRow>;
}) {
  const id = opts.id ?? `sh-${code}`;
  const orderId = `o-${code.split("-")[0]}`;
  const day = opts.day ?? "2026-11-04";
  const s = shipment(id, {
    order_id: orderId, order_name: `#${code.split("-")[0]}`, output_code: code, output_number: Number(code.slice(-2)),
    guide_code: opts.guide, swayp_guide: opts.guide, district: opts.district ?? "Surco",
    next_followup_at: `${day}T00:00:00+00:00`, created_at: opts.createdAt,
    preparation_state: opts.readyAt ? "listo_despacho" : "no_iniciado", ready_at: opts.readyAt ?? null, ready_by: opts.readyBy ?? null,
    ...opts.extra,
  });
  return {
    shipment: s,
    order: order(orderId, { order_name: `#${code.split("-")[0]}`, ...opts.orderExtra }),
    emission: emission(`e-${code}`, {
      source_key: `direct:${orderId}:${day}T00:00:00.000Z`, order_id: orderId, guide_code: opts.guide, child_id: id, created_at: opts.emittedAt,
    }),
    call: call(id, new Date(Date.parse(opts.emittedAt) + 1500).toISOString(), { agent: opts.agent === undefined ? "u-asesora-a" : opts.agent, next_followup_at: `${day}T00:00:00+00:00` }),
  };
}

type Guide = ReturnType<typeof limaGuide>;

function input(guides: Guide[], more: Partial<SwaypInput> = {}): SwaypInput {
  return {
    shipments: [...guides.map((g) => g.shipment), ...(more.shipments ?? [])],
    orders: [...guides.map((g) => g.order), ...(more.orders ?? [])],
    emissions: [...guides.map((g) => g.emission), ...(more.emissions ?? [])],
    calls: [...guides.map((g) => g.call), ...(more.calls ?? [])],
    names: { "u-asesora-a": "Asesora A", "u-asesora-b": "Asesora B", "u-almacen-a": "Almacén A", "u-almacen-b": "Almacén B", ...(more.names ?? {}) },
    storeNames: more.storeNames ?? { [STORE]: "Kenku Peru" },
  };
}

/**
 * Producción, 03-11-2026. El lote del martes 3 nov: 7 programadas y 7 armadas
 * (cuatro se armaron como «por definir» antes de escribirse la guía, a las 16:00
 * del lunes). El del miércoles 4 nov: KP143987-S02, guía creada a las 00:11 del
 * martes, salida nueva; su S01 era de Aliclik, anulada y devuelta a la oficina.
 * Provincia del martes: KP201325-S02 (hija del automático, `city` nulo) y una
 * anulada por Swayp, que no cuenta.
 */
function productionSeed(): SwaypInput {
  const tuesday = [
    limaGuide("KP201878-S01", { day: "2026-11-03", guide: "50000164617", district: "La Victoria", createdAt: "2026-11-02T12:06:37Z", emittedAt: "2026-11-02T21:02:13Z", readyAt: "2026-11-02T12:19:37Z", readyBy: "u-almacen-a" }),
    limaGuide("KP201890-S01", { day: "2026-11-03", guide: "50000164616", district: "Pachacámac", createdAt: "2026-11-02T12:06:41Z", emittedAt: "2026-11-02T21:01:28Z", readyAt: "2026-11-02T12:18:58Z", readyBy: "u-almacen-a" }),
    limaGuide("KP201974-S01", { day: "2026-11-03", guide: "50000164611", district: "Cieneguilla", createdAt: "2026-11-02T14:16:20Z", emittedAt: "2026-11-02T21:00:17Z", readyAt: "2026-11-02T14:18:29Z", readyBy: "u-almacen-a" }),
    limaGuide("KP201975-S01", { day: "2026-11-03", guide: "50000164612", district: "Los Olivos", createdAt: "2026-11-02T14:16:22Z", emittedAt: "2026-11-02T21:00:43Z", readyAt: "2026-11-02T14:18:32Z", readyBy: "u-almacen-a" }),
    limaGuide("KP202022-S01", { day: "2026-11-03", guide: "50000164619", district: "Cieneguilla", createdAt: "2026-11-02T19:06:03Z", emittedAt: "2026-11-02T21:03:03Z", readyAt: "2026-11-02T22:19:53Z", readyBy: "u-almacen-b" }),
    limaGuide("KP202036-S01", { day: "2026-11-03", guide: "50000164620", district: "Villa El Salvador", createdAt: "2026-11-02T19:06:06Z", emittedAt: "2026-11-02T21:03:24Z", readyAt: "2026-11-02T22:19:48Z", readyBy: "u-almacen-b" }),
    limaGuide("KP202041-S01", { day: "2026-11-03", guide: "50000164618", district: "Ate", createdAt: "2026-11-02T19:06:09Z", emittedAt: "2026-11-02T21:02:42Z", readyAt: "2026-11-02T22:19:59Z", readyBy: "u-almacen-b" }),
  ];
  const wednesday = limaGuide("KP143987-S02", {
    day: "2026-11-04", guide: "50000165022", district: "san bartolo", createdAt: "2026-11-03T05:11:10.904Z",
    emittedAt: "2026-11-03T05:11:09.552Z", agent: "u-asesora-b", extra: { product: "ASTAXANTINA – Antioxidante De Alta Potencia (120 Cápsulas)" },
  });
  const aliclikS01 = shipment("sh-KP143987-S01", {
    order_id: wednesday.order.order_id, courier: "aliclik", guide_code: "AUR5X246218871979", output_code: "KP143987-S01", output_number: 1,
    preparation_state: "listo_despacho", custody_state: "devuelto", ready_at: "2026-10-25T20:58:30Z", delivery_status: "anulado",
    status_category: "closed", swayp_state: null, returned_at: "2026-11-02T18:51:16Z", next_followup_at: "2026-10-25T17:00:00+00:00",
    created_at: "2026-10-25T20:53:31Z",
  });
  const provAuto = shipment("sh-KP201325-S02", {
    order_id: "o-KP201325", output_code: "KP201325-S02", output_number: 2, guide_code: "50000164696", city: null, province: "Ica",
    district: "Ica", next_followup_at: "2026-11-03T00:00:00+00:00", created_at: "2026-11-02T23:42:29Z",
  });
  const provCancelled = shipment("sh-KP200270-S01", {
    order_id: "o-KP200270", output_code: "KP200270-S01", guide_code: "50000164424", city: "cusco", district: "San Jerónimo",
    next_followup_at: "2026-11-03T00:00:00+00:00", delivery_status: "anulado", status_category: "closed", swayp_state: 10,
  });
  const provLive = shipment("sh-KP200267-S01", {
    order_id: "o-KP200267", output_code: "KP200267-S01", guide_code: "50000164419", city: "arequipa", district: "Cerro Colorado",
    next_followup_at: "2026-11-03T00:00:00+00:00",
  });
  return input([...tuesday, { ...wednesday, shipment: { ...wednesday.shipment, customer_name: "Cliente Ejemplo" } }], {
    shipments: [aliclikS01, provAuto, provCancelled, provLive],
    orders: [
      order("o-KP201325", { macro_operation: "provincia_cod" }),
      order("o-KP200270", { macro_operation: "provincia_cod", general_status: "anulado" }),
      order("o-KP200267", { macro_operation: "provincia_cod" }),
    ],
    emissions: [emission("e-auto", { order_id: "o-KP201325", automatic: true, guide_code: "50000164696", child_id: "sh-KP201325-S02", created_at: "2026-11-02T23:42:27Z" })],
    calls: [call("sh-KP201325-S02", "2026-11-02T23:42:29Z", { agent: null, note: "Reintento automático Aliclik → Swayp" })],
  });
}

// ---------------------------------------------------------------------------
// Producción
// ---------------------------------------------------------------------------

describe("los lotes reales del 03-11 y del 04-11", () => {
  const data = buildWarehouseSwayp(productionSeed(), NOW);

  it("hoy martes: 7 programadas y 7 armadas, cuatro como «por definir»", () => {
    expect(data.today).toBe("2026-11-03");
    expect(data.leidoAt).toBe("17:42");
    const hoy = data.hoy!;
    expect(hoy).toMatchObject({ title: "Hoy · martes 3 nov", headline: "Swayp hoy: 7 programadas · 7 armadas", note: SWAYP_HOY_NOTE, tone: null });
    expect(hoy.counts).toEqual({ programadas: 7, armadas: 7, faltan: 0, agregadasTarde: 0 });
    expect(hoy.faltan).toEqual([]);
    expect(hoy.armadas.map((a) => a.code)).toEqual([
      "KP201890-S01", "KP201878-S01", "KP201974-S01", "KP201975-S01", "KP202036-S01", "KP202022-S01", "KP202041-S01",
    ]);
    const early = hoy.armadas.filter((a) => a.armedBeforeGuide).map((a) => a.code).sort();
    expect(early).toEqual(["KP201878-S01", "KP201890-S01", "KP201974-S01", "KP201975-S01"]);
    const kp202022 = hoy.armadas.find((a) => a.code === "KP202022-S01")!;
    expect(kp202022.line).toBe("KP202022-S01 · armada lunes 2 nov 17:19 · Almacén B · Cliente · Cieneguilla");
    expect(kp202022.chips).toEqual([]);
    expect(hoy.armadas.find((a) => a.code === "KP201878-S01")!.chips).toEqual([{ tone: "neutral", text: SWAYP_CHIP_ARMADA_POR_DEFINIR }]);
    expect(kp202022.swaypLine).toBe("Swayp: Generada");
    expect(kp202022.createdLine).toBe("Creó la guía: Asesora A · lunes 2 nov 16:03");
  });

  it("el pie de provincia del martes: solo lo vivo, por ciudad, con `city` nulo incluido", () => {
    expect(data.hoy!.provincia).toMatchObject({
      total: 2,
      porCiudad: [{ city: "Arequipa", count: 1 }, { city: "Ica", count: 1 }],
      text: "Provincia: 2 guías Swayp salen el martes 3 nov desde bodegas de Swayp (Arequipa 1, Ica 1). No se empacan aquí.",
    });
    // Provincia no cuenta ni sale en «Salieron» (lo cancelado es de la bodega de Swayp).
    expect(data.hoy!.salieron).toEqual([]);
    expect(data.hoy!.counts.programadas).toBe(7);
  });

  it("mañana miércoles: 1 programada, 0 armadas, falta KP143987-S02 y su S01 de Aliclik volvió", () => {
    const next = data.proximo;
    expect(next).toMatchObject({
      kind: "proximo", day: "2026-11-04", title: "Mañana · miércoles 4 nov", vispera: "2026-11-03",
      headline: "Swayp miércoles 4 nov: 1 programada · 0 armadas · falta 1",
      tone: { kind: "warn", text: "Faltan 3 h 38 min para el corte de las 21:20: déjalo listo." },
    });
    expect(next.counts).toEqual({ programadas: 1, armadas: 0, faltan: 1, agregadasTarde: 0 });
    const [falta] = next.faltan;
    expect(falta).toMatchObject({
      code: "KP143987-S02",
      title: "KP143987-S02 · guía 50000165022",
      customerLine: "Cliente Ejemplo · San Bartolo",
      orderLine: "#KP143987 · Kenku Peru · ASTAXANTINA – Antioxidante De Alta Potencia (120 Cápsulas)",
      createdLine: "Creó la guía: Asesora B · martes 3 nov 00:11",
      guideCreatedAt: "2026-11-03T05:11:09.552Z",
      late: false,
      newSalida: true,
      labelHref: "/api/pedidos/rotulos?ids=sh-KP143987-S02",
      taken: false,
      actionLine: null,
      swaypLine: null,
    });
    expect(falta!.chips).toEqual([{ tone: "warn", text: SWAYP_CHIP_SIN_ARMAR }, { tone: "info", text: SWAYP_CHIP_SALIDA_NUEVA }]);
    expect(falta!.where).toEqual({
      kind: "hermana_volvio",
      text: "La KP143987-S01 (Aliclik) volvió a la oficina: si la caja está entera, úsala con el rótulo KP143987-S02; si no, ármala desde stock.",
      sibling: { shipmentId: "sh-KP143987-S01", code: "KP143987-S01", courier: "Aliclik" },
    });
    expect(next.cell).toEqual({
      title: "Swayp · Lima",
      big: "Falta 1",
      sub: "miércoles 4 nov · 1 programada · 0 armadas",
      tone: next.tone,
    });
  });

  it("el escáner: armar la S02 completa el lote del miércoles", () => {
    const scanned = { id: "sh-KP143987-S02", order_id: "o-KP143987", courier: "fenix", output_code: "KP143987-S02", guide_code: "50000165022" };
    expect(swaypScanHint(data, scanned)).toEqual({
      kind: "completo",
      tone: "ok",
      text: "Swayp miércoles 4 nov · 1 de 1 armadas. Lote completo: júntalas en el sitio de Swayp.",
    });
    const after = applySwaypScan(data, scanned.id, "2026-11-03T23:05:00Z", "Almacén A");
    expect(after.proximo.headline).toBe("Swayp miércoles 4 nov: 1 programada · 1 armada · lote completo");
    expect(after.proximo.tone).toEqual({ kind: "ok", text: SWAYP_TONE_COMPLETO });
    expect(after.proximo.cell.big).toBe("Completo");
    expect(after.proximo.armadas[0]).toMatchObject({
      code: "KP143987-S02", readyAt: "2026-11-03T23:05:00.000Z", readyBy: "Almacén A", armedBeforeGuide: false, chips: [],
      line: "KP143987-S02 · armada martes 3 nov 18:05 · Almacén A · Cliente Ejemplo · San Bartolo",
    });
    // Después de aplicar el escaneo, el aviso dice lo mismo.
    expect(swaypScanHint(after, scanned)?.tone).toBe("ok");
    expect(swaypArmedChip(after, scanned.id)).toBe("Swayp · mié 4 nov");
    expect(swaypArmedChip(after, "sh-KP201878-S01")).toBe("Swayp · mar 3 nov");
    expect(swaypArmedChip(after, "sh-otra")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// El día y las zonas
// ---------------------------------------------------------------------------

describe("el día de despacho es la fecha UTC de `next_followup_at`", () => {
  it("'2026-11-04 00:00:00+00' es del 04-11, nunca del 03-11 de Lima", () => {
    expect(swaypDispatchDay("2026-11-04 00:00:00+00")).toBe("2026-11-04");
    expect(swaypDispatchDay("2026-11-04T00:00:00+00:00")).toBe("2026-11-04");
    expect(swaypDispatchDay("2026-11-04T00:00:00.000Z")).toBe("2026-11-04");
    expect(swaypDispatchDay(null)).toBeNull();
    const g = limaGuide("KP1-S01", { guide: "500", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z" });
    const data = buildWarehouseSwayp(input([{ ...g, shipment: { ...g.shipment, next_followup_at: "2026-11-04 00:00:00+00" } }]), NOW);
    expect(data.hoy!.counts.programadas).toBe(0);
    expect(data.proximo.faltan.map((f) => f.code)).toEqual(["KP1-S01"]);
  });

  it("el día de la directa original sale del source_key", () => {
    expect(swaypDirectSourceDay("direct:0f17:2026-11-04T00:00:00.000Z")).toBe("2026-11-04");
    expect(swaypDirectSourceDay("a680a603-f6e0-4dae-beb6-f00a5c91ea0e")).toBeNull();
  });

  it("las zonas: hoy si Swayp despacha; el próximo día de despacho; sábado → lunes; domingo sin «Hoy»", () => {
    expect(swaypZoneDays("2026-11-03")).toEqual({ hoy: "2026-11-03", proximo: "2026-11-04" });
    expect(swaypZoneDays("2026-11-07")).toEqual({ hoy: "2026-11-07", proximo: "2026-11-09" });
    expect(swaypZoneDays("2026-11-08")).toEqual({ hoy: null, proximo: "2026-11-09" });
    expect(swaypZoneTitle("proximo", "2026-11-04", "2026-11-03")).toBe("Mañana · miércoles 4 nov");
    expect(swaypZoneTitle("proximo", "2026-11-09", "2026-11-07")).toBe("Próximo despacho · lunes 9 nov");
    expect(swaypZoneTitle("proximo", "2026-11-09", "2026-11-08")).toBe("Mañana · lunes 9 nov");
    expect(swaypZoneTitle("hoy", "2026-11-03", "2026-11-03")).toBe("Hoy · martes 3 nov");

    const saturday = buildWarehouseSwayp(input([]), lima("2026-11-07", "10:00"));
    expect(saturday.hoy?.title).toBe("Hoy · sábado 7 nov");
    expect(saturday.proximo.title).toBe("Próximo despacho · lunes 9 nov");
    const sunday = buildWarehouseSwayp(input([]), lima("2026-11-08", "10:00"));
    expect(sunday.hoy).toBeNull();
    expect(sunday.proximo.title).toBe("Mañana · lunes 9 nov");
  });

  it("las fechas en es-PE, como `swaypDispatchDayOptions` pero sin coma ni punto", () => {
    expect(swaypDayLabel("2026-11-04")).toBe("miércoles 4 nov");
    expect(swaypShortDayLabel("2026-11-04")).toBe("mié 4 nov");
    expect(swaypDayLabel("2026-09-05")).toBe("sábado 5 set");
    for (const option of swaypDispatchDayOptions("2026-01-01", 300)) {
      const intl = option.label.replace(/^Mañana · /, "").replace(",", "").replace(/\.$/, "");
      expect(swaypDayLabel(option.value)).toBe(intl);
    }
  });

  it("relee sola de 16:00 a 21:30 de Lima", () => {
    expect(swaypAutoRefreshActive(lima("2026-11-03", "15:59"))).toBe(false);
    expect(swaypAutoRefreshActive(lima("2026-11-03", "16:00"))).toBe(true);
    expect(swaypAutoRefreshActive(lima("2026-11-03", "21:30"))).toBe(true);
    expect(swaypAutoRefreshActive(lima("2026-11-03", "21:31"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Quién arma, qué cuenta, qué salió
// ---------------------------------------------------------------------------

describe("quién arma lo dice `macro_operation`", () => {
  it("provincia con `city` nulo y provincia con `city` 'lima' van al pie; agencia y sin operación, a «Revisar»", () => {
    const lima1 = limaGuide("KP1-S01", { guide: "501", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z" });
    const provNull = limaGuide("KP2-S02", { guide: "502", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", extra: { city: null, province: "Arequipa" }, orderExtra: { macro_operation: "provincia_cod" } });
    const provLima = limaGuide("KP3-S01", { guide: "503", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", extra: { city: "lima", district: "San Bartolo" }, orderExtra: { macro_operation: "provincia_cod", province: "Cañete" } });
    const agencia = limaGuide("KP4-S01", { guide: "504", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", orderExtra: { macro_operation: "agencia" } });
    const unknown = limaGuide("KP5-S01", { guide: "505", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", orderExtra: { macro_operation: null } });
    const callao = limaGuide("KP6-S01", { guide: "506", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", extra: { city: "callao", district: "Callao" } });
    const data = buildWarehouseSwayp(input([lima1, provNull, provLima, agencia, unknown, callao]), NOW);
    const next = data.proximo;
    expect(next.faltan.map((f) => f.code)).toEqual(["KP1-S01", "KP6-S01"]);
    expect(next.counts.programadas).toBe(2);
    expect(next.provincia.total).toBe(2);
    expect(next.provincia.porCiudad).toEqual([{ city: "Arequipa", count: 1 }, { city: "Lima", count: 1 }]);
    expect(next.revisar.map((r) => [r.code, r.text])).toEqual([
      ["KP4-S01", "Operación del pedido: Agencia"],
      ["KP5-S01", "Operación del pedido: Sin clasificar"],
    ]);
  });
});

describe("armada = la PROPIA salida escaneada (R4, D4)", () => {
  it("la S01 de Grupo GF armada no cuenta: la S02 de Swayp es FALTA y la caja lleva su rótulo", () => {
    const s02 = limaGuide("KP7-S02", { guide: "507", createdAt: "2026-11-03T16:00:00Z", emittedAt: "2026-11-03T16:00:00Z" });
    const gf = shipment("sh-KP7-S01", {
      order_id: s02.order.order_id, courier: "propio", output_code: "KP7-S01", output_number: 1, preparation_state: "listo_despacho",
      custody_state: "empresa", ready_at: "2026-11-03T14:00:00Z", delivery_status: "anulado", status_category: "closed", swayp_state: null,
      next_followup_at: null,
    });
    const data = buildWarehouseSwayp(input([s02], { shipments: [gf] }), NOW);
    expect(data.proximo.counts).toMatchObject({ programadas: 1, armadas: 0, faltan: 1 });
    expect(data.proximo.faltan[0]!.where).toMatchObject({
      kind: "hermana_armada",
      text: "La caja está armada como KP7-S01 (Grupo GF): ponle el rótulo KP7-S02, escanéalo y avisa a Despacho que la S01 no sale.",
    });
    // El rótulo viejo en el escáner: imprime el de Swayp.
    expect(swaypScanHint(data, { id: "sh-KP7-S01", order_id: s02.order.order_id, courier: "propio", output_code: "KP7-S01", guide_code: "" })).toEqual({
      kind: "rotulo_viejo",
      tone: "warn",
      text: "Ese rótulo es KP7-S01 (Grupo GF). El pedido sale por Swayp con KP7-S02: imprime ese rótulo y escanéalo.",
    });
  });
});

describe("salieron de la lista, con su motivo (R8)", () => {
  function exitSeed() {
    const cancelled = limaGuide("KP10-S01", { guide: "510", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", extra: { delivery_status: "anulado", status_category: "closed", swayp_state: 10, preparation_state: "listo_despacho", ready_at: "2026-11-03T16:00:00Z" } });
    const annulled = limaGuide("KP11-S01", { guide: "511", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", extra: { delivery_status: "anulado", status_category: "closed", swayp_state: 1 } });
    const orderAnnulled = limaGuide("KP12-S01", { guide: "512", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", orderExtra: { general_status: "anulado" } });
    const storeCancelled = limaGuide("KP13-S01", { guide: "513", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", extra: { delivery_status: "anulado", status_category: "closed", swayp_state: 10 }, orderExtra: { general_status: "anulado", cancelled_at: "2026-11-03T18:00:00Z" } });
    // Directa creada para el miércoles; su guía viva sale ahora el viernes 6 nov.
    const moved = limaGuide("KP14-S01", { guide: "514", day: "2026-11-04", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", readyAt: "2026-11-03T16:30:00Z" });
    moved.shipment = { ...moved.shipment, next_followup_at: "2026-11-06T00:00:00+00:00" };
    const moveCall = call(moved.shipment.id, "2026-11-03T23:40:00Z", { kind: "call", agent: null, next_followup_at: "2026-11-06T00:00:00+00:00" });
    const live = limaGuide("KP15-S01", { guide: "515", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z" });
    return input([cancelled, annulled, orderAnnulled, storeCancelled, moved, live], { calls: [moveCall] });
  }

  it("cancelada por Swayp, anulada en Kapta, pedido anulado y fecha cambiada; nada desaparece en silencio", () => {
    const next = buildWarehouseSwayp(exitSeed(), NOW).proximo;
    expect(next.counts).toMatchObject({ programadas: 1, faltan: 1 });
    expect(next.salieron.map((s) => [s.code, s.reason, s.text, s.armedText])).toEqual([
      ["KP10-S01", "swayp_cancelo", SWAYP_SALIO_CANCELADA, SWAYP_SALIO_ARMADA],
      ["KP11-S01", "guia_anulada", SWAYP_SALIO_ANULADA, null],
      ["KP12-S01", "pedido_anulado", SWAYP_SALIO_PEDIDO_ANULADO, null],
      ["KP13-S01", "pedido_anulado", SWAYP_SALIO_PEDIDO_ANULADO, null],
      ["KP14-S01", "fecha_cambiada", "Fecha cambiada: ahora sale el viernes 6 nov (cambió el martes 3 nov 18:40)", SWAYP_SALIO_ARMADA],
    ]);
    expect(next.salieron.find((s) => s.code === "KP14-S01")!.newDay).toBe("2026-11-06");
  });

  it("el motivo: la tienda primero, luego Swayp, luego Kapta y el pedido", () => {
    const live = { swayp_state: 1, delivery_status: "en_ruta", status_category: "in_route" };
    expect(swaypExitReason(live, { general_status: "en_proceso", cancelled_at: null })).toBeNull();
    expect(swaypExitReason({ ...live, swayp_state: 10, delivery_status: "anulado", status_category: "closed" }, { general_status: "anulado", cancelled_at: "2026-11-03T18:00:00Z" })).toBe("pedido_anulado");
    expect(swaypExitReason({ ...live, swayp_state: 10, delivery_status: "anulado", status_category: "closed" }, { general_status: "anulado", cancelled_at: null })).toBe("swayp_cancelo");
    expect(swaypExitReason({ ...live, delivery_status: "anulado", status_category: "closed" }, { general_status: "anulado", cancelled_at: null })).toBe("guia_anulada");
    expect(swaypExitReason(live, { general_status: "anulado", cancelled_at: null })).toBe("pedido_anulado");
    // Lo que ya avanzó en Swayp sigue vivo (la zona «Hoy» lo cuenta).
    expect(swaypExitReason({ swayp_state: 7, delivery_status: "entregado", status_category: "delivered" }, null)).toBeNull();
    expect(swaypExitReason({ swayp_state: 8, delivery_status: "transferido", status_category: "transferred" }, null)).toBeNull();
  });

  it("el escáner con una que salió: cancelada, anulada o con otra fecha", () => {
    const data = buildWarehouseSwayp(exitSeed(), NOW);
    const scan = (code: string) => swaypScanHint(data, { id: `sh-${code}`, order_id: `o-${code.split("-")[0]}`, courier: "fenix", output_code: code, guide_code: "" });
    expect(scan("KP10-S01")).toEqual({ kind: "salio", tone: "crit", text: SWAYP_SCAN_CANCELADA });
    expect(scan("KP11-S01")).toEqual({ kind: "salio", tone: "crit", text: SWAYP_SCAN_ANULADA });
    expect(scan("KP12-S01")).toEqual({ kind: "salio", tone: "crit", text: SWAYP_SCAN_ANULADA });
    expect(scan("KP14-S01")).toEqual({ kind: "salio", tone: "warn", text: "Esta guía ahora sale el viernes 6 nov: guárdala aparte." });
  });
});

// ---------------------------------------------------------------------------
// La hora real de la guía y quién la creó
// ---------------------------------------------------------------------------

describe("agregada tarde: por la hora de emisión, nunca por `shipments.created_at`", () => {
  it("una salida «por definir» nacida a las 18:00 cuya guía se emitió a las 15:00 no es tardía", () => {
    const g = limaGuide("KP20-S01", { guide: "520", createdAt: "2026-11-03T12:00:00Z", emittedAt: "2026-11-03T20:00:00Z" });
    const data = buildWarehouseSwayp(input([{ ...g, shipment: { ...g.shipment, created_at: "2026-11-03T23:00:00Z" } }]), NOW);
    expect(data.proximo.faltan[0]!.late).toBe(false);
    expect(data.proximo.counts.agregadasTarde).toBe(0);
  });

  it("una guía emitida a las 20:43 de la víspera lleva «Agregada 20:43, después de las 17:00» aunque la salida naciera de mañana", () => {
    const g = limaGuide("KP21-S01", { guide: "521", createdAt: "2026-11-03T12:00:00Z", emittedAt: "2026-11-04T01:43:00Z" });
    const data = buildWarehouseSwayp(input([g]), lima("2026-11-03", "21:00"));
    const [falta] = data.proximo.faltan;
    expect(falta!.late).toBe(true);
    expect(falta!.chips).toContainEqual({ tone: "warn", text: "Agregada 20:43, después de las 17:00" });
    // Nació antes que su guía: era la caja «por definir».
    expect(falta!.newSalida).toBe(false);
    expect(falta!.chips).toContainEqual({ tone: "neutral", text: SWAYP_CHIP_ERA_POR_DEFINIR });
    expect(falta!.where?.text).toBe("Es la caja «por definir» KP21-S01: ármala y escanéala; el rótulo no cambia.");
    expect(data.proximo.counts.agregadasTarde).toBe(1);
  });

  it("el borde: 17:00 en punto no es tardía; un segundo después, sí; creada el mismo día de despacho dice el día", () => {
    expect(swaypAddedLate(lima("2026-11-03", "17:00").toISOString(), "2026-11-04")).toBe(false);
    expect(swaypAddedLate(new Date(lima("2026-11-03", "17:00").getTime() + 1000).toISOString(), "2026-11-04")).toBe(true);
    expect(swaypAddedLate(null, "2026-11-04")).toBe(false);
    const g = limaGuide("KP22-S01", { guide: "522", createdAt: "2026-11-04T05:30:00Z", emittedAt: "2026-11-04T05:30:00Z" });
    const data = buildWarehouseSwayp(input([g]), lima("2026-11-04", "01:00"));
    expect(data.hoy!.faltan[0]!.chips).toContainEqual({ tone: "warn", text: "Agregada mié 4 nov 00:30, después de las 17:00" });
  });

  it("quién: la gestión que acompaña a la emisión; sin gestión, «sin registro»; el automático, «el automático»", () => {
    const s = shipment("sh-1", { guide_code: "530", order_id: "o-1" });
    const e = emission("e-1", { order_id: "o-1", guide_code: "530", created_at: "2026-11-03T15:00:00Z" });
    // Una gestión vieja de la salida «por definir» no es la de la guía.
    const old = call("sh-1", "2026-11-02T15:00:00Z", { agent: "u-otra", kind: "call" });
    const creator = call("sh-1", "2026-11-03T15:00:01Z", { agent: "u-asesora-b" });
    expect(swaypGuideOrigin(s, [e], [old, creator])).toEqual({ at: "2026-11-03T15:00:00Z", agent: "u-asesora-b", automatic: false });
    // Sin emisión (guía escrita a mano): la primera `reroute`.
    expect(swaypGuideOrigin(s, [], [old, creator])).toEqual({ at: "2026-11-03T15:00:01Z", agent: "u-asesora-b", automatic: false });
    expect(swaypGuideOrigin(s, [], [])).toEqual({ at: null, agent: null, automatic: false });

    const g = limaGuide("KP23-S01", { guide: "523", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", agent: null });
    const auto = { ...g, emission: { ...g.emission, automatic: true } };
    expect(buildWarehouseSwayp(input([auto]), NOW).proximo.faltan[0]!.createdLine).toBe(`Creó la guía: ${SWAYP_CREATOR_AUTOMATIC} · martes 3 nov 10:00`);
    const none = buildWarehouseSwayp(input([], { shipments: [g.shipment], orders: [g.order] }), NOW).proximo.faltan[0]!;
    expect(none.createdLine).toBe("Creó la guía: sin registro");
    expect(none.guideCreatedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dónde está la caja (R11)
// ---------------------------------------------------------------------------

describe("dónde está la caja física: la primera regla que aplica", () => {
  const self = shipment("sh-S02", { output_code: "KP9-S02", output_number: 2 });
  const sib = (extra: Partial<SwaypShipmentRow>) => shipment("sh-S01", { output_code: "KP9-S01", output_number: 1, courier: "propio", ...extra });

  it("a) la misma salida existía antes de la guía (o ya tiene rótulo)", () => {
    expect(swaypBoxWhereabouts({ self, preExisting: true, siblings: [] }).text).toBe("Es la caja «por definir» KP9-S02: ármala y escanéala; el rótulo no cambia.");
    expect(swaypBoxWhereabouts({ self: { ...self, preparation_state: "rotulo_generado" }, preExisting: false, siblings: [] }).kind).toBe("por_definir");
  });

  it("b) una hermana armada en la empresa", () => {
    const where = swaypBoxWhereabouts({ self, preExisting: false, siblings: [self, sib({ preparation_state: "listo_despacho", custody_state: "empresa" })] });
    expect(where.text).toBe("La caja está armada como KP9-S01 (Grupo GF): ponle el rótulo KP9-S02, escanéalo y avisa a Despacho que la S01 no sale.");
  });

  it("c) una hermana que se armó y volvió a la oficina (devuelto o `returned_at`)", () => {
    const armed = { preparation_state: "listo_despacho", ready_at: "2026-10-30T15:00:00Z" };
    for (const extra of [{ custody_state: "devuelto" }, { custody_state: "retorno", returned_at: "2026-11-02T18:00:00Z" }]) {
      const where = swaypBoxWhereabouts({ self, preExisting: false, siblings: [sib({ courier: "tanders", ...armed, ...extra })] });
      expect(where.text).toBe("La KP9-S01 (Tanders) volvió a la oficina: si la caja está entera, úsala con el rótulo KP9-S02; si no, ármala desde stock.");
    }
    // `retorno` sin `returned_at` sigue con el courier camino de vuelta (MOM §9.4): no «volvió».
    const coming = swaypBoxWhereabouts({ self, preExisting: false, siblings: [sib({ courier: "tanders", ...armed, custody_state: "retorno", delivery_status: "en_ruta" })] });
    expect(coming.kind).toBe("hermana_fuera");
    // Una hermana que nunca se armó no dice dónde está ninguna caja (KP142869-S03: la S02 de Tanders, devuelta sin armar).
    const never = swaypBoxWhereabouts({ self, preExisting: false, siblings: [sib({ courier: "tanders", custody_state: "devuelto" })] });
    expect(never.kind).toBe("desde_stock");
  });

  it("c') una hermana armada que salió con su courier y no se entregó: Despacho la trae de vuelta (KP142666-S02)", () => {
    const gfOut = sib({ preparation_state: "listo_despacho", ready_at: "2026-10-20T15:00:00Z", custody_state: "courier", delivery_status: "pendiente", status_category: "pending", swayp_state: null });
    const where = swaypBoxWhereabouts({ self, preExisting: false, siblings: [self, gfOut] });
    expect(where).toEqual({
      kind: "hermana_fuera",
      text: "La caja salió como KP9-S01 (Grupo GF) y no se entregó: pide a Despacho que la traiga de vuelta, ponle el rótulo KP9-S02 y escanéalo; si no vuelve a tiempo, ármala desde stock.",
      sibling: { shipmentId: "sh-S01", code: "KP9-S01", courier: "Grupo GF" },
    });
    // Nunca «No hay caja armada en Kapta» si hay una hermana armada sin entregar.
    expect(where.text).not.toContain("No hay caja armada");
    // Una caja que vuelve gana sobre una que sigue fuera: está en la oficina.
    const back = { ...sib({ courier: "tanders", preparation_state: "listo_despacho", custody_state: "devuelto" }), id: "sh-S00", output_code: "KP9-S00", output_number: 0 };
    expect(swaypBoxWhereabouts({ self, preExisting: false, siblings: [gfOut, back] }).kind).toBe("hermana_volvio");
  });

  it("d) si no, desde stock: sin hermanas armadas, o la armada ya se entregó", () => {
    const delivered = sib({ custody_state: "courier", preparation_state: "listo_despacho", delivery_status: "entregado", status_category: "delivered" });
    for (const siblings of [[], [delivered], [sib({ custody_state: "courier" })]]) {
      expect(swaypBoxWhereabouts({ self, preExisting: false, siblings })).toEqual({
        kind: "desde_stock",
        text: "No hay caja armada en Kapta para esta salida: ármala desde stock con el rótulo KP9-S02.",
        sibling: null,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// El tono de la víspera
// ---------------------------------------------------------------------------

describe("el tono de «Próximo», siempre con texto", () => {
  const zone = { day: "2026-11-04", programadas: 9, faltan: 1 };

  it("16:59 neutro; 17:00 y 21:19 ámbar con la cuenta atrás; 21:20 crítico", () => {
    expect(swaypZoneTone(zone, lima("2026-11-03", "16:59"))).toEqual({ kind: "neutral", text: SWAYP_TONE_VISPERA });
    expect(SWAYP_TONE_VISPERA).toBe("Swayp cierra su ruta entre las 16:00 y las 17:00. Déjalo listo antes del corte de las 21:20.");
    expect(swaypZoneTone(zone, lima("2026-11-03", "17:00"))).toEqual({ kind: "warn", text: "Faltan 4 h 20 min para el corte de las 21:20: déjalo listo." });
    expect(swaypZoneTone(zone, lima("2026-11-03", "20:10"))).toEqual({ kind: "warn", text: "Faltan 1 h 10 min para el corte de las 21:20: déjalo listo." });
    expect(swaypZoneTone(zone, lima("2026-11-03", "21:19"))).toEqual({ kind: "warn", text: "Faltan 1 min para el corte de las 21:20: déjalo listo." });
    expect(swaypZoneTone(zone, lima("2026-11-03", "21:20"))).toEqual({ kind: "crit", text: "El turno noche cerró con 1 sin armar: avisa a Seguimiento." });
    expect(swaypZoneTone({ ...zone, faltan: 2 }, lima("2026-11-03", "23:59"))).toEqual({ kind: "crit", text: "El turno noche cerró con 2 sin armar: avisa a Seguimiento." });
  });

  it("la víspera aún no llega (el sábado para el lunes): lo arma el turno noche del domingo", () => {
    expect(swaypZoneTone({ day: "2026-11-09", programadas: 3, faltan: 3 }, lima("2026-11-07", "20:00"))).toEqual({
      kind: "neutral",
      text: "Lo arma el turno noche del domingo 8 nov, antes del corte de las 21:20.",
    });
    // El domingo es la víspera del lunes.
    expect(swaypZoneTone({ day: "2026-11-09", programadas: 3, faltan: 3 }, lima("2026-11-08", "21:20")).kind).toBe("crit");
  });

  it("sin faltas, «Lote completo.»; sin nada programado, la frase vacía", () => {
    expect(swaypZoneTone({ ...zone, faltan: 0 }, lima("2026-11-03", "21:30"))).toEqual({ kind: "ok", text: SWAYP_TONE_COMPLETO });
    expect(swaypZoneTone({ ...zone, programadas: 0, faltan: 0 }, lima("2026-11-03", "21:30"))).toEqual({ kind: "neutral", text: SWAYP_EMPTY("miércoles 4 nov") });
  });

  it("cabecera y celda: singular, plural, lote completo y vacío", () => {
    expect(swaypZoneHeadline("proximo", "2026-11-04", { programadas: 9, armadas: 8, faltan: 1 })).toBe("Swayp miércoles 4 nov: 9 programadas · 8 armadas · falta 1");
    expect(swaypZoneHeadline("proximo", "2026-11-04", { programadas: 9, armadas: 7, faltan: 2 })).toBe("Swayp miércoles 4 nov: 9 programadas · 7 armadas · faltan 2");
    expect(swaypZoneHeadline("proximo", "2026-11-04", { programadas: 9, armadas: 9, faltan: 0 })).toBe("Swayp miércoles 4 nov: 9 programadas · 9 armadas · lote completo");
    expect(swaypZoneHeadline("hoy", "2026-11-03", { programadas: 7, armadas: 7, faltan: 0 })).toBe("Swayp hoy: 7 programadas · 7 armadas");
    expect(swaypZoneHeadline("proximo", "2026-11-04", { programadas: 0, armadas: 0, faltan: 0 })).toBe("Swayp no lleva nada de Lima el miércoles 4 nov.");
    const cell = (programadas: number, armadas: number, faltan: number) =>
      swaypCell({ dayLabel: "miércoles 4 nov", counts: { programadas, armadas, faltan, agregadasTarde: 0 }, tone: null });
    expect(cell(9, 8, 1)).toMatchObject({ big: "Falta 1", sub: "miércoles 4 nov · 9 programadas · 8 armadas" });
    expect(cell(9, 7, 2).big).toBe("Faltan 2");
    expect(cell(9, 9, 0).big).toBe("Completo");
    expect(cell(0, 0, 0).big).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// La zona «Hoy»
// ---------------------------------------------------------------------------

describe("«Hoy» para cuadrar: el estado de Swayp como dato y qué hacer con la falta", () => {
  it("antes de la entrega, toda falta de hoy se arma y se entrega en «Entregar a Swayp» o se marca «No sale» (fase 3, 04-11-2026)", () => {
    const here = limaGuide("KP30-S01", { day: "2026-11-03", guide: "530", createdAt: "2026-11-02T15:00:00Z", emittedAt: "2026-11-02T15:00:00Z" });
    const taken = limaGuide("KP31-S01", {
      day: "2026-11-03", guide: "531", createdAt: "2026-11-02T15:00:00Z", emittedAt: "2026-11-02T15:00:00Z",
      extra: { custody_state: "courier", swayp_state: 5, custody_transferred_at: "2026-11-03T05:38:27Z" },
    });
    const delivered = limaGuide("KP32-S01", {
      day: "2026-11-03", guide: "532", createdAt: "2026-11-02T15:00:00Z", emittedAt: "2026-11-02T15:00:00Z", readyAt: "2026-11-02T16:00:00Z",
      extra: { custody_state: "courier", swayp_state: 7, delivery_status: "entregado", status_category: "delivered", custody_transferred_at: "2026-11-03T05:38:27Z" },
    });
    const hoy = buildWarehouseSwayp(input([here, taken, delivered]), lima("2026-11-03", "09:00")).hoy!;
    expect(hoy.headline).toBe("Swayp hoy: 3 programadas · 1 armada · faltan 2");
    expect(hoy.note).toBe(SWAYP_HOY_NOTE);
    // Swayp carga su ruta hacia las 05:45 y pasa a las 07:00: que la haya
    // «tomado» en su sistema es lo normal en «Hoy», y la entrega la arma al
    // escanearla. El estado de Swayp va sin hora (las horas de Swayp llevan 5 h
    // de menos en lo guardado antes del 05-11-2026).
    expect(hoy.faltan.map((f) => [f.code, f.swaypLine, f.actionLine, f.taken])).toEqual([
      ["KP30-S01", "Swayp: Generada", { kind: "crit", text: SWAYP_HOY_FALTA_ENTREGA }, false],
      ["KP31-S01", "Swayp: Reparto", { kind: "crit", text: SWAYP_HOY_FALTA_ENTREGA }, true],
    ]);
    // En «Hoy» las dos dicen dónde está la caja: se arma al entregarla.
    expect(hoy.faltan[0]!.where?.kind).toBe("desde_stock");
    expect(hoy.faltan[1]!.where?.kind).toBe("desde_stock");
    expect(hoy.armadas[0]!.swaypLine).toBe("Swayp: Entregada");
    expect(hoy.entrega).toBeNull();
    expect(swaypHoyUrgent(hoy)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// El escáner y la copia local
// ---------------------------------------------------------------------------

describe("el escáner, con el lote ya cargado", () => {
  function lot(n: number): WarehouseSwaypData {
    const guides = Array.from({ length: n }, (_, i) => limaGuide(`KP${40 + i}-S01`, {
      guide: `54${i}`, district: ["Ate", "Surco", "Barranco", "Lince", "Rímac"][i % 5], createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z",
    }));
    return buildWarehouseSwayp(input(guides), NOW);
  }
  const scanOf = (code: string) => ({ id: `sh-${code}`, order_id: `o-${code.split("-")[0]}`, courier: "fenix", output_code: code, guide_code: "" });

  it("faltan otras: una con su distrito; varias hasta 3 y «y N más»", () => {
    expect(swaypScanHint(lot(2), scanOf("KP40-S01"))).toEqual({ kind: "lote", tone: "info", text: "Swayp miércoles 4 nov · 1 de 2 armadas · falta KP41-S01 (Surco)." });
    expect(swaypScanHint(lot(6), scanOf("KP40-S01"))).toEqual({
      kind: "lote",
      tone: "info",
      text: "Swayp miércoles 4 nov · 1 de 6 armadas · faltan 5: KP41-S01 (Surco), KP42-S01 (Barranco), KP43-S01 (Lince) y 2 más.",
    });
  });

  it("una caja Swayp que no es de ningún lote: guárdala aparte; con y sin «Hoy»", () => {
    const stray = { id: "sh-x", order_id: "o-x", courier: "fenix", output_code: "KP99-S01", guide_code: "" };
    expect(swaypScanHint(lot(1), stray)).toEqual({
      kind: "fuera",
      tone: "warn",
      text: "Esta caja Swayp no sale hoy ni el miércoles 4 nov: guárdala aparte y revisa la fecha en el pedido.",
    });
    const sunday = buildWarehouseSwayp(input([]), lima("2026-11-08", "20:00"));
    expect(swaypScanHint(sunday, stray)?.text).toBe("Esta caja Swayp no sale el lunes 9 nov: guárdala aparte y revisa la fecha en el pedido.");
    // Otro courier sin falta Swayp en su pedido: nada que decir.
    expect(swaypScanHint(lot(1), { ...stray, courier: "propio" })).toBeNull();
  });

  it("provincia y «Revisar» no se tratan como fuera de lote; sin datos o con error, nada", () => {
    const data = buildWarehouseSwayp(productionSeed(), NOW);
    expect(swaypScanHint(data, { id: "sh-KP201325-S02", order_id: "o-KP201325", courier: "fenix", output_code: "KP201325-S02", guide_code: "" })).toBeNull();
    expect(swaypScanHint(null, scanOf("KP40-S01"))).toBeNull();
    expect(swaypScanHint(emptyWarehouseSwayp({ nowIso: NOW.toISOString(), error: SWAYP_ERROR }), scanOf("KP40-S01"))).toBeNull();
    expect(swaypScanHint(data, null)).toBeNull();
  });

  it("applySwaypScan: la falta pasa a armada con la hora del escaneo; lo demás no cambia", () => {
    const data = lot(3);
    const after = applySwaypScan(data, "sh-KP41-S01", lima("2026-11-03", "20:10").toISOString(), "Almacén A");
    expect(after).not.toBe(data);
    expect(after.proximo.counts).toEqual({ programadas: 3, armadas: 1, faltan: 2, agregadasTarde: 0 });
    expect(after.proximo.headline).toBe("Swayp miércoles 4 nov: 3 programadas · 1 armada · faltan 2");
    expect(after.proximo.tone).toEqual({ kind: "warn", text: "Faltan 1 h 10 min para el corte de las 21:20: déjalo listo." });
    expect(after.proximo.cell.big).toBe("Faltan 2");
    expect(after.proximo.armadas[0]).toMatchObject({ code: "KP41-S01", readyBy: "Almacén A", line: "KP41-S01 · armada martes 3 nov 20:10 · Almacén A · Cliente · Surco" });
    expect(after.proximo.armadas[0]!.chips.map((c) => c.text)).not.toContain(SWAYP_CHIP_SIN_ARMAR);
    expect(after.hoy).toBe(data.hoy);
    // Lo que no es falta de un lote cargado devuelve el mismo objeto.
    expect(applySwaypScan(data, "sh-otra", NOW.toISOString())).toBe(data);
    const failed = emptyWarehouseSwayp({ nowIso: NOW.toISOString(), error: SWAYP_ERROR });
    expect(applySwaypScan(failed, "sh-KP41-S01", NOW.toISOString())).toBe(failed);
  });
});

// ---------------------------------------------------------------------------
// La asesora
// ---------------------------------------------------------------------------

describe("lo que se le dice a la asesora (D3)", () => {
  it("antes de las 17:00 de la víspera: entró al lote", () => {
    expect(swaypLotNotice({ day: "2026-11-04", now: lima("2026-11-03", "16:30"), lima: true })).toEqual({
      before: null,
      after: SWAYP_ASESORA_CREATED("miércoles 4 nov"),
      late: false,
      afterCutoff: false,
    });
    expect(SWAYP_ASESORA_CREATED("miércoles 4 nov")).toBe("Entró al lote Swayp de Lima del miércoles 4 nov. Almacén lo ve en «Swayp por salir».");
  });

  it("después de las 17:00: la verá como agregada tarde; después de las 21:20: el aviso fuerte, también antes de crear", () => {
    expect(swaypLotNotice({ day: "2026-11-04", now: lima("2026-11-03", "20:43"), lima: true })).toMatchObject({
      before: null,
      after: `${SWAYP_ASESORA_CREATED("miércoles 4 nov")} ${SWAYP_ASESORA_TARDE}`,
      late: true,
    });
    expect(swaypLotNotice({ day: "2026-11-04", now: lima("2026-11-03", "21:20"), lima: true })).toEqual({
      before: { kind: "crit", text: SWAYP_ASESORA_NOCHE },
      after: `${SWAYP_ASESORA_CREATED("miércoles 4 nov")} ${SWAYP_ASESORA_NOCHE}`,
      late: true,
      afterCutoff: true,
    });
    // Para el jueves no hay aviso: su víspera es mañana.
    expect(swaypLotNotice({ day: "2026-11-05", now: lima("2026-11-03", "22:00"), lima: true })).toMatchObject({ before: null, late: false });
  });

  it("el sábado para el lunes no avisa (la víspera es el domingo); el domingo a las 22:00, sí", () => {
    expect(swaypLotNotice({ day: "2026-11-09", now: lima("2026-11-07", "22:00"), lima: true })?.before).toBeNull();
    expect(swaypLotNotice({ day: "2026-11-09", now: lima("2026-11-08", "22:00"), lima: true })?.before?.kind).toBe("crit");
  });

  it("provincia no cambia", () => {
    expect(swaypLotNotice({ day: "2026-11-04", now: lima("2026-11-03", "22:00"), lima: false })).toBeNull();
    expect(swaypSuggestedDispatchDay({ now: lima("2026-11-03", "22:00"), lima: false })).toBe("2026-11-04");
  });

  it("la fecha por defecto: el próximo día de despacho; pasadas las 21:20 de su víspera, el siguiente", () => {
    expect(swaypSuggestedDispatchDay({ now: lima("2026-11-03", "21:19"), lima: true })).toBe("2026-11-04");
    expect(swaypSuggestedDispatchDay({ now: lima("2026-11-03", "21:20"), lima: true })).toBe("2026-11-05");
    // Sábado de noche: el lunes sigue a tiempo (lo arma el domingo).
    expect(swaypSuggestedDispatchDay({ now: lima("2026-11-07", "22:00"), lima: true })).toBe("2026-11-09");
    // Domingo de noche: el martes.
    expect(swaypSuggestedDispatchDay({ now: lima("2026-11-08", "22:00"), lima: true })).toBe("2026-11-10");
  });
});

describe("los textos fijos y la respuesta vacía", () => {
  it("título, ayuda y error", () => {
    expect(SWAYP_TITLE).toBe("Swayp por salir · Lima");
    expect(SWAYP_HELP).toBe("Guías Swayp de Lima y Callao. La caja se arma aquí y Swayp la recoge en la oficina. Se cuenta por día de despacho y no suma en «Por armar».");
    expect(SWAYP_ERROR).toBe("No pudimos cargar «Swayp por salir».");
  });

  it("vacía: las zonas tienen su día y su título, y el error si lo hay", () => {
    const empty = emptyWarehouseSwayp({ nowIso: "2026-11-03T22:42:00Z", error: SWAYP_ERROR });
    expect(empty).toMatchObject({ today: "2026-11-03", error: SWAYP_ERROR, leidoAt: "17:42" });
    expect(empty.proximo).toMatchObject({ title: "Mañana · miércoles 4 nov", empty: "Swayp no lleva nada de Lima el miércoles 4 nov.", faltan: [], armadas: [] });
    expect(empty.hoy?.title).toBe("Hoy · martes 3 nov");
    expect(emptyWarehouseSwayp({ nowIso: "2026-11-03T22:42:00Z" }).error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Revisión del 03-11-2026 (tres revisores, con filas reales de producción)
// ---------------------------------------------------------------------------

describe("una falta que Swayp ya tomó no se pide armar (KP143987-S02, tomada el 03-11 a las 00:37)", () => {
  // El estado real a las 10:52 del 03-11: Reparto, custodia del courier, sin escaneo.
  const takenS02 = () => {
    const g = limaGuide("KP143987-S02", {
      day: "2026-11-04", guide: "50000165022", district: "san bartolo", createdAt: "2026-11-03T05:11:10.904Z", emittedAt: "2026-11-03T05:11:09.552Z",
      extra: { swayp_state: 5, custody_state: "courier", custody_transferred_at: "2026-11-03T05:37:00Z" },
    });
    const aliclik = shipment("sh-KP143987-S01", {
      order_id: g.order.order_id, courier: "aliclik", output_code: "KP143987-S01", preparation_state: "listo_despacho", custody_state: "devuelto",
      ready_at: "2026-10-25T20:58:30Z", returned_at: "2026-11-02T18:51:16Z", delivery_status: "anulado", status_category: "closed", swayp_state: null,
    });
    return { g, aliclik };
  };

  it("swaypTaken: custodia fuera de la empresa, estado 3 o más, entregada o transferida", () => {
    const base = { custody_state: "empresa", swayp_state: 1, status_category: "in_route" };
    expect(swaypTaken(base)).toBe(false);
    expect(swaypTaken({ ...base, swayp_state: 2 })).toBe(false);
    expect(swaypTaken({ ...base, swayp_state: null })).toBe(false);
    expect(swaypTaken({ ...base, swayp_state: 3 })).toBe(true);
    expect(swaypTaken({ ...base, custody_state: "courier" })).toBe(true);
    expect(swaypTaken({ ...base, swayp_state: null, status_category: "delivered" })).toBe(true);
  });

  it("en «Próximo»: sigue siendo falta, sin «dónde está la caja», con qué hacer; el tono no dice «déjalo listo»", () => {
    const { g, aliclik } = takenS02();
    for (const at of ["09:28", "17:42", "21:30"]) {
      const next = buildWarehouseSwayp(input([g], { shipments: [aliclik] }), lima("2026-11-03", at)).proximo;
      expect(next.counts).toMatchObject({ programadas: 1, armadas: 0, faltan: 1 });
      const [falta] = next.faltan;
      expect(falta).toMatchObject({ taken: true, where: null, actionLine: { kind: "warn", text: SWAYP_HOY_FALTA_TOMADA } });
      expect(next.tone).toEqual({ kind: "warn", text: SWAYP_TONE_TOMADAS(1) });
      expect(next.cell).toMatchObject({ big: "Falta 1", tone: next.tone });
    }
    expect(SWAYP_TONE_TOMADAS(1)).toBe("1 no se armó y Swayp ya la tomó en su sistema: si la caja sigue aquí, avisa hoy a Seguimiento.");
    expect(SWAYP_TONE_TOMADAS(2)).toBe("2 no se armaron y Swayp ya las tomó en su sistema: si las cajas siguen aquí, avisa hoy a Seguimiento.");
  });

  it("con una que sigue aquí y otra tomada: la cuenta atrás por la que se puede armar; pasado el corte, todas", () => {
    const { g, aliclik } = takenS02();
    const here = limaGuide("KP60-S01", { guide: "560", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z" });
    const seed = input([g, here], { shipments: [aliclik] });
    expect(buildWarehouseSwayp(seed, lima("2026-11-03", "20:10")).proximo.tone).toEqual({ kind: "warn", text: "Faltan 1 h 10 min para el corte de las 21:20: déjalo listo." });
    expect(buildWarehouseSwayp(seed, lima("2026-11-03", "21:30")).proximo.tone).toEqual({ kind: "crit", text: "El turno noche cerró con 2 sin armar: avisa a Seguimiento." });
    // La que sigue aquí conserva su renglón de dónde está la caja.
    const rows = buildWarehouseSwayp(seed, NOW).proximo.faltan;
    expect(rows.find((r) => r.code === "KP60-S01")!.where?.kind).toBe("desde_stock");
  });

  it("una entregada antes de su día también es tomada: no se pide armarla", () => {
    const g = limaGuide("KP61-S01", {
      guide: "561", createdAt: "2026-11-03T05:00:00Z", emittedAt: "2026-11-03T05:00:00Z",
      extra: { swayp_state: 7, delivery_status: "entregado", status_category: "delivered", custody_state: "courier" },
    });
    const [falta] = buildWarehouseSwayp(input([g]), NOW).proximo.faltan;
    expect(falta).toMatchObject({ taken: true, where: null });
  });
});

describe("las devoluciones de Swayp no son «Guía anulada en Kapta» (estados 9, 11 y 12)", () => {
  it("son los que la sincronización cierra después de que Swayp tuvo la caja", () => {
    for (const state of SWAYP_CLOSED_AFTER_PICKUP_STATES) expect(mapSwaypState(state)).toBe("anulado");
    expect([...SWAYP_CLOSED_AFTER_PICKUP_STATES].filter((state) => SWAYP_RETURN_STATES.has(state)).sort()).toEqual([12, 9].sort());
    const closed = { delivery_status: "anulado", status_category: "closed" };
    for (const state of [9, 11, 12]) expect(swaypExitReason({ ...closed, swayp_state: state }, null)).toBeNull();
    // La cancelación de la tienda sigue mandando.
    expect(swaypExitReason({ ...closed, swayp_state: 9 }, { general_status: "anulado", cancelled_at: "2026-11-03T18:00:00Z" })).toBe("pedido_anulado");
  });

  it("en «Hoy» la devuelta el mismo día cuenta y cuadra, con su estado de Swayp (KP135906-S01, 23-09)", () => {
    const returned = limaGuide("KP70-S01", {
      day: "2026-11-03", guide: "570", createdAt: "2026-11-02T15:00:00Z", emittedAt: "2026-11-02T15:00:00Z", readyAt: "2026-11-02T16:00:00Z",
      extra: { swayp_state: 9, delivery_status: "anulado", status_category: "closed", custody_state: "retorno", custody_transferred_at: "2026-11-03T10:44:00Z" },
    });
    const hoy = buildWarehouseSwayp(input([returned]), lima("2026-11-03", "19:40")).hoy!;
    expect(hoy.headline).toBe("Swayp hoy: 1 programada · 1 armada");
    expect(hoy.salieron).toEqual([]);
    expect(hoy.armadas[0]!.swaypLine).toBe("Swayp: Devolución confirmada");
  });

  it("«Estaba armada: sácala del sitio de Swayp» solo si la caja sigue en la empresa", () => {
    const out = limaGuide("KP71-S01", {
      guide: "571", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", readyAt: "2026-11-03T16:00:00Z",
      extra: { custody_state: "courier", swayp_state: 4 }, orderExtra: { general_status: "anulado", cancelled_at: "2026-11-03T18:00:00Z" },
    });
    const [row] = buildWarehouseSwayp(input([out]), NOW).proximo.salieron;
    expect(row).toMatchObject({ reason: "pedido_anulado", wasArmed: true, armedText: null });
  });
});

describe("una directa anulada en Kapta no desaparece en silencio (R8; `cancelFenixDirectGuide`)", () => {
  it("anulada y sin fecha: «Guía anulada en Kapta», y si estaba armada, sácala", () => {
    const g = limaGuide("KP80-S01", {
      guide: "580", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", readyAt: "2026-11-03T16:00:00Z",
      extra: { next_followup_at: null, delivery_status: "anulado", status_category: "closed" },
    });
    const next = buildWarehouseSwayp(input([g]), NOW).proximo;
    expect(next.salieron.map((row) => [row.code, row.reason, row.text, row.armedText])).toEqual([
      ["KP80-S01", "guia_anulada", SWAYP_SALIO_ANULADA, SWAYP_SALIO_ARMADA],
    ]);
    expect(next.headline).toBe(SWAYP_EMPTY("miércoles 4 nov"));
    // El escáner la reconoce.
    expect(swaypScanHint(buildWarehouseSwayp(input([g]), NOW), { id: g.shipment.id, order_id: g.order.order_id, courier: "fenix", output_code: "KP80-S01", guide_code: "580" }))
      .toEqual({ kind: "salio", tone: "crit", text: SWAYP_SCAN_ANULADA });
  });

  it("la «por definir» rellenada vuelve a `por_definir` sin la guía: se nombra la guía que se anuló", () => {
    const g = limaGuide("KP81-S01", {
      guide: "581", createdAt: "2026-11-03T12:00:00Z", emittedAt: "2026-11-03T15:00:00Z", readyAt: "2026-11-03T13:00:00Z",
      extra: { courier: "por_definir", guide_code: "KP81-S01-RUTA", swayp_guide: null, swayp_state: null, next_followup_at: null, delivery_status: "pendiente", status_category: "pending" },
    });
    const [row] = buildWarehouseSwayp(input([g]), NOW).proximo.salieron;
    expect(row).toMatchObject({ code: "KP81-S01", guideCode: "581", reason: "guia_anulada", armedText: SWAYP_SALIO_ARMADA });
  });

  it("sin fecha pero viva (recuperación descartada) o una emisión que no llegó a crear guía: nada", () => {
    const live = limaGuide("KP82-S01", { guide: "582", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", extra: { next_followup_at: null } });
    const review = limaGuide("KP83-S01", { guide: "583", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", extra: { next_followup_at: null, delivery_status: "anulado", status_category: "closed" } });
    const seed = input([live, { ...review, emission: { ...review.emission, state: "review", guide_code: null } }]);
    expect(buildWarehouseSwayp(seed, NOW).proximo.salieron).toEqual([]);
  });
});

describe("el aviso del escáner no da una orden falsa con un lote viejo (swaypHintAfterScan)", () => {
  const scanOf = (code: string, extra: Record<string, unknown> = {}) => ({ id: `sh-${code}`, order_id: `o-${code.split("-")[0]}`, courier: "fenix", output_code: code, guide_code: "", ...extra });
  const lotOf = (codes: string[], now = NOW) => buildWarehouseSwayp(input(codes.map((code, i) => limaGuide(code, {
    guide: `59${i}`, createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z",
  }))), now);

  it("una caja del lote: el aviso con lo cargado, sin releer", async () => {
    const reread = vi.fn(async () => null);
    const hint = await swaypHintAfterScan(lotOf(["KP90-S01", "KP91-S01"]), scanOf("KP90-S01"), { now: NOW, reread });
    expect(hint?.kind).toBe("lote");
    expect(reread).not.toHaveBeenCalled();
  });

  it("una caja Swayp fuera de lo cargado: relee antes de decir «guárdala aparte» (una agregada tarde)", async () => {
    const stale = lotOf(["KP90-S01"]);
    const fresh = lotOf(["KP90-S01", "KP92-S01"]);
    const found = await swaypHintAfterScan(stale, scanOf("KP92-S01"), { now: NOW, reread: async () => fresh });
    expect(found).toMatchObject({ kind: "lote", text: "Swayp miércoles 4 nov · 1 de 2 armadas · falta KP90-S01 (Surco)." });
    const outside = await swaypHintAfterScan(stale, scanOf("KP99-S01"), { now: NOW, reread: async () => stale });
    expect(outside).toEqual({ kind: "fuera", tone: "warn", text: SWAYP_SCAN_FUERA("miércoles 4 nov", true) });
    // Si la relectura falla, ningún aviso: mejor ninguno que uno equivocado.
    expect(await swaypHintAfterScan(stale, scanOf("KP99-S01"), { now: NOW, reread: async () => null })).toBeNull();
  });

  it("un lote de otro día (la estación pasó la noche abierta): relee; sin relectura, nada", async () => {
    const tuesday = lotOf(["KP90-S01"], lima("2026-11-03", "21:00"));
    const wednesday = lima("2026-11-04", "09:00");
    expect(swaypLotIsCurrent(tuesday, wednesday)).toBe(false);
    expect(await swaypHintAfterScan(tuesday, scanOf("KP99-S01"), { now: wednesday, reread: async () => null })).toBeNull();
    // Tampoco el rótulo viejo de otro courier con un lote viejo: no se relee por él.
    const reread = vi.fn(async () => null);
    expect(await swaypHintAfterScan(tuesday, scanOf("KP90-S00", { courier: "propio" }), { now: wednesday, reread })).toBeNull();
    expect(reread).not.toHaveBeenCalled();
    const thursday = buildWarehouseSwayp(input([limaGuide("KP93-S01", { day: "2026-11-05", guide: "593", createdAt: "2026-11-04T13:00:00Z", emittedAt: "2026-11-04T13:00:00Z" })]), wednesday);
    expect(await swaypHintAfterScan(tuesday, scanOf("KP93-S01"), { now: wednesday, reread: async () => thursday })).toMatchObject({ kind: "completo" });
  });
});

describe("textos que la revisión corrigió", () => {
  it("el pie de provincia en singular y la ayuda de «Revisar»", () => {
    expect(SWAYP_PROVINCIA(1, "miércoles 4 nov", "Arequipa 1")).toBe("Provincia: 1 guía Swayp sale el miércoles 4 nov desde la bodega de Swayp (Arequipa 1). No se empaca aquí.");
    expect(SWAYP_PROVINCIA(9, "miércoles 4 nov", "Arequipa 2, Ica 2")).toBe("Provincia: 9 guías Swayp salen el miércoles 4 nov desde bodegas de Swayp (Arequipa 2, Ica 2). No se empacan aquí.");
  });

  it("swaypHoyUrgent: solo las de hoy que siguen aquí y Swayp no tomó", () => {
    expect(swaypHoyUrgent(null)).toBe(0);
    expect(swaypHoyUrgent(buildWarehouseSwayp(productionSeed(), NOW).proximo)).toBe(0);
  });
});
