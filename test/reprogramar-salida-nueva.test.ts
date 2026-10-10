// La salida nueva nace al reprogramar e imprimir, y Grupo GF la rellena
// (09-10-2026, decisión del owner; MOM §28, §29.13, §9.3).
//
// EL CASO. #AUR177756: Tanders no entregó su S01 y la caja volvió. Al
// reprogramar por llamada se reimprimió el rótulo de Tanders —«Descargar
// rótulos» respondía «Tiene 1 salida todavía en la calle»—, se armó la caja con
// él, y Grupo GF creó al tomarlo una S02 cuyo rótulo nadie imprimió. En
// «Verificar caja» el QR de la caja era el de la S01 y no cuadraba.
//
// LA REGLA, en tres partes:
//   1. Una salida que su courier ya dio por no entregada no está «en la calle»:
//      pedir el rótulo crea la salida nueva «por definir» con motivo automático.
//   2. Grupo GF RELLENA esa «por definir» (mismo QR) en vez de crear otra; la
//      del courier que falló sigue sin rellenarse nunca.
//   3. No se reimprime el rótulo de la que falló: el de la nueva va encima, y el
//      escáner que lee el viejo nombra la salida con la que sale. Sin alias.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decideLabelAction,
  isActiveOutput,
  isWithCompany,
  reprogramLabelState,
  type OutputForDecision,
} from "@/lib/labels/resolve-output";
import { newOutputLabelNotice, reprogramOutputReason, retryAdditionalReason } from "@/lib/gf-retry";
import { oldLabelHint, oldLabelMessage, previousLabelNote } from "@/lib/scan-other-box";
import { pickCombinadaOutputs } from "@/lib/labels/guia-combinada-select";
import { MANUAL_ROUTE_CREATED_VIA } from "@/lib/shipment-output";

const state = vi.hoisted(() => ({
  order: {} as Record<string, unknown>,
  outputs: [] as Record<string, unknown>[],
  writes: [] as { table: string; op: string; value: any; filters: Record<string, unknown> }[],
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "manager" }), getAdminOrgs: async () => [{ org_id: "org" }], getAccessibleStores: async () => [] }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn() }));
vi.mock("@/lib/grupo-gf-courier-route-access", () => ({
  loadGroupGfCourierRouteCheck: async () => ({ eligible: true, providerId: "gf", agreementId: "agreement", districtKey: "san juan de miraflores", tariffId: "tariff", tariffAmount: 12, currency: "PEN", sameDayCutoff: "11:30" }),
  riderPickupMode: vi.fn(),
}));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    let op = "read";
    let value: any;
    const filters: Record<string, unknown> = {};
    const q: any = {};
    for (const method of ["select", "in", "limit", "is", "order", "neq"]) q[method] = () => q;
    q.eq = (key: string, val: unknown) => { filters[key] = val; return q; };
    for (const method of ["insert", "update", "delete"]) q[method] = (val: unknown) => { op = method; value = val; return q; };
    const result = () => {
      if (op !== "read") {
        state.writes.push({ table, op, value, filters: { ...filters } });
        return { data: table === "shipments" ? { id: value?.id ?? filters.id, output_code: filters.id === "s02" ? "AUR177756-S02" : "AUR177756-S03" } : { id: value?.id ?? "request" }, error: null };
      }
      const data = table === "logistics_providers" ? { id: "gf" }
        : table === "order_master" ? state.order
        : table === "shipments" ? state.outputs
        : table === "orders" ? { line_items: [] } : null;
      return { data, error: null };
    };
    q.maybeSingle = q.single = async () => result();
    q.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
    return q;
  };
  return { createAdminSupabase: () => ({ from }), createServerSupabase: async () => ({ from }) };
});

import { takeGroupGfCourierOrders } from "@/app/dashboard/courier/actions";

// ---------------------------------------------------------------------------
// Salidas de prueba: la S01 de Tanders que no entregó y la S02 «por definir»
// ---------------------------------------------------------------------------

function out(over: Partial<OutputForDecision> & { id: string }): OutputForDecision {
  return {
    custody_state: "empresa",
    delivery_status: "pendiente",
    created_at: "2026-10-08T15:00:00Z",
    output_number: 1,
    courier: "por_definir",
    output_code: null,
    ...over,
  };
}

const tandersVuelve = out({
  id: "s01",
  courier: "tanders",
  output_code: "AUR177756-S01",
  delivery_status: "en_ruta",
  custody_state: "retorno",
  reported_status: "RETURNING",
  dispatched_at: "2026-10-06T14:00:00Z",
  created_at: "2026-10-05T15:00:00Z",
  output_number: 1,
});
const swaypDevolucion = out({
  id: "s01",
  courier: "fenix",
  output_code: "KP135202-S01",
  delivery_status: "en_ruta",
  custody_state: "retorno",
  swayp_state: 8,
  dispatched_at: "2026-10-06T14:00:00Z",
  created_at: "2026-10-05T15:00:00Z",
});
const s02PorDefinir = out({ id: "s02", output_code: "AUR177756-S02", output_number: 2, created_at: "2026-10-09T15:00:00Z" });

const LIMA = { lima: true };

describe("regla 1: en Lima, la salida que su courier no entregó no está «en la calle»", () => {
  it("Tanders RETURNING: en Lima no cuenta como activa; en ningún sitio como «en la empresa»", () => {
    expect(isActiveOutput(tandersVuelve, LIMA)).toBe(false);
    expect(isActiveOutput(tandersVuelve)).toBe(true);
    expect(isWithCompany({ ...tandersVuelve, custody_state: "empresa" })).toBe(false);
  });

  it("fuera de Lima no cambia: la Swayp en Devolución de provincia sigue en Reproprovincia (§11)", () => {
    expect(decideLabelAction([swaypDevolucion])).toEqual({ kind: "needs_justification", activeOutputs: 1 });
    expect(decideLabelAction([swaypDevolucion], { lima: false })).toEqual({ kind: "needs_justification", activeOutputs: 1 });
    // Una anulada, como antes: se crea, pero sin el motivo de la reprogramación de Lima.
    expect(decideLabelAction([{ ...swaypDevolucion, delivery_status: "anulado" }])).toEqual({ kind: "create" });
  });

  it("pedir el rótulo crea la salida nueva y dice qué salida no entregó (antes: «necesita justificación»)", () => {
    expect(decideLabelAction([tandersVuelve], LIMA)).toEqual({
      kind: "create",
      afterFailure: { shipmentId: "s01", outputCode: "AUR177756-S01", courier: "tanders", returned: false },
    });
  });

  it("Swayp en Devolución (8), igual", () => {
    expect(decideLabelAction([swaypDevolucion], LIMA)).toMatchObject({ kind: "create", afterFailure: { courier: "fenix", returned: false } });
  });

  it("anulada después de salir, igual; y si la caja ya se recibió, dice que volvió", () => {
    const anulada = { ...tandersVuelve, delivery_status: "anulado", reported_status: "CANCELLED" };
    expect(decideLabelAction([anulada], LIMA)).toMatchObject({ kind: "create", afterFailure: { shipmentId: "s01" } });
    const recibida = { ...tandersVuelve, custody_state: "devuelto", returned_at: "2026-10-08T16:00:00Z" };
    expect(decideLabelAction([recibida], LIMA)).toMatchObject({ kind: "create", afterFailure: { returned: true } });
    // La custodia `devuelto` sola también dice que volvió (filas sin `returned_at`).
    const devueltaSinFecha = { ...tandersVuelve, reported_status: "RETURNED", custody_state: "devuelto" };
    expect(decideLabelAction([devueltaSinFecha], LIMA)).toMatchObject({ kind: "create", afterFailure: { returned: true } });
  });

  it("una salida viva de verdad sigue pidiendo justificación (§23)", () => {
    const tandersEnReparto = { ...tandersVuelve, reported_status: "PICKED" };
    expect(decideLabelAction([tandersEnReparto], LIMA)).toEqual({ kind: "needs_justification", activeOutputs: 1 });
    const gfEnRuta = out({ id: "gf", courier: "propio", delivery_status: "en_ruta", custody_state: "courier" });
    expect(decideLabelAction([tandersVuelve, gfEnRuta], LIMA)).toEqual({ kind: "needs_justification", activeOutputs: 1 });
  });

  it("pulsar dos veces reimprime la S02, no crea una S03", () => {
    expect(decideLabelAction([tandersVuelve, s02PorDefinir], LIMA)).toEqual({ kind: "reuse", shipmentId: "s02" });
  });

  it("después de anular una «por definir», la nueva sigue llevando el motivo de la que falló", () => {
    const anuladaPorError = { ...s02PorDefinir, delivery_status: "anulado" };
    expect(decideLabelAction([tandersVuelve, anuladaPorError], LIMA)).toMatchObject({ kind: "create", afterFailure: { shipmentId: "s01" } });
  });

  it("solo se reimprime una salida viva: una entregada o «transferido» en custodia empresa no (#KP134300)", () => {
    const madreTransferida = out({ id: "s01", courier: "fenix", output_code: "KP134300-S01", delivery_status: "transferido", custody_state: "empresa", created_at: "2026-09-20T15:00:00Z" });
    const hijaDevuelta = out({ id: "s02", courier: "fenix", output_code: "KP134300-S02", delivery_status: "anulado", custody_state: "retorno", swayp_state: 9, dispatched_at: "2026-09-25T14:00:00Z", created_at: "2026-09-24T15:00:00Z", output_number: 2 });
    expect(isWithCompany(madreTransferida)).toBe(false);
    expect(isWithCompany({ ...madreTransferida, delivery_status: "entregado" })).toBe(false);
    expect(decideLabelAction([madreTransferida, hijaDevuelta], LIMA)).toMatchObject({ kind: "create", afterFailure: { shipmentId: "s02" } });
  });

  it("sin ninguna que fallara, crear no lleva motivo", () => {
    expect(decideLabelAction([out({ id: "a", custody_state: "devuelto" })], LIMA)).toEqual({ kind: "create" });
  });
});

describe("el motivo automático", () => {
  it("dice quién no entregó, cuál, y si la caja vuelve o ya volvió", () => {
    expect(reprogramOutputReason({ courier: "tanders", returned: false, outputCode: "AUR177756-S01" })).toBe(
      "Tanders no entregó AUR177756-S01 y su caja todavía vuelve: se reprograma con una salida nueva y su propio rótulo, que se pega sobre la caja.",
    );
    expect(reprogramOutputReason({ courier: "fenix", returned: true, outputCode: null })).toBe(
      "Swayp no entregó y su caja ya volvió: se reprograma con una salida nueva y su propio rótulo, que se pega sobre la caja.",
    );
  });

  it("el de la toma ya no afirma que la caja «todavía vuelve» cuando volvió", () => {
    expect(retryAdditionalReason({ courier: "tanders", returned: true })).toContain("su caja ya volvió");
    expect(retryAdditionalReason({ courier: "tanders", returned: false })).toContain("su caja todavía vuelve");
  });
});

describe("la ficha: con qué sale la caja", () => {
  it("sin salida nueva, ofrece imprimirla; con ella, la nombra", () => {
    expect(reprogramLabelState([tandersVuelve])).toEqual({
      failed: { shipmentId: "s01", outputCode: "AUR177756-S01", courier: "tanders", returned: false },
      live: null,
      open: null,
    });
    expect(reprogramLabelState([tandersVuelve, s02PorDefinir])?.live).toEqual({ shipmentId: "s02", outputCode: "AUR177756-S02" });
    // #AUR177756 hoy: la S02 ya es de Grupo GF y salió.
    const s02Gf = { ...s02PorDefinir, courier: "propio", custody_state: "courier", delivery_status: "en_ruta" };
    expect(reprogramLabelState([tandersVuelve, s02Gf])?.live?.outputCode).toBe("AUR177756-S02");
  });

  it("«nacida después» se lee por fecha y, en filas sin fecha, por consecutivo", () => {
    // Filas antiguas sin consecutivo: manda la fecha.
    const sinNumero = { ...s02PorDefinir, output_number: null };
    const fallidaSinNumero = { ...tandersVuelve, output_number: null };
    expect(reprogramLabelState([fallidaSinNumero, sinNumero])?.live?.shipmentId).toBe("s02");
    // Sin fecha: manda el consecutivo.
    const sinFecha = { ...s02PorDefinir, created_at: null };
    const fallidaSinFecha = { ...tandersVuelve, created_at: null };
    expect(reprogramLabelState([fallidaSinFecha, sinFecha])?.live?.shipmentId).toBe("s02");
    expect(reprogramLabelState([{ ...fallidaSinFecha, output_number: 3 }, sinFecha])?.live).toBeNull();
  });

  it("una salida viva ANTERIOR a la que falló no es la caja que volvió (#KP134960)", () => {
    const gfViejaAbierta = out({ id: "s01", courier: "propio", output_code: "KP134960-S01", custody_state: "courier", created_at: "2026-09-17T15:00:00Z" });
    const tandersVolvio = { ...tandersVuelve, id: "s02", output_code: "KP134960-S02", output_number: 2, delivery_status: "anulado", reported_status: "RETURNED", custody_state: "devuelto", created_at: "2026-09-24T15:00:00Z" };
    expect(reprogramLabelState([gfViejaAbierta, tandersVolvio])?.live).toBeNull();
    // La ficha la nombra como abierta y no ofrece imprimir: el clic fallaría.
    expect(reprogramLabelState([gfViejaAbierta, tandersVolvio])?.open).toEqual({ shipmentId: "s01", outputCode: "KP134960-S01" });
    // Y pedir el rótulo responde que hay una todavía en la calle, no crea.
    expect(decideLabelAction([gfViejaAbierta, tandersVolvio], LIMA)).toEqual({ kind: "needs_justification", activeOutputs: 1 });
  });

  it("una entregada o anulada no es la caja viva; sin ninguna que fallara, nada", () => {
    expect(reprogramLabelState([tandersVuelve, { ...s02PorDefinir, delivery_status: "anulado" }])?.live).toBeNull();
    expect(reprogramLabelState([s02PorDefinir])).toBeNull();
  });
});

describe("regla 3: el rótulo viejo nombra la salida con la que sale, sin alias", () => {
  it("«Verificar caja»: la S02 está en esta caja", () => {
    expect(oldLabelHint("s01", [tandersVuelve, s02PorDefinir], "caja", { inThisBox: new Set(["s02"]) })).toBe(
      "Es el rótulo viejo de AUR177756-S01 (Tanders no entregó). En esta caja va como AUR177756-S02: escanea su rótulo; si la caja no lo tiene, imprímelo y pégalo encima.",
    );
  });

  it("«Verificar caja»: la salida que está en ESTA caja se nombra aunque sea anterior a la que falló (#KP136825)", () => {
    const gfEnLaCaja = out({ id: "g01", courier: "propio", output_code: "KP136825-S01", custody_state: "courier", created_at: "2026-09-26T15:00:00Z" });
    const tandersPosterior = { ...tandersVuelve, id: "t02", output_code: "KP136825-S02", output_number: 2, created_at: "2026-10-06T15:00:00Z" };
    expect(oldLabelHint("t02", [gfEnLaCaja, tandersPosterior], "caja", { inThisBox: new Set(["g01"]) })).toBe(
      "Es el rótulo viejo de KP136825-S02 (Tanders no entregó). En esta caja va como KP136825-S01: escanea su rótulo; si la caja no lo tiene, imprímelo y pégalo encima.",
    );
    // En el almacén no: una anterior no es la caja que volvió.
    expect(oldLabelHint("t02", [gfEnLaCaja, tandersPosterior], "pedido", { reprogramming: true })).toBeNull();
  });

  it("«Verificar caja»: la S02 existe pero no está en esta caja → el error de siempre", () => {
    expect(oldLabelHint("s01", [tandersVuelve, s02PorDefinir], "caja", { inThisBox: new Set() })).toBeNull();
  });

  it("«Dejar paquete listo»: la S02 está en el almacén", () => {
    expect(oldLabelHint("s01", [tandersVuelve, s02PorDefinir], "pedido")).toBe(
      "Es el rótulo viejo de AUR177756-S01 (Tanders no entregó). El pedido sale como AUR177756-S02: escanea su rótulo; si la caja no lo tiene, imprímelo y pégalo encima.",
    );
  });

  it("sin salida nueva todavía (#KP137746), dice cómo nace si el pedido está por reprogramarse", () => {
    expect(oldLabelHint("s01", [tandersVuelve], "pedido", { reprogramming: true })).toBe(
      "Es el rótulo viejo de AUR177756-S01 (Tanders no entregó). Para reprogramarlo, imprime desde el pedido el rótulo de su salida nueva y pégalo encima.",
    );
  });

  it("un pedido que ya no se reprograma (Por cerrar) no recibe la invitación: el error de siempre", () => {
    expect(oldLabelHint("s01", [tandersVuelve], "pedido", { reprogramming: false })).toBeNull();
    expect(oldLabelHint("s01", [tandersVuelve], "pedido")).toBeNull();
  });

  it("una salida viva anterior a la que falló no se nombra como la caja", () => {
    const anterior = { ...s02PorDefinir, id: "s00", output_code: "AUR177756-S00", output_number: 0, created_at: "2026-10-01T15:00:00Z" };
    expect(oldLabelHint("s01", [tandersVuelve, anterior], "pedido", { reprogramming: true })).toBeNull();
  });

  it("una salida que no falló no cambia ningún mensaje", () => {
    const gf = out({ id: "gf", courier: "propio", delivery_status: "en_ruta", custody_state: "courier" });
    expect(oldLabelHint("gf", [gf, s02PorDefinir], "pedido")).toBeNull();
    expect(oldLabelHint("no-existe", [tandersVuelve], "pedido")).toBeNull();
  });

  it("los textos sueltos", () => {
    expect(oldLabelMessage({ outputCode: null, courier: "fenix" }, null, "caja")).toContain("Es el rótulo viejo de una salida (Swayp no entregó).");
    expect(previousLabelNote({ outputCode: "AUR177756-S01", courier: "tanders" }, "AUR177756-S02")).toBe(
      "Leíste el rótulo de AUR177756-S01 (Tanders): la caja va como AUR177756-S02. Imprime su rótulo y pégalo encima.",
    );
    expect(newOutputLabelNotice(["AUR177756-S02"])).toBe(
      "Salida nueva AUR177756-S02: imprime su rótulo y pégalo sobre la caja que volvió, tapando el anterior.",
    );
    expect(newOutputLabelNotice(["A-S02", "B-S02"])).toMatch(/^Salidas nuevas A-S02, B-S02:/);
  });

  it("la guía combinada en lote no reimprime la de Tanders que no entregó", () => {
    const rows = [
      { id: "vuelve", order_id: "o1", courier: "tanders", delivery_status: "en_ruta", output_number: 1, reported_status: "RETURNING" },
      { id: "volvio", order_id: "o2", courier: "tanders", delivery_status: "en_ruta", output_number: 1, reported_status: "returned" },
      { id: "viva", order_id: "o3", courier: "tanders", delivery_status: "pendiente", output_number: 1, reported_status: "PENDING" },
      // Tanders la sigue dando en reparto, pero la caja ya se recibió en Devoluciones.
      { id: "recibida", order_id: "o4", courier: "tanders", delivery_status: "en_ruta", output_number: 1, reported_status: "PICKED", returned_at: "2026-10-08T16:00:00Z" },
    ];
    expect(pickCombinadaOutputs(["o1", "o2", "o3", "o4"], rows, "tanders")).toEqual({ shipmentIds: ["viva"], missingOrderIds: ["o1", "o2", "o4"] });
  });
});

// ---------------------------------------------------------------------------
// Regla 2: la toma de Grupo GF, con sus dependencias de datos simuladas
// ---------------------------------------------------------------------------

const S01_ROW = {
  id: "s01", order_id: "order", courier: "tanders", delivery_status: "en_ruta", status_category: "in_route",
  reported_status: "RETURNING", custody_state: "retorno", dispatched_at: "2026-10-06T14:00:00Z",
  output_number: 1, output_code: "AUR177756-S01", guide_code: "TANDER1",
};
const S02_ROW = {
  id: "s02", order_id: "order", courier: "por_definir", created_via: MANUAL_ROUTE_CREATED_VIA, delivery_status: "pendiente",
  status_category: "pending", custody_state: "empresa", custody_transferred_at: null, output_number: 2,
  output_code: "AUR177756-S02", guide_code: "MOM-AUR177756-POR_DEFINIR-1",
};
const ORDER = { order_id: "order", order_name: "#AUR177756", store_id: "store", coverage: "lima", current_courier: "tanders", district: "San Juan de Miraflores" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T15:00:00Z"));
  state.writes = [];
});

const take = () => takeGroupGfCourierOrders("org", ["order"]);
const shipmentWrites = () => state.writes.filter((w) => w.table === "shipments");
const eventKinds = () => state.writes.filter((w) => w.table === "order_events").map((w) => w.value.kind);

describe("regla 2: Grupo GF rellena la salida que nació al imprimir", () => {
  it("con la S02 impresa (Preparación · Por armar), la rellena: mismo QR, sin crear otra ni repetir el motivo", async () => {
    // Antes: «El pedido ya tiene una salida asignada a otro courier», por la S01.
    state.order = { ...ORDER, macro_stage: "preparacion", macro_substage: "por_armar", operational_status: "en_ruta" };
    state.outputs = [S01_ROW, S02_ROW];
    const result = await take();
    expect(result.error).toBeUndefined();
    expect(result.accepted).toEqual([{ orderId: "order", shipmentId: "s02", outputCode: "AUR177756-S02" }]);
    expect(shipmentWrites().some((w) => w.op === "insert")).toBe(false);
    const fill = shipmentWrites().find((w) => w.op === "update" && w.filters.courier === "por_definir")!;
    expect(fill.filters.id).toBe("s02");
    expect(fill.value).toMatchObject({ courier: "propio" });
    expect(fill.value.qr_token).toBeUndefined();
    // La S01 de Tanders no se toca.
    expect(shipmentWrites().every((w) => w.filters.id !== "s01")).toBe(true);
    expect(eventKinds()).toContain("route_output_filled");
    expect(eventKinds()).not.toContain("additional_output_reason");
    expect(result.notice).not.toContain("Salida nueva");
  });

  it("listo para asignar, igual", async () => {
    state.order = { ...ORDER, macro_stage: "por_despachar", macro_substage: "listo_para_asignar", operational_status: "en_ruta" };
    state.outputs = [S01_ROW, { ...S02_ROW, preparation_state: "listo_despacho" }];
    const result = await take();
    expect(result.accepted[0]?.shipmentId).toBe("s02");
    expect(shipmentWrites().some((w) => w.op === "insert")).toBe(false);
  });

  it("si el Master no se recalculó (sigue en reintento), también rellena la S02 en vez de crear una S03", async () => {
    state.order = { ...ORDER, macro_stage: "en_curso", macro_substage: "por_reprogramar_lima", operational_status: "pendiente_nuevo_courier" };
    state.outputs = [S01_ROW, S02_ROW];
    const result = await take();
    expect(result.accepted).toEqual([{ orderId: "order", shipmentId: "s02", outputCode: "AUR177756-S02" }]);
    expect(shipmentWrites().some((w) => w.op === "insert")).toBe(false);
    expect(eventKinds()).not.toContain("additional_output_reason");
  });

  it("sin rótulo pedido antes (el camino viejo), crea la salida, escribe el motivo y avisa que falta su rótulo", async () => {
    state.order = { ...ORDER, macro_stage: "en_curso", macro_substage: "por_reprogramar_lima", operational_status: "pendiente_nuevo_courier" };
    state.outputs = [S01_ROW];
    const result = await take();
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ needsLabel: true });
    const inserted = shipmentWrites().find((w) => w.op === "insert")!;
    expect(inserted.value).toMatchObject({ courier: "propio", custody_state: "empresa" });
    const reason = state.writes.find((w) => w.table === "order_events" && w.value.kind === "additional_output_reason")!;
    expect(reason.value.reason).toContain("Tanders no entregó y su caja todavía vuelve");
    expect(result.notice).toContain("Salida nueva AUR177756-S03: imprime su rótulo y pégalo sobre la caja que volvió");
  });

  it("una salida viva de otro courier sigue impidiéndolo", async () => {
    state.order = { ...ORDER, macro_stage: "preparacion", macro_substage: "por_armar", operational_status: "en_ruta" };
    state.outputs = [{ ...S01_ROW, reported_status: "PICKED" }, S02_ROW];
    const result = await take();
    expect(result.accepted).toEqual([]);
    // Desde el 09-10-2026 la negativa nombra la salida y su courier.
    expect(result.failed[0]?.error).toBe(
      "AUR177756-S01 está en ruta con Tanders. Para llevarlo en Grupo GF, registra antes el resultado de la que está en ruta.",
    );
    expect(state.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// El cableado que no se puede ejecutar aquí
// ---------------------------------------------------------------------------

describe("el cableado", () => {
  const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

  it("«Descargar rótulos» crea con el motivo automático y escribe una vez la salida adicional", () => {
    const src = read("app/dashboard/pedidos/actions.ts");
    const body = src.slice(src.indexOf("export async function resolveLabelsForOrders("), src.indexOf("// Salidas en lote"));
    expect(body).toContain("reprogramOutputReason({ courier: failure.courier, returned: failure.returned, outputCode: failure.outputCode })");
    expect(body).toContain("dispatchDate: limaTodayKey(),\n      note,");
    expect(body).toContain("salidasQueEstorban((byOrder.get(orderId) ?? []).filter((o) => o.id !== result.shipmentId))");
    expect(body).toContain('kind: "additional_output_reason"');
    // Si una lectura falla no se crea una salida por pedido a ciegas.
    expect(body).toContain("if (shipmentError || masterError) {");
    expect(body).toContain("reported_status,swayp_state,dispatched_at,returned_at");
    // Solo en Lima, y con la foto del pedido fresca antes de crear.
    expect(body).toContain('admin.from("order_master").select("order_id,macro_operation").in("order_id", unique)');
    expect(body).toContain("const decisionCtx = { lima: limaOrders.has(orderId) };");
    expect(body).toContain('const { data: fresh, error: freshError } = await admin.from("shipments").select(labelColumns).eq("order_id", orderId);');
    expect(body).toContain("decision = decideLabelAction(freshRows, decisionCtx);");
  });

  it("los escáneres de almacén nombran la salida hermana solo en el camino que ya falla", () => {
    const src = read("app/dashboard/pedidos/despacho/actions.ts");
    const ready = src.slice(src.indexOf("export async function markShipmentReady("));
    expect(ready.indexOf('(await oldLabelError(shipment, "pedido")) ?? "Ese paquete ya no figura en custodia de la empresa."')).toBeGreaterThan(-1);
    expect(src).toContain('const oldLabel = box ? null : await oldLabelError(shipment, "caja", manifestId);');
    expect(src).toContain("return { error: oldLabel ?? notInThisBoxMessage(here, elsewhere) };");
  });

  it("asignar por escaneo con el rótulo viejo nombra la salida y ofrece su rótulo", () => {
    const src = read("app/dashboard/courier/actions.ts");
    const scan = src.slice(src.indexOf("export async function scanAssignToRider("));
    // También si el pedido ya estaba tomado: la salida es la de su solicitud.
    expect(scan).toContain('.select("id,shipment_id")');
    expect(scan).toContain("requestShipmentId !== found.shipment.id");
    expect(scan).toContain("labelUrl: `/api/pedidos/rotulos?ids=${requestShipmentId}`");
    const board = read("components/dispatch-day-board.tsx");
    expect(board).toContain("{l.relabel && (");
    // La chapa «nace su salida nueva» solo cuando la toma de verdad la crea.
    expect(src).toContain("newOutputOnTake: retry && !fillable,");
    expect(board).toContain("{q.newOutputOnTake && !q.taken && <span");
  });

  it("la ficha deja de ofrecer el rótulo de la que falló como enlace principal", () => {
    const ficha = read("components/order-drawer.tsx");
    expect(ficha).toContain('detail && detail.row.macro_operation === "lima"');
    expect(ficha).toContain("const notDelivered = reprogram !== null && isFailedOutput(guideForDecision(g));");
    expect(ficha).toContain('{g.courier === "tanders" && !notDelivered && (');
    expect(ficha).toContain("{g.qr_token && !notDelivered && (");
    expect(ficha).toContain("Rótulo viejo (solo Devoluciones)");
    expect(ficha).toContain("Imprimir rótulo de la salida nueva");
    // Con una salida anterior abierta no se ofrece imprimir (el clic fallaría).
    expect(ficha).toContain("canEdit && reprogram && !reprogram.live && !reprogram.open &&");
    // El aviso de Devoluciones depende de que una persona recibiera la caja, no del barrido.
    expect(ficha).toContain("(!reprogram.received && RETURN_SCAN_COURIERS.has(reprogram.failed.courier)");
    expect(read("lib/orders-master-access.ts")).toContain('events.filter((e) => e.kind === "return_received" && e.shipment_id)');
    expect(ficha).toContain("await resolveLabelsForOrders([orderId])");
  });
});
