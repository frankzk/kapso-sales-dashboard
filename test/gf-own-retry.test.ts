// Lo que Grupo GF no entregó con su propia salida también se reprograma desde
// la lista, con ESA salida (06-10-2026, decisión del owner).
//
// #KP132798 salió el 06/09 en una ruta del cuaderno con KP132798-S01 y volvió
// «No entregado · rechazado» el 07/09. El Master lo tenía en «Por reprogramar
// Lima», pero la cola solo traía ese apartado con `pendiente_nuevo_courier`: no
// aparecía en «Desde la lista» ni se podía tomar por QR. Medido el 05-10-2026:
// 45 así y 10 con la S01 todavía en una caja de Grupo GF sin solicitud.
//
//   1. La regla pura: qué salida se reusa y qué toca según dónde está.
//   2. Mismo conjunto que el Master: lo que el resolver pone en «Por
//      reprogramar Lima» la cola lo admite, y al asignarlo sale de ahí.
//   3. La fila: cuenta en «Por reprogramar» y se recibe en oficina si sigue en
//      una caja.
//   4. Tomarlo de verdad (base simulada): sin salida nueva, la solicitud apunta
//      a la S01 y no se toca su armado, QR ni rótulo.
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REPROGRAM_QUEUE_FILTER,
  isReprogramStage,
  isRetryAdmission,
  ownOutputLabel,
  ownRetryDecision,
  ownRetryDecisionMessage,
  ownRetryOutput,
  ownRetryTakenNote,
  reprogramBlockReason,
} from "@/lib/gf-retry";
import { resolveMacroStage, type MacroEventSnapshot, type MacroGuideSnapshot, type ResolveMacroStageInput } from "@/lib/order-macro-stage";
import { BLOCKED_REASON_LABEL, EMPTY_QUEUE_FILTERS, filterQueue, isPorReprogramar, isReturnable, queueTileCounts, type QueueRow } from "@/lib/dispatch-day";

const state = vi.hoisted(() => ({
  order: {} as Record<string, unknown>,
  outputs: [] as Record<string, unknown>[],
  tables: {} as Record<string, unknown>,
  adoptFails: false,
  insertConflict: false,
  writes: [] as { table: string; op: string; value: any; filters: Record<string, unknown> }[],
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "manager" }), getAdminOrgs: async () => [{ org_id: "org" }], getAccessibleStores: async () => [] }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn() }));
vi.mock("@/lib/grupo-gf-courier-route-access", () => ({
  loadGroupGfCourierRouteCheck: async () => ({ eligible: true, providerId: "gf", agreementId: "agreement", districtKey: "san martin de porres", tariffId: "tariff", tariffAmount: 13, currency: "PEN", sameDayCutoff: "11:30" }),
  riderPickupMode: vi.fn(),
}));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    let op = "read";
    let value: any;
    const filters: Record<string, unknown> = {};
    const q: any = {};
    for (const method of ["select", "in", "limit", "is", "not", "order", "neq"]) q[method] = () => q;
    q.eq = (key: string, val: unknown) => { filters[key] = val; return q; };
    for (const method of ["insert", "update"]) q[method] = (val: unknown) => { op = method; value = val; return q; };
    q.delete = () => { op = "delete"; value = {}; return q; };
    const result = () => {
      if (op !== "read") {
        state.writes.push({ table, op, value, filters: { ...filters } });
        if (state.adoptFails && table === "shipments" && op === "update" && "created_via" in value) return { data: null, error: null };
        if (state.insertConflict && table === "logistics_requests" && op === "insert") return { data: null, error: { code: "23505", message: "duplicate key" } };
        return { data: table === "shipments" ? { id: value.id ?? filters.id, output_code: "KP132798-S01" } : { id: value.id ?? "request" }, error: null };
      }
      const fixture = state.tables[table];
      const data = table in state.tables ? (typeof fixture === "function" ? fixture(filters) : fixture)
        : table === "logistics_providers" ? { id: "gf" }
        : table === "order_master" ? state.order
        : table === "shipments" ? state.outputs
        : table === "orders" ? { line_items: [] } : null;
      return { data, error: null };
    };
    q.maybeSingle = q.single = async () => {
      const r = result();
      return Array.isArray(r.data) ? { ...r, data: r.data[0] ?? null } : r;
    };
    q.then = (ok: any, ko: any) => Promise.resolve(result()).then(ok, ko);
    return q;
  };
  return { createAdminSupabase: () => ({ from }), createServerSupabase: async () => ({ from }) };
});

import { takeGroupGfCourierOrders } from "@/app/dashboard/courier/actions";

const read = (path: string) => readFileSync(resolvePath(process.cwd(), path), "utf8");

/** La S01 de #KP132798 tal como está en la base el 05-10-2026. */
const s01 = {
  id: "51febca9",
  order_id: "kp132798",
  courier: "propio",
  created_via: "mom_manual_route",
  delivery_status: "pendiente",
  status_category: "pending",
  custody_state: "empresa",
  custody_transferred_at: null,
  output_number: 1,
  output_code: "KP132798-S01",
  guide_code: "MOM-KP132798-POR_DEFINIR-51FEBCA9",
  dispatched_at: null,
  reported_status: null,
  swayp_state: null,
  returned_at: null,
};
const reprogramar = { macro_stage: "en_curso", macro_substage: "por_reprogramar_lima" };

describe("1. la salida propia que se reprograma con ella misma", () => {
  it("#KP132798: salida del cuaderno, «No entregado», sin solicitud → se reusa su S01", () => {
    expect(ownRetryOutput(reprogramar, [s01])).toBe(s01);
    // No es un reintento de otro courier: su operativo es asignado_a_courier.
    expect(isRetryAdmission("en_curso", "por_reprogramar_lima", "asignado_a_courier")).toBe(false);
  });

  it("solo en «Por reprogramar Lima»: la misma forma entregada o en preparación no entra por aquí", () => {
    // Medido: 869 pedidos «Por cerrar · Entregado» tienen una S01 propia pendiente.
    expect(ownRetryOutput({ macro_stage: "por_cerrar", macro_substage: "entregado" }, [s01])).toBeNull();
    expect(ownRetryOutput({ macro_stage: "preparacion", macro_substage: "por_armar" }, [s01])).toBeNull();
  });

  it("con algo entregado, o con la salida anulada o devuelta, no se reusa", () => {
    expect(ownRetryOutput(reprogramar, [s01, { ...s01, id: "x", delivery_status: "entregado" }])).toBeNull();
    expect(ownRetryOutput(reprogramar, [{ ...s01, status_category: "delivered" }])).toBeNull();
    expect(ownRetryOutput(reprogramar, [{ ...s01, delivery_status: "anulado" }])).toBeNull();
    expect(ownRetryOutput(reprogramar, [{ ...s01, custody_state: "devuelto" }])).toBeNull();
    expect(ownRetryOutput(reprogramar, [{ ...s01, returned_at: "2026-09-24T15:00:00Z" }])).toBeNull();
  });

  it("una propia devuelta (la 0189 la deja `pendiente`) no está viva: no estorba a la que sí lo está", () => {
    const devuelta = { ...s01, custody_state: "devuelto", returned_at: "2026-09-24T15:00:00Z" };
    const s02 = { ...s01, id: "s02", output_number: 2, output_code: "KP132798-S02" };
    expect(ownRetryOutput(reprogramar, [devuelta, s02])).toBe(s02);
  });

  it("otra salida viva la lleva su courier; la de otro courier que falló no estorba", () => {
    const aliclik = { ...s01, id: "a", courier: "aliclik", delivery_status: "en_ruta", custody_state: "courier" };
    expect(ownRetryOutput(reprogramar, [s01, aliclik])).toBeNull();
    expect(ownRetryOutput(reprogramar, [s01, { ...s01, id: "s02" }])).toBeNull();
    const tandersVuelve = { ...s01, id: "t", courier: "tanders", delivery_status: "en_ruta", reported_status: "RETURNING", custody_state: "retorno" };
    expect(ownRetryOutput(reprogramar, [s01, tandersVuelve])).toBe(s01);
    // La de otro courier sola no es salida propia.
    expect(ownRetryOutput(reprogramar, [aliclik])).toBeNull();
  });

  it("dónde está el paquete decide qué toca, igual en la cola y al tomarlo", () => {
    expect(ownRetryDecision(s01, null, false)).toEqual({ action: "tomar" });
    expect(ownRetryDecision({ custody_state: "courier" }, { undeliveredReason: "no_contesta" }, false)).toEqual({ action: "recibir_en_oficina" });
    // #KP134157: en la caja del 17/09, solo con la parada del cuaderno.
    expect(ownRetryDecision({ custody_state: "courier" }, { undeliveredReason: null }, false)).toEqual({ action: "bloquear", reason: "caja_sin_reporte" });
    expect(ownRetryDecision({ custody_state: "courier" }, null, false)).toEqual({ action: "bloquear", reason: "fuera_de_oficina" });
    // La toma exige además que no se haya transferido (`adoptOwnOutput`): la cola también.
    expect(ownRetryDecision({ custody_state: "empresa", custody_transferred_at: "2026-09-19T13:00:00Z" }, null, false)).toEqual({ action: "bloquear", reason: "fuera_de_oficina" });
    // Una salida que ya estuvo en otra solicitud, aunque cancelada (`logistics_requests_shipment_uniq`).
    expect(ownRetryDecision(s01, null, true)).toEqual({ action: "bloquear", reason: "salida_en_otra_solicitud" });
    const box = { riderName: "Roy", routeDate: "2026-09-17" };
    expect(ownRetryDecisionMessage({ action: "recibir_en_oficina" }, box)).toBe("Sigue en la caja de Roy del 17/09 como «No entregado»: recíbelo en oficina (o escanea su QR) y después asígnalo.");
    expect(ownRetryDecisionMessage({ action: "bloquear", reason: "caja_sin_reporte" }, box)).toBe("Sigue en la caja de Roy del 17/09 sin «No entregado» de esa caja: revisa su parada antes de sacarlo otra vez.");
    // Sin la fila de la caja no queda «del » colgando.
    expect(ownRetryDecisionMessage({ action: "bloquear", reason: "caja_sin_reporte" }, { riderName: "Roy", routeDate: "" })).toBe("Sigue en la caja de Roy sin «No entregado» de esa caja: revisa su parada antes de sacarlo otra vez.");
    expect(ownRetryDecisionMessage({ action: "bloquear", reason: "salida_en_otra_solicitud" }, null, "KP132798-S01")).toBe("KP132798-S01 ya estuvo en otra solicitud de Grupo GF: revísalo antes de volver a tomarlo.");
    expect(ownRetryDecisionMessage({ action: "bloquear", reason: "fuera_de_oficina" }, null)).toBe("El paquete no consta en la oficina ni en una caja: revisa su custodia en la ficha antes de asignarlo.");
  });

  it("lo dice la fila y el historial", () => {
    expect(ownOutputLabel("KP132798-S01")).toBe("Grupo GF no entregó · sale con su S01");
    expect(ownOutputLabel(null)).toBe("Grupo GF no entregó · sale con su misma salida");
    expect(ownRetryTakenNote("KP132798-S01")).toBe("Grupo GF Courier tomó el pedido para reprogramarlo con su misma salida KP132798-S01: mismo QR y rótulo, sin salida nueva.");
  });

  it("lo que no se puede sacar dice por qué en «Sin condiciones», con el motivo cierto", () => {
    const aliclik = { ...s01, id: "a", courier: "aliclik", delivery_status: "en_ruta", custody_state: "courier" };
    expect(reprogramBlockReason([s01, aliclik])).toBe("otra_salida_viva");
    // Salidas de Grupo GF que no se reusan tal cual no son «la lleva su courier»:
    // dos vivas, una «por definir» además, una en ruta, o junto a una entregada.
    expect(reprogramBlockReason([s01, { ...s01, id: "s02" }])).toBe("revisar_salidas");
    expect(reprogramBlockReason([s01, { ...s01, id: "pd", courier: "por_definir" }])).toBe("revisar_salidas");
    expect(reprogramBlockReason([{ ...s01, delivery_status: "en_ruta" }])).toBe("revisar_salidas");
    expect(reprogramBlockReason([s01, { ...s01, id: "x", delivery_status: "entregado" }])).toBe("revisar_salidas");
    // El rechazo que la 0189 recibió en oficina: deja `pendiente` con custodia
    // `devuelto` y `returned_at` (0189, líneas 45-47). No está viva.
    expect(reprogramBlockReason([{ ...s01, custody_state: "devuelto", returned_at: "2026-09-24T15:00:00Z" }])).toBe("salida_devuelta");
    expect(reprogramBlockReason([{ ...s01, delivery_status: "anulado" }])).toBe("sin_salida");
    expect(reprogramBlockReason([])).toBe("sin_salida");
    for (const reason of ["otra_salida_viva", "revisar_salidas", "salida_devuelta", "caja_sin_reporte", "fuera_de_oficina", "salida_en_otra_solicitud"] as const) {
      expect(BLOCKED_REASON_LABEL[reason].label.length).toBeGreaterThan(10);
    }
  });
});

describe("2. el mismo conjunto que el Master", () => {
  const T = (d: string, h: string) => `2026-${d}T${h}:00.000Z`;
  const guia = (over: Partial<MacroGuideSnapshot> = {}): MacroGuideSnapshot => ({
    id: s01.id,
    courier: "propio",
    delivery_status: "pendiente",
    attempts: 0,
    assigned_at: T("09-06", "17:21"),
    dispatched_at: null,
    out_for_delivery_at: null,
    rescheduled_at: null,
    returned_at: null,
    pickup_state: null,
    preparation_state: "listo_despacho",
    custody_state: "empresa",
    ...over,
  });
  const ev = (kind: string, at: string, extra: Partial<MacroEventSnapshot> = {}): MacroEventSnapshot => ({ kind, occurred_at: at, shipment_id: s01.id, ...extra });
  // El lote «cierre-rutas-cuaderno» dejó el stop_reported atado a la S01.
  const rechazo = ev("stop_reported", T("09-07", "17:00"), { payload: { status: "no_entregado", outcome_reason: "rechazado" } });
  const master = (over: Partial<ResolveMacroStageInput> = {}) => resolveMacroStage({
    order: { created_at: T("09-06", "15:48"), cancelled_at: null, financial_status: "pending", shipping_mode: "cod", region: "Lima", province: "Lima", district: "San Martin de Porres", coverage: "lima" },
    guides: [guia()],
    events: [rechazo],
    legacy: { general: "en_proceso", operational: "asignado_a_courier", since: T("09-06", "17:21") },
    paymentState: null,
    ...over,
  });

  it("#KP132798 está en «Por reprogramar Lima» y la cola lo admite con su S01", () => {
    const m = master();
    expect(m).toMatchObject({ stage: "en_curso", substage: "por_reprogramar_lima" });
    expect(isReprogramStage(m.stage, m.substage)).toBe(true);
    expect(ownRetryOutput({ macro_stage: m.stage, macro_substage: m.substage }, [s01])).toBe(s01);
  });

  it("al asignarlo a una caja con la misma salida deja «Por reprogramar Lima»; recibido por el motorizado, En reparto", () => {
    const assigned = ev("dispatch_route_assigned", T("10-06", "15:00"));
    expect(master({ events: [rechazo, assigned] })).toMatchObject({ stage: "por_despachar" });
    const received = { ...ev("custody_transferred", T("10-06", "16:00")), note: "Paquete cotejado y recibido por el motorizado." };
    expect(master({
      guides: [guia({ custody_state: "courier", dispatched_at: T("10-06", "16:00") })],
      events: [rechazo, assigned, received],
      legacy: { general: "en_proceso", operational: "despachado", since: T("09-06", "17:21") },
    })).toMatchObject({ stage: "en_curso", substage: "en_reparto" });
  });

  it("los 10 en una caja sin solicitud también están en «Por reprogramar Lima»: primero se reciben en oficina", () => {
    const inBox = guia({ custody_state: "courier", dispatched_at: T("09-19", "13:00") });
    const m = master({ guides: [inBox], events: [ev("stop_reported", T("09-19", "17:00"), { payload: { status: "no_entregado", outcome_reason: "no_contesta" } })], legacy: { general: "en_proceso", operational: "despachado", since: T("09-19", "13:00") } });
    expect(m).toMatchObject({ stage: "en_curso", substage: "por_reprogramar_lima" });
    const own = ownRetryOutput({ macro_stage: m.stage, macro_substage: m.substage }, [{ ...s01, custody_state: "courier", dispatched_at: T("09-19", "13:00") }]);
    expect(own).not.toBeNull();
    expect(ownRetryDecision(own!, { undeliveredReason: "no_contesta" }, false)).toEqual({ action: "recibir_en_oficina" });
  });

  it("la cola pide «Por reprogramar Lima» por la etapa, sin el estado operativo", () => {
    expect(REPROGRAM_QUEUE_FILTER).toBe("and(macro_stage.eq.en_curso,macro_substage.eq.por_reprogramar_lima)");
    expect(REPROGRAM_QUEUE_FILTER).not.toContain("operational_status");
    // Toda variante operativa de la etapa entra; el reintento de otro courier también.
    for (const operational of ["pendiente_nuevo_courier", "asignado_a_courier", "despachado", "reprogramado"]) {
      expect(isReprogramStage("en_curso", "por_reprogramar_lima")).toBe(true);
      expect(isRetryAdmission("en_curso", "por_reprogramar_lima", operational)).toBe(operational === "pendiente_nuevo_courier");
    }
    expect(isReprogramStage("en_curso", "en_transito")).toBe(false);
  });
});

describe("3. la fila en «Desde la lista»", () => {
  const row = (over: Partial<QueueRow>): QueueRow => ({
    orderId: "kp132798",
    orderName: "#KP132798",
    storeName: "Kenku Peru",
    customerName: "Eucebio Kenku",
    customerPhone: "51984541338",
    district: "San Martin de Porres",
    orderTotal: 89,
    createdAt: "2026-09-06T15:48:30Z",
    scheduledFor: "2026-10-06",
    tariffAmount: 13,
    taken: false,
    requestId: null,
    armed: null,
    observation: null,
    hasPriorDispatch: true,
    programmedFor: null,
    macroStage: "en_curso",
    macroSubstage: "por_reprogramar_lima",
    assignable: true,
    route: null,
    ownOutput: { outputCode: "KP132798-S01" },
    ...over,
  });

  it("en la oficina se asigna; en una caja anterior se recibe; las dos cuentan en «Por reprogramar»", () => {
    const office = row({});
    const inBox = row({
      orderId: "kp135156",
      orderName: "#KP135156",
      assignable: false,
      route: { riderName: "Yhoni", routeDate: "2026-09-19", loadNumber: 1, state: "in_custody", officeCheckedAt: "2026-09-19T12:00:00Z", pickupCheckedAt: "2026-09-19T17:00:00Z", undeliveredReason: "no_contesta" },
    });
    expect(isReturnable(inBox)).toBe(true);
    expect(isReturnable(office)).toBe(false);
    const queue = [office];
    const all = [office, inBox];
    expect(filterQueue(all, EMPTY_QUEUE_FILTERS, "2026-10-06").map((q) => q.orderId)).toEqual(["kp132798", "kp135156"]);
    expect(all.every(isPorReprogramar)).toBe(true);
    const tiles = queueTileCounts(queue, all, "2026-10-06");
    expect(tiles.por_asignar).toBe(1);
    expect(tiles.por_reprogramar).toBe(2);
  });
});

describe("4. tomarlo de verdad reusa la S01", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
    state.writes = [];
    state.tables = {};
    state.adoptFails = false;
    state.insertConflict = false;
    state.order = { order_id: "kp132798", order_name: "#KP132798", store_id: "kenku", coverage: "lima", current_courier: "propio", macro_stage: "en_curso", macro_substage: "por_reprogramar_lima", operational_status: "asignado_a_courier", district: "San Martin de Porres" };
    state.outputs = [{ ...s01 }];
  });
  const take = () => takeGroupGfCourierOrders("org", ["kp132798"]);

  it("sin salida nueva, sin motivo de salida adicional y la solicitud apunta a la S01", async () => {
    const result = await take();
    expect(result.error).toBeUndefined();
    expect(result.accepted).toEqual([{ orderId: "kp132798", shipmentId: s01.id, outputCode: "KP132798-S01" }]);
    expect(state.writes.some((w) => w.table === "shipments" && w.op === "insert")).toBe(false);
    expect(state.writes.some((w) => w.value?.kind === "additional_output_reason")).toBe(false);
    expect(state.writes.some((w) => w.value?.kind === "route_output_filled")).toBe(false);
    const request = state.writes.find((w) => w.table === "logistics_requests" && w.op === "update" && w.value.shipment_id)!;
    expect(request.value).toMatchObject({ shipment_id: s01.id, status: "accepted" });
    const event = state.writes.find((w) => w.table === "order_events" && w.value.kind === "logistics_request_accepted")!;
    expect(event.value).toMatchObject({ shipment_id: s01.id, guide_code: s01.guide_code, payload: { reusedOutput: true, ownRetry: { previousCreatedVia: "mom_manual_route" } } });
    // El rótulo sigue siendo el mismo.
    const label = state.writes.find((w) => w.table === "shipments" && w.op === "update" && "label_url" in w.value)!;
    expect(label.value.label_url).toBe(`/api/pedidos/rotulos?ids=${s01.id}`);
    expect(event.value.note).toContain("con su misma salida KP132798-S01");
  });

  it("la adopción repite las condiciones y no toca armado, QR, consecutivo ni rótulo", async () => {
    await take();
    const adopt = state.writes.find((w) => w.table === "shipments" && w.op === "update" && "created_via" in w.value)!;
    expect(adopt.filters).toMatchObject({ id: s01.id, courier: "propio", delivery_status: "pendiente", custody_state: "empresa" });
    expect(adopt.value.created_via).toBe("grupo_gf_courier");
    for (const key of ["preparation_state", "custody_state", "qr_token", "output_code", "output_number", "guide_code", "delivery_status"]) {
      expect(adopt.value).not.toHaveProperty(key);
    }
  });

  it("si sigue en una caja anterior, pide recibirlo en oficina y no escribe nada", async () => {
    state.outputs = [{ ...s01, custody_state: "courier", dispatched_at: "2026-09-19T13:00:00Z" }];
    state.tables = {
      dispatch_manifest_items: [{ shipment_id: s01.id, manifest_id: "caja-yhoni", office_checked_at: null, pickup_checked_at: null }],
      dispatch_manifests: [{ id: "caja-yhoni", courier: "propio", route_date: "2026-09-19", rider_id: "yhoni", driver_name: "Yhoni", state: "in_custody", load_number: 1, delivery_route_id: "ruta" }],
      delivery_stops: [{ shipment_id: s01.id, dispatch_manifest_id: "caja-yhoni", status: "no_entregado", outcome_reason: "no_contesta", reported_at: "2026-09-19T17:00:00Z" }],
    };
    const result = await take();
    expect(result.accepted).toEqual([]);
    expect(result.error).toBe("Sigue en la caja de Yhoni del 19/09 como «No entregado»: recíbelo en oficina (o escanea su QR) y después asígnalo.");
    expect(state.writes).toEqual([]);
  });

  it("en una caja sin su «No entregado» (solo la parada del cuaderno) no se toma y dice revisarla", async () => {
    state.outputs = [{ ...s01, custody_state: "courier", dispatched_at: "2026-09-17T13:00:00Z" }];
    state.tables = {
      dispatch_manifest_items: [{ shipment_id: s01.id, manifest_id: "caja-roy", office_checked_at: null, pickup_checked_at: null }],
      dispatch_manifests: [{ id: "caja-roy", courier: "propio", route_date: "2026-09-17", rider_id: "roy", driver_name: "Roy", state: "in_custody", load_number: 1, delivery_route_id: "ruta" }],
      delivery_stops: [],
    };
    const result = await take();
    expect(result.error).toBe("Sigue en la caja de Roy del 17/09 sin «No entregado» de esa caja: revisa su parada antes de sacarlo otra vez.");
    expect(state.writes).toEqual([]);
  });

  it("si lo último reportado en esa caja no es «No entregado», tampoco (como la 0206)", async () => {
    // #KP134917: la parada de su caja del 17/09 dice entregado.
    state.outputs = [{ ...s01, custody_state: "courier", dispatched_at: "2026-09-17T13:00:00Z" }];
    state.tables = {
      dispatch_manifest_items: [{ shipment_id: s01.id, manifest_id: "caja-roy", office_checked_at: null, pickup_checked_at: null }],
      dispatch_manifests: [{ id: "caja-roy", courier: "propio", route_date: "2026-09-17", rider_id: "roy", driver_name: "Roy", state: "in_custody", load_number: 1, delivery_route_id: "ruta" }],
      delivery_stops: [
        { shipment_id: s01.id, dispatch_manifest_id: "caja-roy", status: "no_entregado", outcome_reason: "no_contesta", reported_at: "2026-09-17T16:00:00Z" },
        { shipment_id: s01.id, dispatch_manifest_id: "caja-roy", status: "entregado", outcome_reason: null, reported_at: "2026-09-17T18:00:00Z" },
      ],
    };
    expect((await take()).error).toContain("sin «No entregado» de esa caja");
    expect(state.writes).toEqual([]);
  });

  it("fuera de la oficina y sin caja no se toma", async () => {
    state.outputs = [{ ...s01, custody_state: "courier", custody_transferred_at: "2026-09-19T13:00:00Z" }];
    expect((await take()).error).toBe("El paquete no consta en la oficina ni en una caja: revisa su custodia en la ficha antes de asignarlo.");
    expect(state.writes).toEqual([]);
  });

  it("una salida que ya estuvo en otra solicitud (también cancelada) no se vuelve a enlazar", async () => {
    // `logistics_requests_shipment_uniq` no mira el estado: se dice antes de escribir.
    state.tables = { logistics_requests: (filters: Record<string, unknown>) => (filters.shipment_id ? [{ id: "cancelada" }] : []) };
    const result = await take();
    expect(result.accepted).toEqual([]);
    expect(result.error).toBe("KP132798-S01 ya estuvo en otra solicitud de Grupo GF: revísalo antes de volver a tomarlo.");
    expect(state.writes).toEqual([]);
  });

  it("con otra salida viva no se toma y dice por qué", async () => {
    state.outputs = [{ ...s01 }, { ...s01, id: "aliclik", courier: "aliclik", delivery_status: "en_ruta", custody_state: "courier" }];
    const result = await take();
    expect(result.error).toBe("Otra salida sigue viva: la lleva su courier.");
    expect(state.writes).toEqual([]);
  });

  it("si la salida cambió entre leerla y adoptarla, deshace la solicitud recién creada", async () => {
    // Se anuló o salió en otra pestaña: sin esto el pedido quedaba tras una
    // solicitud «observada» sin salida que nadie podía corregir.
    state.adoptFails = true;
    const result = await take();
    expect(result.accepted).toEqual([]);
    expect(result.error).toBe("KP132798-S01 ya no está pendiente en la oficina: vuelve a cargar la lista.");
    const undo = state.writes.find((w) => w.table === "logistics_requests" && w.op === "delete")!;
    expect(undo.filters).toMatchObject({ status: "accepting" });
    expect(state.writes.some((w) => w.table === "logistics_requests" && w.op === "update")).toBe(false);
    expect(state.writes.some((w) => w.table === "logistics_request_events" || w.table === "order_events")).toBe(false);
  });

  it("una solicitud cancelada antes no se cuenta como «ya estaba tomado»", async () => {
    // La clave de idempotencia choca también con una cancelada (0138).
    state.insertConflict = true;
    const result = await take();
    expect(result.alreadyAccepted).toEqual([]);
    expect(result.error).toBe("Este pedido ya tuvo una solicitud de Grupo GF que se canceló: no se puede volver a tomar desde aquí.");
  });

  it("guarda en el evento lo que la adopción sobrescribe", async () => {
    state.outputs = [{ ...s01, assigned_at: "2026-09-06T17:21:45Z", next_followup_at: "2026-09-06T17:00:00Z" }];
    await take();
    const event = state.writes.find((w) => w.table === "order_events" && w.value.kind === "logistics_request_accepted")!;
    expect(event.value.payload.ownRetry).toEqual({ previousCreatedVia: "mom_manual_route", previousAssignedAt: "2026-09-06T17:21:45Z", previousNextFollowupAt: "2026-09-06T17:00:00Z" });
  });
});

describe("las piezas en el código", () => {
  const src = read("app/dashboard/courier/actions.ts");
  const between = (from: string, to: string) => {
    const start = src.indexOf(from);
    return src.slice(start, src.indexOf(to, start + from.length));
  };

  it("la cola admite la salida propia y manda a recibir en oficina la que sigue en una caja", () => {
    const body = between("async function loadCourierOperations(", "\nexport async function loadCourierConfig(");
    expect(body).toContain("${REPROGRAM_QUEUE_FILTER}");
    expect(body).not.toContain("${RETRY_QUEUE_FILTER}");
    expect(body).toContain("const own = retry || review ? null : ownByOrder.get(order.order_id) ?? null;");
    expect(body).toContain("if (isReprogramStage(order.macro_stage, order.macro_substage)) block(order, reprogramBlockReason(outputs));");
    expect(body).toContain("const decision = own ? ownRetryDecision(own, ownBox, ownInRequest.has(own.id)) : null;");
    expect(body).toContain("returnable.push({ ...row, route: ownBox })");
    // Una salida con solicitud activa va por `accepted`, nunca por aquí.
    expect(body).toContain("if (activeOrderIds.has(order.order_id) || isRetryAdmission(");
    expect(body).toContain("return { available, returnable, accepted,");
  });

  it("la toma usa la misma regla y adopta la S01 en vez de escribir una guía", () => {
    const body = between("async function takeOrdersCore(", "\nexport ");
    expect(body).toContain("ownRetryOutput(row, outputs)");
    expect(body).toContain("const decision = ownRetryDecision(own, box, Boolean(priorRequest));");
    expect(body).toContain("const fillable = retry || review || own ? null : pickFillableRouteOutput(outputs);");
    expect(body).toContain("const write = own ? await adoptOwnOutput(admin, own, { acceptedAt, scheduledFor }) : await writeCourierGuide(");
    // La puerta de salida adicional y el tope de cinco siguen siendo solo del reintento y la revisión.
    expect(body).toContain("const puerta = retry || review");
    expect(body).toContain("if ((retry || review) && outputs.length >= MAX_OUTPUTS_PER_ORDER)");
  });

  it("asignar a una caja rechaza una salida anulada o entregada", () => {
    const body = between("async function assignRouteCore(", "\nexport ");
    expect(body).toContain('.select("id,courier,custody_state,delivery_status")');
    expect(body).toContain('if (shipment.delivery_status === "anulado" || shipment.delivery_status === "entregado")');
  });

  it("el tablero lista aparte los que siguen en una caja: no cuentan como «por asignar» ni se asignan", () => {
    const board = read("components/dispatch-day-board.tsx");
    expect(board).toContain("props.returnable.map((o) => ({");
    // La cola de asignar es tomados + disponibles; los de una caja van con lo que se sigue.
    expect(board).toContain("return [...taken, ...free];");
    expect(board).toContain("const allRows = useMemo(() => [...queue, ...tracked, ...ownInBox], [queue, tracked, ownInBox]);");
    // «Asignar» cuenta solo lo asignable y no dice «Asignados» si no había nada.
    expect(board).toContain("`Asignar${selectedAssignable.length ? ` ${selectedAssignable.length}` : \"\"} a ${riderName || \"…\"}`");
    expect(board).toContain("if (!split.orderIds.length && !split.requestIds.length) {");
    // La chapa «sale con su S01» solo cuando ya está en la oficina.
    expect(board).toContain("{q.ownOutput && !q.route && <Badge");
    expect(read("components/grupo-gf-courier.tsx")).toContain("returnable={snapshot.operations.returnable}");
  });

  it("la ficha ya no manda a anular la salida propia: la manda a reprogramarla con ella", () => {
    const plan = read("lib/order-route-plan.ts");
    expect(plan).toContain("Si no se entregó, se reprograma con esa misma salida desde Despacho del día («Desde la lista»).");
  });

  it("el MOM lo documenta", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("**Lo que Grupo GF no entregó con su propia salida también se reprograma desde la lista, con esa misma salida (06-10-2026, decisión del owner).**");
  });
});
