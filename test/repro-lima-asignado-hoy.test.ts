// «Asignado hoy» en Repro Lima (owner, 27-11-2026, #KP208991: «no está identificando en la actividad que el paquete ya
// está asignado para hoy con Yordani… cuando ya esté asignado al motorizado en el estado de "por entregar" el día de hoy
// ya no estén en repro lima - programados, sino pase a repro lima - con el courier» → «si, hazlo así»).
// GF Courier ya lo asignó a un motorizado para la ruta de hoy: sale de Programados (y de Nuevos) y va a «Con el courier ·
// Asignado hoy». Retirado de la carga, o asignado para otro día, sigue en Programados. Datos FICTICIOS.
import { describe, expect, it } from "vitest";
import {
  boardMatches,
  classifyLimaRows,
  courierRouteText,
  gfAssignedToday,
  limaBoardCounts,
  limaNextStep,
  limaNextStepIsInfo,
  LIMA_COURIER_CARDS,
  LIMA_STEP_PARTS,
} from "@/lib/repro-lima-blocks";
import { gfAssignedFromEvents, type GfStageEvent } from "@/lib/lima-rider-suggest";
import { gfWebhookNote } from "@/lib/gf-webhook-note";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";

const TODAY = "2026-11-27";
const TOMORROW = "2026-11-28";

const base = (over: Partial<LimaPendingOrder> = {}): LimaPendingOrder => ({
  orderId: "o", storeId: "kenku", storeName: "Kenku", orderName: "#KP0001", customerName: "Clienta FICTICIA", customerPhone: null,
  district: "Callao", orderTotal: 119, createdAt: "2026-11-24T10:00:00Z", macroSince: "2026-11-25T17:22:38Z",
  stage: "preparacion", substage: "por_generar_rotulo", courier: null, dispatchedAt: null, attempts: 0,
  hasPriorDispatch: false, lastDepartureAt: null, dispatchedWith: [], programmedFor: null, salesChannel: null, address: null, reference: null,
  management: { hasCall: true, lastCallAt: "2026-11-26T15:00:00Z", lastCallResult: null, movedToLimaAt: null }, ...over,
});

/** Como #KP208991: salió el 25/11, «No contesta», volvió al almacén y GF lo pasó al 27/11 con la misma guía. */
const reprogrammed = (over: Partial<LimaPendingOrder> = {}) => base({
  stage: "en_curso", substage: "en_transito", courier: "gf_courier", dispatchedAt: "2026-11-25T17:22:38Z", attempts: 1,
  hasPriorDispatch: true, lastDepartureAt: "2026-11-25T17:22:38Z", dispatchedWith: ["gf_courier"],
  gfRescheduled: { date: TODAY }, courierPickup: { courier: "gf_courier", date: TODAY },
  ops: { liveCouriers: ["gf_courier"], custody: "courier", reportedStatus: "INCIDENT:NO_ANSWER", courierDelivered: null, lastGfBox: null },
  ...over,
});

const classify = (r: LimaPendingOrder) => classifyLimaRows([r], [], TODAY).get(r.orderId)!;

describe("el reprogramado que GF ya asignó para hoy (#KP208991)", () => {
  it("sin motorizado sigue en Programados · Hoy; asignado para hoy pasa a Con el courier · Asignado hoy", () => {
    const waiting = reprogrammed();
    expect(classify(waiting)).toMatchObject({ step: "programados", agenda: "hoy", courier: "guia_creada" });

    const assigned = reprogrammed({ gfAssigned: { rider: "Yordani", day: "27/11", routeDate: TODAY } });
    const before = JSON.stringify(assigned);
    const cls = classify(assigned);
    expect(cls).toMatchObject({ step: "con_courier", courier: "asignado_hoy", task: null, agendaDay: TODAY, noReport: false });
    expect(boardMatches(cls, "asignado_hoy")).toBe(true);
    expect(boardMatches(cls, "programados")).toBe(false);
    expect(boardMatches(cls, "hoy")).toBe(false);
    expect(courierRouteText(assigned, cls, TODAY)).toEqual({ day: "Hoy", detail: "Asignado a Yordani", overdue: false });
    expect(limaNextStep(assigned, undefined, cls, TODAY)).toBe("GF Courier ya lo asignó a Yordani para la ruta de hoy: sale cuando lo reciba. Solo seguimiento.");
    expect(limaNextStepIsInfo(assigned, cls, TODAY)).toBe(true);
    expect(JSON.stringify(assigned)).toBe(before);

    const counts = limaBoardCounts([waiting, { ...assigned, orderId: "a" }], classifyLimaRows([waiting, { ...assigned, orderId: "a" }], [], TODAY));
    expect(counts.step).toMatchObject({ programados: 1, con_courier: 1 });
    expect(counts.courier).toMatchObject({ guia_creada: 0, asignado_hoy: 1 });
    expect(counts.agenda.hoy).toBe(1);
  });

  it("asignado para otro día, o de una ruta que ya pasó, no es «Asignado hoy»", () => {
    expect(classify(reprogrammed({ gfAssigned: { rider: "Yordani", day: "28/11", routeDate: TOMORROW } })).step).toBe("programados");
    expect(classify(reprogrammed({ gfAssigned: { rider: "Yordani", day: "25/11", routeDate: "2026-11-25" } })).step).toBe("programados");
  });

  it("lo que manda en Repro Lima sigue mandando: Llamar después y Por cerrar", () => {
    const assigned = reprogrammed({ gfAssigned: { rider: "Yordani", day: "27/11", routeDate: TODAY } });
    expect(classifyLimaRows([assigned], [{ orderId: "o", list: "llamar_despues" }], TODAY).get("o")!.step).toBe("llamar_despues");
    expect(classifyLimaRows([assigned], [{ orderId: "o", list: "cerrados" }], TODAY).get("o")!.step).toBe("por_cerrar");
  });
});

describe("la primera salida con guía GF automática asignada para hoy", () => {
  const fresh = (over: Partial<LimaPendingOrder> = {}) => base({
    stage: "por_despachar", substage: "listo_para_recojo", courier: "gf_courier",
    management: { hasCall: false, lastCallAt: null, lastCallResult: null, movedToLimaAt: null },
    courierPickup: { courier: "gf_courier", date: TODAY },
    ops: { autoGfGuide: true, liveCouriers: ["gf_courier"], custody: "empresa", reportedStatus: "READY_FOR_PICKUP:AWAITING_RIDER", courierDelivered: null, lastGfBox: null },
    ...over,
  });
  it("tampoco es Nuevo: va a Con el courier · Asignado hoy; para mañana, Programados", () => {
    expect(classify(fresh()).step).toBe("nuevos");
    expect(classify(fresh({ gfAssigned: { rider: "Alexis", day: "27/11", routeDate: TODAY } }))).toMatchObject({ step: "con_courier", courier: "asignado_hoy" });
    expect(classify(fresh({ courierPickup: { courier: "gf_courier", date: TOMORROW }, gfAssigned: { rider: "Alexis", day: "28/11", routeDate: TOMORROW } })))
      .toMatchObject({ step: "programados", agenda: "manana", courier: "guia_creada" });
  });
});

describe("«Asignado hoy» en la pantalla", () => {
  it("es una parte de Con el courier, entre Guía creada y En ruta", () => {
    expect(LIMA_STEP_PARTS.con_courier).toEqual(["guia_creada", "asignado_hoy", "en_ruta"]);
    expect(LIMA_COURIER_CARDS.map((c) => c.key)).toEqual(["guia_creada", "asignado_hoy", "en_ruta", "retornando"]);
    expect(LIMA_COURIER_CARDS.find((c) => c.key === "asignado_hoy")!.label).toBe("Asignado hoy");
  });
  it("hoy, por el día de la ruta; sin él, por el «dd/mm» de la fila", () => {
    expect(gfAssignedToday({ rider: "Yordani", day: "27/11", routeDate: TODAY }, TODAY)).toBe(true);
    expect(gfAssignedToday({ rider: "Yordani", day: "27/11", routeDate: TOMORROW }, TODAY)).toBe(false);
    expect(gfAssignedToday({ rider: "Yordani", day: "27/11" }, TODAY)).toBe(true);
    expect(gfAssignedToday({ rider: " ", day: "27/11", routeDate: TODAY }, TODAY)).toBe(false);
    expect(gfAssignedToday(null, TODAY)).toBe(false);
  });
});

describe("el asignado sale del último aviso de GF (gfAssignedFromEvents)", () => {
  const assignedAt = (created: string, rider = "Yordani Peña", route = TODAY, code = "AWAITING_OFFICE_CHECK"): GfStageEvent =>
    ({ type: "order.status_changed", created, received_at: created, stage: { code, rider_name: rider, route_date: route } });
  it("asignado y cotejado: el motorizado, con el día de su ruta", () => {
    expect(gfAssignedFromEvents([assignedAt("2026-11-27T08:37:49-05:00")])).toEqual({ rider: "Yordani", day: "27/11", routeDate: TODAY });
    expect(gfAssignedFromEvents([assignedAt("2026-11-27T08:37:49-05:00"), assignedAt("2026-11-27T09:57:45-05:00", "Yordani Peña", TODAY, "AWAITING_RIDER")]))
      .toEqual({ rider: "Yordani", day: "27/11", routeDate: TODAY });
  });
  it("manda el último aviso, aunque llegue desordenado: retirado de la carga, en reparto o devuelto, nadie", () => {
    const back: GfStageEvent = { type: "order.status_changed", created: "2026-11-27T10:00:00-05:00", stage: { code: "BACK_IN_WAREHOUSE" } };
    expect(gfAssignedFromEvents([back, assignedAt("2026-11-27T08:37:49-05:00")])).toBeNull();
    expect(gfAssignedFromEvents([assignedAt("2026-11-25T08:37:49-05:00"), { type: "order.status_changed", created: "2026-11-25T12:22:38-05:00", stage: null }])).toBeNull();
    expect(gfAssignedFromEvents([assignedAt("2026-11-25T08:37:49-05:00"), { type: "order.returned_to_warehouse", created: "2026-11-26T12:43:23-05:00" }])).toBeNull();
    // El cambio de fecha no dice nada de la asignación: no cuenta.
    expect(gfAssignedFromEvents([assignedAt("2026-11-27T08:37:49-05:00"), { type: "order.delivery_date_changed", created: "2026-11-27T09:00:00-05:00" }]))
      .toMatchObject({ rider: "Yordani" });
    // Otro motorizado después: ese.
    expect(gfAssignedFromEvents([assignedAt("2026-11-27T08:37:49-05:00"), assignedAt("2026-11-27T09:10:00-05:00", "Alexis Ruiz")])?.rider).toBe("Alexis");
    expect(gfAssignedFromEvents([])).toBeNull();
  });
});

describe("la Actividad lo dice cuando GF avisa la asignación del reprogramado", () => {
  it("«asignado a Yordani Peña para la ruta del 27/11», aunque el estado siga en Novedad", () => {
    const note = gfWebhookNote({ type: "order.status_changed", data: {
      status: { code: "INCIDENT", sub_status: "NO_ANSWER", final: false }, previous_status: "INCIDENT",
      stage: { code: "AWAITING_OFFICE_CHECK", name: "Asignado · falta cotejo de oficina", rider_name: "Yordani Peña", route_date: TODAY },
      performed_by: { name: "Yelitza Caracas", role: "GF" },
    } });
    expect(note).toBe("GF Courier: asignado a Yordani Peña para la ruta del 27/11 — por Yelitza Caracas (GF).");
  });
});
