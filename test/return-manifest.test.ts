// Manifiesto de devolución (0307; owner 04-11-2026): plazos, clasificación del
// escaneo, paneles, totales, el acta sin datos de clientes, el anulado en la
// tienda que va a inventario y el cuaderno que no pisa una caja que llegó sin
// reporte.

import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  appearedLabel,
  bucketReturnManifest,
  buildReturnManifestActa,
  classifyManifestScan,
  drawerLineLabel,
  expectedBucket,
  laterPhysicalReceipt,
  lineResultLabel,
  notebookOfficeConflictMessage,
  pendingAtCloseFor,
  receivedLineMessage,
  REPROGRAMADO_KEEP_DAYS,
  returnAgeDays,
  returnCadenceFor,
  returnManifestCounter,
  returnManifestTotals,
  riderReturnCadenceDays,
  type ExpectedReturn,
  type ManifestScanFacts,
  type ReturnManifestLine,
} from "@/lib/return-manifest";
import { buildReturnManifestActaPdf, buildReturnManifestActaWorkbook, actaFilename } from "@/lib/exports/return-manifest-acta";
import { gfOfficeReceiptNotice, storeCancelledReceivedMessage, storeCancelledReceivedNotice } from "@/lib/gf-office-receipt";
import { officeReturnOutcome } from "@/lib/gf-replaced-output";
import { pickDispatchScanTarget } from "@/lib/dispatch";
import { buildNotebookPlan, type NotebookContext, type NotebookLine } from "@/lib/notebook-import";

describe("plazos por motorizado (owner, 04-11-2026)", () => {
  it("Alexis 3 días; Johnny (Yhoni), Roy y Yordani 1; Duglas 1 mientras no se defina; Urpi 14", () => {
    expect(riderReturnCadenceDays("Alexis")).toBe(3);
    expect(riderReturnCadenceDays("ALEXIS Prueba")).toBe(3);
    for (const name of ["Johnny", "Yhoni", "Roy", "Yordani", "Duglas", "Douglas"]) expect(riderReturnCadenceDays(name)).toBe(1);
    expect(riderReturnCadenceDays("Alguien Nuevo")).toBe(1);
    expect(riderReturnCadenceDays(null)).toBe(1);
    expect(returnCadenceFor("urpi", null)).toBe(14);
    expect(returnCadenceFor("propio", "Alexis")).toBe(3);
  });

  it("la edad se mide desde el día de ruta de la caja hasta el día de llegada", () => {
    expect(returnAgeDays("2026-11-01", "2026-11-04")).toBe(3);
    expect(returnAgeDays("2026-10-31", "2026-11-01")).toBe(1);
    expect(returnAgeDays("2026-11-04", "2026-11-04")).toBe(0);
  });

  it("dentro del plazo «con el motorizado»; después, «falta»", () => {
    const at = (routeDate: string, cadenceDays: number, outcomeReason: string | null = "no_contesta") =>
      expectedBucket({ routeDate, outcomeReason, arrivedOn: "2026-11-04", cadenceDays });
    expect(at("2026-11-01", 3)).toBe("con_el_motorizado");
    expect(at("2026-10-31", 3)).toBe("falta");
    expect(at("2026-11-03", 1)).toBe("con_el_motorizado");
    expect(at("2026-11-02", 1)).toBe("falta");
  });

  it("un reprogramado sigue con él hasta 14 días; con más de 14, falta", () => {
    expect(REPROGRAMADO_KEEP_DAYS).toBe(14);
    const repro = (routeDate: string) => expectedBucket({ routeDate, outcomeReason: "reprogramado", arrivedOn: "2026-11-04", cadenceDays: 3 });
    expect(repro("2026-10-21")).toBe("reprogramado");
    expect(repro("2026-10-20")).toBe("falta");
    // El plazo del motorizado no lo acorta: 10 días con Alexis sigue con él.
    expect(repro("2026-10-25")).toBe("reprogramado");
  });
});

const facts = (over: Partial<ManifestScanFacts> = {}, stop: Partial<NonNullable<NonNullable<ManifestScanFacts["box"]>["stop"]>> | null = {}): ManifestScanFacts => ({
  label: "KP1-S01",
  headerRiderId: "alexis",
  courier: "propio",
  box: {
    itemId: "item", manifestId: "box", riderId: "alexis", riderName: "Alexis", routeDate: "2026-10-26",
    stop: stop === null ? null : { id: "stop", status: "no_entregado", outcomeReason: "no_contesta", routeId: "route", routeStatus: "en_curso", ...stop },
  },
  custodyState: "courier",
  receivedInOffice: false,
  replaced: false,
  ...over,
});

describe("clasificar el escaneo (con gfReturnDecision)", () => {
  it("un «No entregado» de su caja se recibe", () => {
    expect(classifyManifestScan(facts())).toEqual({ kind: "recibir", otraCaja: false });
  });

  it("de la caja de otro motorizado: se recibe y se marca «de otra caja»", () => {
    expect(classifyManifestScan(facts({ headerRiderId: "roy" }))).toEqual({ kind: "recibir", otraCaja: true });
  });

  it("la reemplazada en la caja se recibe (va a stock en la base)", () => {
    expect(classifyManifestScan(facts({ replaced: true, custodyState: "retorno" }))).toEqual({ kind: "recibir", otraCaja: false });
  });

  it("regla 4: parada pendiente con la ruta en curso → se reporta «No entregado» y se recibe", () => {
    expect(classifyManifestScan(facts({}, { status: "pendiente", outcomeReason: null }))).toEqual({
      kind: "reportar_y_recibir", otraCaja: false, stopId: "stop", routeId: "route",
    });
  });

  it("parada pendiente con la ruta cerrada: observación «sin reporte», no se recibe", () => {
    const plan = classifyManifestScan(facts({}, { status: "pendiente", routeStatus: "cerrada" }));
    expect(plan).toMatchObject({ kind: "anotar", outcome: "held", flags: ["sin_reporte"] });
    expect(plan.message).toContain("ya no está en curso");
  });

  it("caja sin parada: observación «sin reporte»", () => {
    expect(classifyManifestScan(facts({}, null))).toMatchObject({ kind: "anotar", outcome: "held", flags: ["sin_reporte"] });
  });

  it("reportada entregada: incidencia, no se recibe", () => {
    const plan = classifyManifestScan(facts({}, { status: "entregado" }));
    expect(plan).toMatchObject({ kind: "anotar", outcome: "held", flags: ["reportada_entregada"] });
    expect(plan.message).toContain("Es una incidencia: no se recibe");
  });

  it("ya recibida (fuera de la caja, en la empresa): informativa", () => {
    const plan = classifyManifestScan(facts({ box: null, custodyState: "empresa", receivedInOffice: true }));
    expect(plan).toMatchObject({ kind: "anotar", outcome: "info", flags: ["ya_recibida"] });
  });

  it("anulado en la tienda ya recibido y a inventario, escaneado otra vez: informativa «ya recibida», no bloquea el cierre", () => {
    const plan = classifyManifestScan(facts({ box: null, custodyState: "devuelto", receivedInOffice: false, saleEnded: true }));
    expect(plan).toMatchObject({ kind: "anotar", outcome: "info", flags: ["ya_recibida"] });
    expect(plan.message).toContain("fue a inventario");
    // Sin la venta terminada, devuelto y sin caja sigue sin adivinarse.
    expect(classifyManifestScan(facts({ box: null, custodyState: "devuelto" }))).toMatchObject({ outcome: "held", flags: ["no_identificada"] });
  });

  it("fuera de caja y fuera de la oficina, u otro courier: no identificada, con nota", () => {
    expect(classifyManifestScan(facts({ box: null, custodyState: "courier" }))).toMatchObject({ kind: "anotar", outcome: "held", flags: ["no_identificada"] });
    const other = classifyManifestScan(facts({ courier: "tanders", box: null }));
    expect(other).toMatchObject({ kind: "anotar", outcome: "held", flags: ["no_identificada"] });
    expect(other.message).toContain("no es de Grupo GF");
  });

  it("nunca por número de pedido con dos cajas de Grupo GF: el buscador no elige", () => {
    const box = (id: string) => ({ id, courier: "propio", custody_state: "courier", preparation_state: "listo_despacho", output_code: `KP1-S0${id}`, guide_code: `G${id}` });
    expect(pickDispatchScanTarget([box("1"), box("2")], (c) => c.courier === "propio").kind).toBe("ambigua");
  });
});

const line = (over: Partial<ReturnManifestLine> = {}): ReturnManifestLine => ({
  id: over.id ?? "l1", shipmentId: "s1", storeId: "store", orderId: "o1", orderName: "#KP1", outputCode: "KP1-S01",
  scannedCode: "KP1-S01", sourceRiderName: "Alexis", sourceRouteDate: "2026-10-26", reportedStatus: "no_entregado",
  reportedReason: "no_contesta", expected: true, outcome: "received", flags: [], receiptOutcome: "por_asignar",
  message: null, note: null, scanCount: 1, scannedAt: "2026-11-04T15:00:00Z", removedAt: null, removalReason: null, ...over,
});

const expected = (over: Partial<ExpectedReturn> = {}): ExpectedReturn => ({
  shipmentId: "s1", storeId: "store", itemId: "i1", manifestId: "m1", routeDate: "2026-10-26", stopId: "st1",
  outcomeReason: "no_contesta", orderId: "o1", orderName: "#KP1", outputCode: "KP1-S01", ...over,
});

describe("los tres paneles", () => {
  const exp = [
    expected(),
    expected({ shipmentId: "s2", routeDate: "2026-11-03", orderName: "#KP2" }),
    expected({ shipmentId: "s3", routeDate: "2026-10-26", outcomeReason: "reprogramado", orderName: "#KP3" }),
    expected({ shipmentId: "s4", routeDate: "2026-10-20", outcomeReason: "reprogramado", orderName: "#KP4" }),
    // Sellado por el courier (`returned_at`): no prueba que llegó; sigue esperado.
    expected({ shipmentId: "s5", routeDate: "2026-10-30", returnedAt: "2026-10-31T00:00:00Z", orderName: "#KP5" }),
  ];
  const lines = [
    line(),
    line({ id: "l2", shipmentId: "s9", expected: false, flags: ["otra_caja"], sourceRiderName: "Roy" }),
    line({ id: "l3", shipmentId: "s10", expected: false, outcome: "held", flags: ["reportada_entregada"], receiptOutcome: null }),
    line({ id: "l4", shipmentId: null, expected: false, outcome: "held", flags: ["no_identificada"], receiptOutcome: null, note: "bolsa" }),
    line({ id: "l5", shipmentId: "s11", expected: false, outcome: "info", flags: ["ya_recibida"], receiptOutcome: null, removedAt: "2026-11-04T16:00:00Z", removalReason: "escaneo repetido" }),
    line({ id: "l6", shipmentId: "s12", expected: false, flags: ["sin_reporte"], receiptOutcome: "a_inventario_anulado" }),
  ];
  const buckets = bucketReturnManifest({ state: "open", expected: exp, lines, arrivedOn: "2026-11-04", cadenceDays: 3 });

  it("llegó / esperado y no llegó por plazo / llegó sin esperarse / descartadas", () => {
    expect(buckets.llego.map((l) => l.id)).toEqual(["l1"]);
    expect(buckets.noLlego.falta.map((r) => r.shipmentId)).toEqual(["s4", "s5"]);
    expect(buckets.noLlego.conElMotorizado.map((r) => r.shipmentId)).toEqual(["s2"]);
    expect(buckets.noLlego.reprogramado.map((r) => r.shipmentId)).toEqual(["s3"]);
    expect(buckets.sinEsperarse.map((l) => l.id).sort()).toEqual(["l2", "l3", "l4", "l6"]);
    expect(buckets.descartadas.map((l) => l.id)).toEqual(["l5"]);
  });

  it("totales: llegaron, recibidos, a inventario, con observación, faltan y declaró", () => {
    const totals = returnManifestTotals(buckets, 7);
    expect(totals).toMatchObject({
      arrived: 5, received: 3, requeued: 2, toInventory: 1, toStock: 0, withObservation: 2, info: 0,
      missing: 2, expectedTotal: 5, expectedReceived: 1, declared: 7, declaredGap: 2,
    });
    expect(returnManifestCounter(totals)).toBe("Recibidos 1 de 5 esperados · 4 sin esperarse · declaró 7");
    expect(returnManifestTotals(buckets, null).declaredGap).toBeNull();
  });

  it("cerrado: lo que faltó es lo que anotó el cierre; lo esperado en vivo no cuenta", () => {
    const closed = bucketReturnManifest({
      state: "closed",
      expected: exp,
      lines: [line(), line({ id: "m", shipmentId: "s4", outcome: "missing", flags: ["reprogramado"], receiptOutcome: null, reportedReason: "reprogramado", sourceRouteDate: "2026-10-20" })],
      arrivedOn: "2026-11-04",
      cadenceDays: 3,
    });
    expect(closed.noLlego.falta.map((r) => r.shipmentId)).toEqual(["s4"]);
    expect(closed.noLlego.conElMotorizado).toEqual([]);
    expect(closed.sinEsperarse).toEqual([]);
  });

  it("«esperados» no cambia al cerrar: lo que seguía en plazo queda contado (pending_at_close), por tienda", () => {
    const lines = [line(), line({ id: "m", shipmentId: "s4", outcome: "missing", receiptOutcome: null, sourceRouteDate: "2026-10-20" })];
    const open = bucketReturnManifest({ state: "open", expected: exp, lines: [lines[0]!], arrivedOn: "2026-11-04", cadenceDays: 3 });
    const openTotals = returnManifestTotals(open, null);
    // Lo que el cierre congela es lo que estaba en plazo y no llegó.
    const frozen = pendingAtCloseFor(
      { store: { con_el_motorizado: open.pending.conElMotorizado, reprogramado: open.pending.reprogramado }, otra: { con_el_motorizado: 4, reprogramado: 0 } },
      new Set(["store"]),
    );
    expect(frozen.hidden).toBe(4);
    const closed = bucketReturnManifest({ state: "closed", expected: [], lines, arrivedOn: "2026-11-04", cadenceDays: 3, pendingAtClose: frozen.visible });
    const closedTotals = returnManifestTotals(closed, null);
    expect(closedTotals.withRider).toBe(openTotals.withRider);
    expect(closed.pending).toEqual(open.pending);
    // Abierto con s4 ya fuera de plazo; cerrado como su línea «missing»: misma cifra.
    expect(closedTotals.expectedTotal).toBe(openTotals.expectedTotal - openTotals.missing + closedTotals.missing);
    // Sin nada congelado (cerrado antes de la 0307 completa), cero; nunca negativo.
    expect(pendingAtCloseFor(null, new Set(["store"])).visible).toEqual({ conElMotorizado: 0, reprogramado: 0 });
    expect(pendingAtCloseFor({ store: { con_el_motorizado: -3 } }, new Set(["store"])).visible.conElMotorizado).toBe(0);
  });
});

describe("después del cierre, en vivo", () => {
  const events = [
    // Toma del sistema (urpi_take_gf_output): sin actor, no es una llegada.
    { shipmentId: "s4", kind: "returned_to_office", actor: null, source: "dispatch", occurredAt: "2026-11-05T12:00:00Z" },
    // Sello del courier: no es recepción humana.
    { shipmentId: "s4", kind: "return_received", actor: "x", source: "aliclik_api", occurredAt: "2026-11-05T13:00:00Z" },
    { shipmentId: "s4", kind: "returned_to_office", actor: "persona", source: "dispatch", occurredAt: "2026-11-06T15:00:00Z" },
  ];
  it("una que faltó y llegó después: «apareció el dd/mm»; ni la toma sin actor ni el sello cuentan", () => {
    const hit = laterPhysicalReceipt("s4", "2026-11-04T20:00:00Z", events);
    expect(hit?.occurredAt).toBe("2026-11-06T15:00:00Z");
    expect(appearedLabel(hit)).toBe("apareció el 06/11");
    expect(laterPhysicalReceipt("s4", "2026-11-04T20:00:00Z", events.slice(0, 2))).toBeNull();
    expect(appearedLabel(null)).toBeNull();
  });

  it("el drawer: «Recibida en …», «Faltó en …», «Incidencia en …»", () => {
    const m = "Devolución · Alexis · 04/11";
    expect(drawerLineLabel({ outcome: "received", flags: [], manifestLabel: m })).toBe("Recibida en Devolución · Alexis · 04/11");
    expect(drawerLineLabel({ outcome: "missing", flags: [], manifestLabel: m })).toBe("Faltó en Devolución · Alexis · 04/11");
    expect(drawerLineLabel({ outcome: "held", flags: ["reportada_entregada"], manifestLabel: m })).toContain("Incidencia en");
  });
});

describe("pedido anulado en la tienda: a inventario (owner, 04-11-2026)", () => {
  it("lo que hizo la base: devuelto + venta terminada → a inventario; reactivado → por asignar", () => {
    expect(officeReturnOutcome("devuelto", false, true)).toBe("a_inventario_anulado");
    expect(officeReturnOutcome("empresa", false, false)).toBe("por_asignar");
    expect(officeReturnOutcome("devuelto", true, true)).toBe("a_stock_reemplazada");
  });

  it("los avisos dicen inventario y nunca «por asignar»", () => {
    const one = gfOfficeReceiptNotice({ label: "KP1-S01", outcome: "a_inventario_anulado", riderName: "Alexis", routeDate: "2026-10-26", cancelledNotice: "#KP1 está ANULADO en la tienda: no sale.", reproParts: ["Repro Lima: programado"] });
    expect(one.error).toBeUndefined();
    expect(one.notice).toBe(storeCancelledReceivedMessage("KP1-S01", "Alexis", "2026-10-26"));
    expect(one.notice).toContain("va a inventario");
    expect(one.notice).not.toContain("Repro Lima");
    expect(storeCancelledReceivedNotice(2)).toContain("van a inventario");
    const line = receivedLineMessage({ label: "KP1-S01", receiptOutcome: "a_inventario_anulado", otraCaja: false, sinReporte: false, boxRiderName: "Alexis", boxRouteDate: "2026-10-26" });
    expect(line).toContain("anulado en la tienda, va a inventario");
    expect(line).toContain("no vuelve a «por asignar»");
  });

  it("anulado solo en Kapta: vuelve a «por asignar» y se avisa como antes", () => {
    const res = gfOfficeReceiptNotice({ label: "KP1-S01", outcome: "por_asignar", riderName: "Alexis", routeDate: "2026-10-26", cancelledNotice: "#KP1 está ANULADO: no sale.", reproParts: [] });
    expect(res.error).toBe("KP1-S01 recibido en oficina. #KP1 está ANULADO: no sale.");
  });

  it("0307: la recepción de siempre manda el anulado en la tienda a stock, con la misma firma y permisos", () => {
    const sql = readFileSync("db/migrations/0307_return_manifests.sql", "utf8");
    const fn = sql.slice(sql.indexOf("create or replace function public.gf_return_to_office("), sql.indexOf("revoke all on function public.gf_return_to_office"));
    expect(fn).toContain("create or replace function public.gf_return_to_office(p_item_id uuid, p_actor uuid)");
    expect(fn).toContain("v_store_cancelled := exists(select 1 from orders where id = v_shipment.order_id and cancelled_at is not null);");
    expect(fn).toContain("or v_woo_ended or v_store_cancelled then");
    expect(fn).toContain("set custody_state = 'devuelto', returned_at = coalesce(returned_at, now()),");
    expect(fn).toContain("'Pedido anulado en la tienda: recibido en oficina, va a inventario (' || v_rider || ')'");
    expect(fn).toContain("el pedido está anulado en la tienda. Va a inventario —Almacén decide stock o merma—; no vuelve a «por asignar».");
    expect(sql).toContain("grant execute on function public.gf_return_to_office(uuid, uuid) to service_role;");
    expect(sql).toContain("revoke all on function public.gf_return_to_office(uuid, uuid) from public, anon, authenticated;");
    // Urpi no toma la caja de un anulado en la tienda.
    expect(sql).toContain("if exists (select 1 from orders where id = v_ship.order_id and cancelled_at is not null) then return 'anulado_en_tienda'; end if;");
  });

  it("0307: tablas por organización, RLS de solo lectura y cada función cerrada al público", () => {
    const sql = readFileSync("db/migrations/0307_return_manifests.sql", "utf8");
    expect(sql).toContain("org_id uuid not null references organizations(id) on delete restrict,");
    expect(sql).not.toMatch(/references orgs\b/);
    expect(sql).toContain("using (store_id in (select auth_store_ids()) or (store_id is null and org_id in (select auth_org_ids())));");
    expect(sql).not.toMatch(/create policy \w+ on public\.return_manifest\w* for (insert|update|delete|all)/);
    for (const fn of ["return_manifest_open(uuid, text, uuid, uuid, date, integer)", "return_manifest_receive(uuid, uuid, uuid, text, text[], text)",
      "return_manifest_note(uuid, uuid, text, text, text[], uuid, uuid, text, text)", "return_manifest_close(uuid, uuid, text)",
      "return_manifest_cancel(uuid, uuid, text)", "return_manifest_expected(uuid, uuid)", "return_manifest_lock_open(uuid, uuid)"]) {
      expect(sql).toContain(`revoke all on function public.${fn} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${fn} to service_role;`);
    }
    // Orden de candados: cabecera y después la recepción de siempre (ítem, caja).
    const receive = sql.slice(sql.indexOf("create or replace function public.return_manifest_receive("));
    expect(receive.indexOf("v_header := return_manifest_lock_open(p_manifest_id, p_actor);")).toBeLessThan(receive.indexOf("v_order := gf_return_to_office(p_item_id, p_actor);"));
    // Al cerrar: falta lo esperado fuera de plazo; reprogramado, más de 14 días.
    expect(sql).toContain("where (v_header.arrived_on - e.route_date) > case when e.outcome_reason = 'reprogramado' then 14 else v_header.cadence_days end");
  });
});

describe("el acta: PDF y Excel, sin datos de clientes", () => {
  const withPii = (l: ReturnManifestLine) => ({ ...l, customerName: "Rosa Díaz", customerPhone: "51999888777", address: "Av. Siempre Viva 123" }) as ReturnManifestLine;
  const buckets = bucketReturnManifest({
    state: "closed",
    expected: [],
    lines: [
      withPii(line()),
      withPii(line({ id: "l2", shipmentId: "s2", orderName: "#KP2", outputCode: "KP2-S01", expected: false, flags: ["otra_caja"], receiptOutcome: "a_inventario_anulado" })),
      withPii(line({ id: "m", shipmentId: "s3", orderName: "#KP3", outputCode: "KP3-S01", outcome: "missing", receiptOutcome: null, sourceRouteDate: "2026-10-20" })),
    ],
    arrivedOn: "2026-11-04",
    cadenceDays: 3,
  });
  const acta = buildReturnManifestActa({
    header: {
      label: "Devolución · Alexis · 04/11", courierLabel: "Grupo GF", riderFirstName: "Alexis", arrivedOn: "2026-11-04",
      handedOverBy: "Alexis", receivedBy: "Yelitza", openedAt: "2026-11-04T14:00:00Z", closedAt: "2026-11-04T16:00:00Z",
      state: "closed", declaredCount: 3, note: null,
    },
    buckets,
  });

  it("una fila por caja: #pedido, salida, día de la caja, reportado y resultado; firmas «Entregó» y «Recibió»", () => {
    expect(acta.rows).toEqual([
      { n: 1, orderName: "#KP1", outputCode: "KP1-S01", boxDay: "26/10", reported: "No entregado · No contesta", result: "Recibido · vuelve a por asignar" },
      { n: 2, orderName: "#KP2", outputCode: "KP2-S01", boxDay: "26/10", reported: "No entregado · No contesta", result: "Recibido · a inventario (anulado) · De otra caja" },
      { n: 3, orderName: "#KP3", outputCode: "KP3-S01", boxDay: "20/10", reported: "No entregado · No contesta", result: "Falta" },
    ]);
    expect(acta.signatures).toEqual(["Entregó", "Recibió"]);
    expect(acta.totals).toMatchObject({ arrived: 2, received: 2, toInventory: 1, missing: 1, declared: 3, declaredGap: 1 });
    const text = JSON.stringify(acta);
    for (const pii of ["Rosa", "51999888777", "Siempre Viva"]) expect(text).not.toContain(pii);
    expect(lineResultLabel({ outcome: "missing", flags: ["reprogramado"], receiptOutcome: null })).toBe("Falta (reprogramado más de 14 días)");
  });

  it("el Excel lleva la tabla y los totales, y nada del cliente", async () => {
    const buf = await buildReturnManifestActaWorkbook(acta);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const cells: string[] = [];
    wb.worksheets[0]!.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value))));
    expect(cells).toContain("#KP1");
    expect(cells).toContain("KP3-S01");
    expect(cells).toContain("Falta");
    expect(cells).toContain("Entregó");
    for (const pii of ["Rosa", "51999888777", "Siempre Viva"]) expect(cells.join(" ")).not.toContain(pii);
  });

  it("el PDF se genera y el nombre del archivo no lleva acentos", async () => {
    const pdf = await buildReturnManifestActaPdf(acta);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    expect(actaFilename(acta, "pdf")).toBe("acta-devolucion-alexis-04-11.pdf");
  });
});

describe("el cuaderno no pisa una caja que llegó a la oficina sin reporte (regla 4)", () => {
  const nl = (over: Partial<NotebookLine>): NotebookLine => ({ item: 1, store: null, customer: null, district: null, written: null, amount: null, fee: null, order: null, notes: null, ...over });
  const ctx = (officeArrival: boolean): NotebookContext => ({
    routeDate: "2026-10-26",
    riderName: "Alexis",
    stops: [{
      stopId: "s1", orderId: "o1", orderName: "#KP138910", customerName: null, status: "no_entregado",
      reportedLabel: "No entregado · Otro (ver nota)", total: 189, remaining: 189,
      officeArrival: officeArrival ? { manifestLabel: "Devolución · Alexis · 04/11", arrivedOn: "2026-11-04" } : null,
    }],
    carry: [],
    elsewhere: new Map(),
  });

  it("la hoja dice «entregado»: incidencia a la vista, no se carga", () => {
    const row = buildNotebookPlan([nl({ order: "#KP138910", written: "EFECTIVO", amount: 189 })], ctx(true)).rows[0]!;
    expect(row.action).toBe("omitir");
    expect(row.incident).toBe(notebookOfficeConflictMessage({ manifestLabel: "Devolución · Alexis · 04/11", arrivedOn: "2026-11-04" }));
    expect(row.warnings[0]).toContain("Incidencia: el cuaderno dice Entregado");
  });

  it("sin manifiesto, o si la hoja dice «no entregado», es una ya reportada como siempre", () => {
    expect(buildNotebookPlan([nl({ order: "#KP138910", written: "EFECTIVO", amount: 189 })], ctx(false)).rows[0]!.incident).toBeUndefined();
    expect(buildNotebookPlan([nl({ order: "#KP138910", written: "NO CONTESTO", amount: 0 })], ctx(true)).rows[0]!.incident).toBeUndefined();
  });

  it("al aplicar, la fila queda fallida con la incidencia aunque se omita", () => {
    const apply = readFileSync("lib/notebook-apply.ts", "utf8");
    const loop = apply.slice(apply.indexOf("for (const decision of decisions) {"));
    expect(loop.indexOf("if (conflict) { fail(r, decision.index, conflict); continue; }")).toBeGreaterThan(0);
    expect(loop.indexOf("if (conflict) { fail(r, decision.index, conflict); continue; }")).toBeLessThan(loop.indexOf('if (decision.action === "omitir") { skipped++; continue; }'));
    const access = readFileSync("lib/notebook-import-access.ts", "utf8");
    expect(access).toContain('.contains("flags", ["sin_reporte"])');
  });
});
