// «Entregar a Swayp» · Lima (fase 3, owner 04-11-2026; MOM §9.1): las reglas
// puras de lib/swayp-handover.ts y lo que la zona «Hoy» de «Swayp por salir»
// dice con la entrega del día.

import { describe, expect, it } from "vitest";
import {
  SWAYP_ALERT_NO_DESPACHO,
  SWAYP_ALERT_NO_SALIO_EN_REPARTO,
  SWAYP_CLOSE_COUNT,
  SWAYP_CLOSE_COUNT_MISMATCH,
  SWAYP_CLOSE_DRIVER,
  SWAYP_CLOSE_MISSING,
  SWAYP_CLOSE_NEW_IN_LOT,
  SWAYP_CLOSE_NOTHING,
  SWAYP_ENTREGA_CERRADA,
  SWAYP_ENTREGA_EN_CURSO,
  SWAYP_ENTREGA_NO_VINO,
  SWAYP_ENTREGA_SIN_ABRIR,
  SWAYP_HANDOVER_CERRADA,
  SWAYP_HANDOVER_NO_LIMA,
  SWAYP_HANDOVER_OTRO_COURIER,
  SWAYP_HANDOVER_OTRO_DIA,
  SWAYP_HANDOVER_PROVINCIA,
  SWAYP_HANDOVER_SIN_FECHA,
  SWAYP_HANDOVER_YA_ENTREGADA,
  SWAYP_HOY_FALTA_ENTREGA,
  SWAYP_HOY_FALTA_PASO,
  SWAYP_NO_SALE_EXPLAIN,
  SWAYP_NO_SALE_PICK,
  SWAYP_NO_SALE_REASONS,
  SWAYP_NO_SALE_TOO_LONG,
  SWAYP_PICKUP_LABEL,
  SWAYP_PICKUP_MINUTE,
  SWAYP_ROW_SIN_ENTREGA,
  buildSwaypHandover,
  swaypCloseError,
  swaypHandoverRowLine,
  swaypHandoverVerdict,
  swaypNoSaleCodeOf,
  swaypNoSaleError,
  swaypNoSaleNote,
  swaypNoSaleText,
  swaypSaysUndispatched,
  swaypSuggestedNoSale,
  type SwaypHandoverShipment,
} from "@/lib/swayp-handover";
import { SWAYP_HOY_NOTE, buildWarehouseSwayp, swaypDayLabel, swaypHoyUrgent } from "@/lib/warehouse-swayp";
import { limaAt, swaypInput, swaypLimaGuide } from "./helpers/warehouse-swayp-fixtures";

const WED = "2026-11-04";
const ctx = { day: WED, operation: "lima", courierLabel: "Swayp", dayLabelOf: swaypDayLabel };
const guide = (extra: Partial<SwaypHandoverShipment> = {}): SwaypHandoverShipment => ({
  courier: "fenix",
  output_code: "KP2-S02",
  guide_code: "50000165324",
  swayp_state: 1,
  custody_state: "empresa",
  custody_transferred_by: null,
  next_followup_at: `${WED}T00:00:00+00:00`,
  ...extra,
});

describe("qué caja entra en la entrega de hoy", () => {
  it("la que sigue en la empresa y la que Swayp cargó (custodia de la sincronización, sin persona)", () => {
    expect(swaypHandoverVerdict(guide(), ctx)).toEqual({ ok: true, syncCustody: false });
    expect(swaypHandoverVerdict(guide({ custody_state: "courier", swayp_state: 5 }), ctx)).toEqual({ ok: true, syncCustody: true });
  });

  it("lo demás no entra, y se dice por qué", () => {
    expect(swaypHandoverVerdict(guide({ courier: "propio", output_code: "KP2-S01" }), { ...ctx, courierLabel: "Grupo GF" }))
      .toEqual({ ok: false, error: SWAYP_HANDOVER_OTRO_COURIER("KP2-S01", "Grupo GF") });
    expect(swaypHandoverVerdict(guide(), { ...ctx, operation: "provincia_cod" })).toEqual({ ok: false, error: SWAYP_HANDOVER_PROVINCIA });
    expect(swaypHandoverVerdict(guide(), { ...ctx, operation: "agencia" })).toEqual({ ok: false, error: SWAYP_HANDOVER_NO_LIMA });
    expect(swaypHandoverVerdict(guide({ next_followup_at: null }), ctx)).toEqual({ ok: false, error: SWAYP_HANDOVER_SIN_FECHA });
    expect(swaypHandoverVerdict(guide({ next_followup_at: "2026-11-05T00:00:00+00:00" }), ctx))
      .toEqual({ ok: false, error: SWAYP_HANDOVER_OTRO_DIA("jueves 5 nov") });
    // KP143987-S02: Swayp la repartió y devolvió antes de su día.
    expect(swaypHandoverVerdict(guide({ swayp_state: 8, custody_state: "retorno" }), ctx))
      .toEqual({ ok: false, error: SWAYP_HANDOVER_CERRADA("Devolución") });
    for (const state of [7, 9, 10, 11, 12]) expect(swaypHandoverVerdict(guide({ swayp_state: state }), ctx).ok).toBe(false);
    // Custodia de la sincronización sin estado de Swayp: no se sabe si la tiene cargada.
    expect(swaypHandoverVerdict(guide({ custody_state: "courier", swayp_state: null }), ctx).ok).toBe(false);
    // La custodia la pasó una persona: ya se entregó.
    expect(swaypHandoverVerdict(guide({ custody_state: "courier", custody_transferred_by: "u-yelitza" }), ctx))
      .toEqual({ ok: false, error: SWAYP_HANDOVER_YA_ENTREGADA });
  });
});

describe("«No sale» bien explicado (E4)", () => {
  it("siete motivos cerrados; «El chofer no la llevó» y «Otro motivo» exigen explicación", () => {
    expect(SWAYP_NO_SALE_REASONS.map((r) => r.code)).toEqual([
      "no_encontrada", "sin_stock", "otro_courier", "danada", "chofer_no_llevo", "pedido_anulado", "otro",
    ]);
    expect(SWAYP_NO_SALE_REASONS.filter((r) => r.detailRequired).map((r) => r.code)).toEqual(["chofer_no_llevo", "otro"]);
    expect(swaypNoSaleError("", "")).toBe(SWAYP_NO_SALE_PICK);
    expect(swaypNoSaleError("inventado", "algo")).toBe(SWAYP_NO_SALE_PICK);
    expect(swaypNoSaleError("otro", "corto")).toBe(SWAYP_NO_SALE_EXPLAIN);
    expect(swaypNoSaleError("chofer_no_llevo", "   ")).toBe(SWAYP_NO_SALE_EXPLAIN);
    expect(swaypNoSaleError("no_encontrada", "")).toBeNull();
    expect(swaypNoSaleError("otro", "La clienta pidió recoger en tienda")).toBeNull();
    expect(swaypNoSaleError("sin_stock", "x".repeat(301))).toBe(SWAYP_NO_SALE_TOO_LONG);
  });

  it("se guarda «No sale: <motivo>. <explicación>», se reconoce y deja el aviso a Seguimiento", () => {
    const text = swaypNoSaleText("chofer_no_llevo", "  No le cabía en la moto ");
    expect(text).toBe("No sale: El chofer de Swayp no la llevó. No le cabía en la moto.");
    expect(swaypNoSaleText("no_encontrada", "")).toBe("No sale: No se encontró la caja en la oficina.");
    expect(swaypNoSaleCodeOf(text)).toBe("chofer_no_llevo");
    expect(swaypNoSaleCodeOf("Ruta cancelada: Swayp no vino")).toBeNull();
    expect(swaypNoSaleNote(text)).toBe(
      "No salió con Swayp: El chofer de Swayp no la llevó. No le cabía en la moto. Seguimiento: cambia la fecha en Swayp o anula la guía hoy.",
    );
  });

  it("propone el motivo cuando la caja salió con la otra salida del pedido", () => {
    expect(swaypSuggestedNoSale({ kind: "hermana_fuera", sibling: { code: "KP201453-S01", courier: "Grupo GF" } }))
      .toEqual({ code: "otro_courier", detail: "La caja salió como KP201453-S01 con Grupo GF." });
    expect(swaypSuggestedNoSale({ kind: "desde_stock", sibling: null })).toBeNull();
    expect(swaypSuggestedNoSale(null)).toBeNull();
  });
});

describe("cerrar (E2)", () => {
  const base = { newInLot: [] as string[], active: 7, scanned: 7, driverName: "Juan Pérez", driverCount: 7 };
  it("exige que no entrara nada nuevo, el 100 %, el nombre y el conteo igual", () => {
    expect(swaypCloseError(base)).toBeNull();
    expect(swaypCloseError({ ...base, newInLot: ["KP9-S02"] })).toBe(SWAYP_CLOSE_NEW_IN_LOT(["KP9-S02"]));
    expect(SWAYP_CLOSE_NEW_IN_LOT(["KP9-S02"])).toBe("Entró KP9-S02 al lote de hoy: entrégala o márcala «No sale».");
    expect(swaypCloseError({ ...base, active: 0, scanned: 0 })).toBe(SWAYP_CLOSE_NOTHING);
    expect(swaypCloseError({ ...base, scanned: 6 })).toBe(SWAYP_CLOSE_MISSING(1));
    expect(SWAYP_CLOSE_MISSING(2)).toBe("Faltan 2: entrégalas o márcalas «No sale» con su motivo.");
    expect(swaypCloseError({ ...base, driverName: " Jo " })).toBe(SWAYP_CLOSE_DRIVER);
    expect(swaypCloseError({ ...base, driverCount: Number.NaN })).toBe(SWAYP_CLOSE_COUNT);
    expect(swaypCloseError({ ...base, driverCount: 6 })).toBe(SWAYP_CLOSE_COUNT_MISMATCH(6, 7));
    expect(SWAYP_CLOSE_COUNT_MISMATCH(6, 7)).toBe("El chofer contó 6 y escaneaste 7. Cuenten de nuevo antes de cerrar.");
  });
});

describe("la entrega del día y sus avisos (E3: manda lo cargado en Swayp; Kapta avisa)", () => {
  const manifest = { id: "m1", state: "office_check", received_by: null, custody_completed_at: null, cancelled_at: null, cancellation_reason: null };
  const rows = [
    { shipment_id: "a", office_checked_at: "2026-11-04T12:04:00Z", office_checked_by: "u-y", removed_at: null, removed_by: null, removal_reason: null },
    { shipment_id: "b", office_checked_at: null, office_checked_by: null, removed_at: null, removed_by: null, removal_reason: null },
    { shipment_id: "c", office_checked_at: null, office_checked_by: null, removed_at: "2026-11-04T12:06:00Z", removed_by: "u-y", removal_reason: "No sale: No se encontró la caja en la oficina." },
  ];

  it("en curso: cuenta entregadas, por entregar y «No sale»", () => {
    const h = buildSwaypHandover(manifest, rows, { "u-y": "Yelitza" });
    expect(h).toMatchObject({ state: "abierta", total: 2, delivered: 1, noSale: 1, missing: 1, statusLine: SWAYP_ENTREGA_EN_CURSO(1, 2) });
    expect(h.items.find((i) => i.shipmentId === "a")).toMatchObject({ status: "entregada", time: "07:04", by: "Yelitza" });
    expect(h.items.find((i) => i.shipmentId === "c")).toMatchObject({ status: "no_sale", reason: "No se encontró la caja en la oficina.", reasonCode: "no_encontrada" });
  });

  it("cerrada y «Swayp no vino»", () => {
    const closed = buildSwaypHandover({ ...manifest, state: "in_custody", received_by: "Juan Pérez", custody_completed_at: "2026-11-04T12:10:00Z" }, rows.filter((r) => r.shipment_id !== "b"), {});
    expect(closed.statusLine).toBe(SWAYP_ENTREGA_CERRADA({ receivedBy: "Juan Pérez", boxes: 1, time: "07:10", noSale: 1 }));
    expect(closed.statusLine).toBe("Entrega cerrada · recogió Juan Pérez (Swayp) · 1 caja · 07:10 · 1 no salió");
    const noVino = buildSwaypHandover({ ...manifest, state: "cancelled", cancellation_reason: "Swayp no vino" },
      rows.map((r) => ({ ...r, removed_at: "x", removal_reason: "Ruta cancelada: Swayp no vino" })), {});
    expect(noVino).toMatchObject({ state: "no_vino", statusTone: "crit", statusLine: SWAYP_ENTREGA_NO_VINO(3) });
  });

  it("las alertas van por estado de Swayp, nunca por hora", () => {
    const h = buildSwaypHandover({ ...manifest, state: "in_custody", received_by: "Juan Pérez", custody_completed_at: "2026-11-04T12:10:00Z" }, rows, {});
    // «No sale» y Swayp la tiene en reparto: Seguimiento corrige hoy.
    expect(swaypHandoverRowLine(h, { id: "c", swayp_state: 5 })).toEqual({
      kind: "crit", text: `No salió: No se encontró la caja en la oficina. ${SWAYP_ALERT_NO_SALIO_EN_REPARTO}`,
    });
    // Entregada y Swayp dice que la bodega no despachó: reclamo, con quién la recogió.
    expect(swaypSaysUndispatched("Swayp · Bodega no despacho mercancía (20)")).toBe(true);
    expect(swaypHandoverRowLine(h, { id: "a", swayp_state: 6, reported_status: "Swayp · Bodega no despacho mercancía (20)" }))
      .toEqual({ kind: "crit", text: SWAYP_ALERT_NO_DESPACHO("07:04", "Juan Pérez") });
    expect(swaypHandoverRowLine(h, { id: "a", swayp_state: 5 })).toEqual({ kind: "ok", text: "Entregada a Swayp 07:04" });
    // Cerrada sin fila: sin entrega; la que Swayp cerró antes, por qué no entró.
    expect(swaypHandoverRowLine(h, { id: "z", swayp_state: 5 })).toEqual({ kind: "warn", text: SWAYP_ROW_SIN_ENTREGA });
    expect(swaypHandoverRowLine(h, { id: "z", swayp_state: 8, custody_state: "retorno" })).toEqual({ kind: "warn", text: SWAYP_HANDOVER_CERRADA("Devolución") });
  });
});

describe("«Hoy» con la entrega", () => {
  const now = limaAt(WED, "07:20");
  const armed = swaypLimaGuide("KP1-S01", { day: WED, guide: "501", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", readyAt: "2026-11-03T20:00:00Z" });
  const loaded = swaypLimaGuide("KP2-S02", {
    day: WED, guide: "502", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z",
    extra: { custody_state: "courier", swayp_state: 5 },
  });

  it("sin abrir, antes de las 07:00: la nota y la falta que se arma al entregarla", () => {
    const hoy = buildWarehouseSwayp(swaypInput([armed, loaded]), limaAt(WED, "06:40")).hoy!;
    expect(hoy.note).toBe(SWAYP_HOY_NOTE);
    expect(SWAYP_HOY_NOTE).toBe(SWAYP_ENTREGA_SIN_ABRIR);
    expect(hoy.entrega).toBeNull();
    expect(hoy.faltan[0]!.actionLine).toEqual({ kind: "crit", text: SWAYP_HOY_FALTA_ENTREGA });
    expect(swaypHoyUrgent(hoy)).toBe(1);
  });

  it("sin abrir, pasadas las 07:00: el chofer pudo irse sin ella (owner, 05-11-2026)", () => {
    expect(SWAYP_PICKUP_MINUTE).toBe(7 * 60);
    expect(SWAYP_PICKUP_LABEL).toBe("07:00");
    expect(SWAYP_HOY_FALTA_PASO).toBe(
      "Pasó la hora de Swayp (07:00) sin entrega registrada. Si el chofer aún no se fue, entrégala en «Entregar a Swayp» o márcala «No sale»; si se fue sin ella, avisa a Seguimiento para que cambie la fecha en Swayp o anule la guía hoy.",
    );
    const at = (time: string) => buildWarehouseSwayp(swaypInput([armed, loaded]), limaAt(WED, time)).hoy!;
    // 06:59 todavía espera a Swayp; desde las 07:00 en punto ya no.
    expect(at("06:59").faltan[0]!.actionLine).toEqual({ kind: "crit", text: SWAYP_HOY_FALTA_ENTREGA });
    for (const time of ["07:00", "07:20", "13:00", "23:59"]) {
      const hoy = at(time);
      expect(hoy.faltan[0]!.actionLine, time).toEqual({ kind: "crit", text: SWAYP_HOY_FALTA_PASO });
      // La nota no cambia y la falta sigue siendo urgente.
      expect(hoy.note, time).toBe(SWAYP_HOY_NOTE);
      expect(swaypHoyUrgent(hoy), time).toBe(1);
    }
  });

  it("pasadas las 07:00 con la entrega abierta se sigue entregando; con «Swayp no vino», la falta no dice nada", () => {
    const open = {
      manifest: { id: "m1", state: "office_check", received_by: null, custody_completed_at: null, cancelled_at: null, cancellation_reason: null },
      items: [
        { shipment_id: "sh-KP1-S01", office_checked_at: "2026-11-04T12:04:00Z", office_checked_by: "u-almacen-a", removed_at: null, removed_by: null, removal_reason: null },
        { shipment_id: "sh-KP2-S02", office_checked_at: null, office_checked_by: null, removed_at: null, removed_by: null, removal_reason: null },
      ],
    };
    const inProgress = buildWarehouseSwayp({ ...swaypInput([armed, loaded]), handover: open, canHandover: true }, now).hoy!;
    expect(inProgress.note).toBe(SWAYP_ENTREGA_EN_CURSO(1, 2));
    expect(inProgress.faltan[0]!.actionLine).toEqual({ kind: "crit", text: SWAYP_HOY_FALTA_ENTREGA });
    const noVino = {
      manifest: { ...open.manifest, state: "cancelled", cancelled_at: "2026-11-04T13:00:00Z", cancellation_reason: "Swayp no vino" },
      items: open.items.map((row) => ({ ...row, removed_at: "2026-11-04T13:00:00Z", removal_reason: "Ruta cancelada: Swayp no vino" })),
    };
    const quiet = buildWarehouseSwayp({ ...swaypInput([armed, loaded]), handover: noVino, canHandover: true }, now).hoy!;
    expect(quiet.note).toBe(SWAYP_ENTREGA_NO_VINO(2));
    expect(quiet.faltan[0]!.actionLine).toBeNull();
  });

  it("cerrada: la nota es el resumen, la armada dice quién la entregó y la falta, por qué no salió", () => {
    const handover = {
      manifest: { id: "m1", state: "in_custody", received_by: "Juan Pérez", custody_completed_at: "2026-11-04T12:10:00Z", cancelled_at: null, cancellation_reason: null },
      items: [
        { shipment_id: "sh-KP1-S01", office_checked_at: "2026-11-04T12:04:00Z", office_checked_by: "u-almacen-a", removed_at: null, removed_by: null, removal_reason: null },
        { shipment_id: "sh-KP2-S02", office_checked_at: null, office_checked_by: null, removed_at: "2026-11-04T12:06:00Z", removed_by: "u-almacen-a", removal_reason: "No sale: La caja salió con otro courier. La caja salió como KP2-S01 con Grupo GF." },
      ],
    };
    const data = buildWarehouseSwayp({ ...swaypInput([armed, loaded]), handover, canHandover: true }, now);
    const hoy = data.hoy!;
    expect(data.canHandover).toBe(true);
    expect(hoy.note).toBe("Entrega cerrada · recogió Juan Pérez (Swayp) · 1 caja · 07:10 · 1 no salió");
    expect(hoy.armadas[0]!.handoverLine).toEqual({ kind: "ok", text: "Entregada a Swayp 07:04 · escaneó Almacén A" });
    expect(hoy.faltan[0]!.actionLine).toEqual({
      kind: "crit",
      text: `No salió: La caja salió con otro courier. La caja salió como KP2-S01 con Grupo GF. ${SWAYP_ALERT_NO_SALIO_EN_REPARTO}`,
    });
    // «Próximo» no cambia con la entrega de hoy.
    expect(data.proximo.entrega).toBeNull();
  });
});
