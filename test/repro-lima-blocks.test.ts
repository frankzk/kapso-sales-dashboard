// «Repro Lima» por las tareas del equipo (owner, 15-11-2026; MOM §9.5): las
// reglas puras del «Flujo del día» —seis pasos que suman el total, dos de
// ellos plegados (tercera vuelta)— y de la «Agenda» —Hoy, Mañana, Después y Sin fecha, con o sin
// guía—, con qué acción existente se agenda cada pedido, dónde se ve cada
// trabado (§9.6) y, leídas en el código, las guardas de «Agendar» y «Mover a…»
// y la mudanza de «Sale a reparto» a Grupo GF Courier.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LimaPendingOps, LimaPendingOrder } from "@/lib/repro-lima-pending";
import {
  AGENDAR_QUICK_DAYS,
  AGENDA_NAMED_DAYS,
  LIMA_FOLDED_STEPS,
  LIMA_STEP_CARDS,
  LIMA_SUB_FILTERS,
  LIMA_TASK_CARDS,
  agendaCards,
  agendaDayLabel,
  agendaKeyOf,
  agendaWindow,
  agendarPath,
  agendarQuickDays,
  boardCard,
  boardFilter,
  classifyLimaRow,
  classifyLimaRows,
  courierNovelty,
  courierNowText,
  courierStatusText,
  limaBoardCounts,
  limaBoardRows,
  limaCourierState,
  limaNextStep,
  limaRouteDay,
  limaSuggestedDay,
  hoySinGuiaAlert,
  HOY_SIN_GUIA_ALERT_MINUTE,
  limaStepOf,
  limaTaskOf,
  type BoardCase,
} from "@/lib/repro-lima-blocks";
import { LIMA_STUCK_RULES, isCustomerNovelty, limaStuck, stuckFilter, stuckMovedTo, stuckReasonsOf } from "@/lib/lima-stuck";

vi.mock("@/components/order-master-shared", () => ({ MacroStageDot: () => null }));

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) => text.replace(/\s+/g, " ");

// Domingo 15-11-2026, el día de la decisión.
const TODAY = "2026-11-15";
const WINDOW = agendaWindow(TODAY);

const ops = (over: Partial<LimaPendingOps> = {}): LimaPendingOps => ({ liveCouriers: [], reportedStatus: null, courierDelivered: null, lastGfBox: null, ...over });
const row = (over: Partial<LimaPendingOrder> = {}): LimaPendingOrder => ({
  orderId: "o1", storeId: "a", storeName: "Aurela", orderName: "#AUR1", customerName: "Ana", customerPhone: "51987654321",
  district: "Surco", orderTotal: 149, createdAt: "2026-11-14T15:00:00Z", macroSince: "2026-11-14T15:00:00Z",
  stage: "preparacion", substage: "por_generar_rotulo", courier: null, dispatchedAt: null, attempts: 0,
  hasPriorDispatch: false, lastDepartureAt: null, programmedFor: null, salesChannel: null, address: "Av. Benavides 123", reference: null,
  courierPickup: null, gf: null, scheduledOn: null, ops: null, ...over,
});
const failed = (over: Partial<LimaPendingOrder> = {}) => row({ stage: "en_curso", substage: "por_reprogramar_lima", hasPriorDispatch: true, courier: "propio", ...over });
const caseOf = (over: Partial<BoardCase> = {}): BoardCase => ({ orderId: "o1", list: "por_decidir", ...over });
const cls = (r: LimaPendingOrder, c?: BoardCase) => classifyLimaRow(r, c, TODAY, WINDOW);

describe("«Por gestionar hoy»: una tarea por pedido, la primera que aplica", () => {
  it("las cinco tarjetas, en el orden del owner", () => {
    expect(LIMA_TASK_CARDS.map((c) => c.label)).toEqual(["Confirmar primer despacho", "No entregados", "Novedad del courier", "Llamar después", "Por cerrar"]);
  });

  it("Confirmar primer despacho: antes de salir, nunca salió, sin día y sin guía (los «Nunca salieron» y «Más de 30 días»)", () => {
    expect(limaTaskOf(row())).toBe("primer_despacho");
    expect(limaTaskOf(row({ stage: "por_despachar", substage: "listo_para_asignar", courier: "propio", ops: ops({ liveCouriers: ["propio"] }) }))).toBe("primer_despacho");
    expect(cls(row({ createdAt: "2026-10-01T15:00:00Z" }))).toMatchObject({ task: "primer_despacho", stale: true });
    // Con día, con una salida previa o con la guía de un courier, no.
    expect(limaTaskOf(row({ scheduledOn: "2026-11-17" }))).toBeNull();
    expect(limaTaskOf(row({ programmedFor: "2026-11-12" }))).toBeNull();
    expect(limaTaskOf(row({ hasPriorDispatch: true }))).toBeNull();
    expect(limaTaskOf(row({ stage: "por_despachar", substage: "listo_para_recojo", ops: ops({ liveCouriers: ["gf_courier"] }) }))).toBeNull();
    expect(limaTaskOf(row({ courierPickup: { courier: "aliclik", date: "2026-11-16" } }))).toBeNull();
  });

  it("No entregados: «Por reprogramar Lima» sin fecha acordada; con acuerdo vigente, a la Agenda", () => {
    expect(limaTaskOf(failed())).toBe("no_entregados");
    expect(limaTaskOf(failed(), caseOf())).toBe("no_entregados");
    expect(limaTaskOf(failed(), caseOf({ list: "programados", agreement: { agreedOn: "2026-11-17", courier: "propio" } }))).toBeNull();
    // Con su día acordado sale de No entregados: queda por sacar a reparto, en la Agenda (el mar 17 es «Después»), y sin guía todavía.
    expect(cls(failed(), caseOf({ list: "programados", agreement: { agreedOn: "2026-11-17", courier: "propio" } }))).toMatchObject({ task: null, step: "por_sacar", agenda: "despues", agendaDay: "2026-11-17", agreed: true, guide: false });
  });

  it("los reintentos por Aliclik van dentro de No entregados, aunque se haya pedido llamar después", () => {
    const chain = caseOf({ list: "llamar_despues", retryChain: { attempt: 2, of: 3 } });
    expect(cls(failed(), chain)).toMatchObject({ task: "no_entregados", retry: true });
    expect(limaTaskOf(failed(), caseOf({ list: "llamar_despues" }))).toBe("llamar_despues");
  });

  it("Novedad del courier: la guía sigue viva y el courier reporta un problema con la clienta (GF Courier, §29.17)", () => {
    const gfIncident = failed({ courier: "gf_courier", ops: ops({ liveCouriers: ["gf_courier"], reportedStatus: "INCIDENT:NO_ANSWER" }) });
    expect(courierNovelty(gfIncident)).toBe(true);
    expect(limaTaskOf(gfIncident)).toBe("novedad");
    expect(limaTaskOf(row({ stage: "en_curso", substage: "en_reparto", courier: "aliclik", ops: ops({ liveCouriers: ["aliclik"], reportedStatus: "NOT_RESPOND" }) }))).toBe("novedad");
    // «Pidió otra fecha» lo reprograma el courier; el retorno y Grupo GF no son novedad del courier.
    expect(limaTaskOf(failed({ courier: "gf_courier", ops: ops({ liveCouriers: ["gf_courier"], reportedStatus: "INCIDENT:RESCHEDULE_REQUESTED" }) }))).toBe("no_entregados");
    expect(courierNovelty(row({ stage: "en_curso", substage: "en_retorno", ops: ops({ liveCouriers: ["aliclik"], reportedStatus: "REFUSED" }) }))).toBe(false);
    expect(courierNovelty(row({ stage: "en_curso", substage: "en_reparto", courier: "propio", ops: ops({ liveCouriers: ["propio"], reportedStatus: "no contesta" }) }))).toBe(false);
  });

  it("Por cerrar: el courier lo da por entregado y Kapta no cerró, o «Desarmar y cerrar» espera la anulación; gana a todo", () => {
    const tanders = row({ stage: "en_curso", substage: "en_transito", courier: "tanders", ops: ops({ liveCouriers: ["tanders"], reportedStatus: "DELIVERED", courierDelivered: { courier: "tanders" } }) });
    expect(limaTaskOf(tanders)).toBe("por_cerrar");
    expect(cls(failed(), caseOf({ list: "cerrados" }))).toMatchObject({ task: "por_cerrar", awaitingCancel: true });
    expect(limaTaskOf(failed({ ops: ops({ courierDelivered: { courier: "aliclik" } }) }), caseOf({ list: "llamar_despues", retryChain: {} }))).toBe("por_cerrar");
  });
});

describe("«En manos del courier»: solo seguimiento, por su estado", () => {
  it("guía creada antes de salir; en ruta en curso; retornando al volver", () => {
    expect(limaCourierState(row({ stage: "por_despachar", substage: "listo_para_recojo", ops: ops({ liveCouriers: ["gf_courier"], reportedStatus: "READY_FOR_PICKUP" }) }))).toBe("guia_creada");
    expect(limaCourierState(row({ stage: "por_despachar", substage: "listo_para_recojo", courierPickup: { courier: "aliclik", date: "2026-11-16" } }))).toBe("guia_creada");
    expect(limaCourierState(row({ stage: "en_curso", substage: "en_reparto", courier: "propio", ops: ops({ liveCouriers: ["propio"] }) }))).toBe("en_ruta");
    expect(limaCourierState(row({ stage: "en_curso", substage: "en_retorno", courier: "aliclik" }))).toBe("retornando");
    expect(limaCourierState(failed({ ops: ops({ liveCouriers: ["gf_courier"], reportedStatus: "RETURNING" }) }))).toBe("retornando");
  });

  it("la salida propia o la «por definir» antes de salir no es una guía de courier; un no entregado sin guía viva, tampoco", () => {
    expect(limaCourierState(row({ stage: "por_despachar", substage: "listo_para_asignar", ops: ops({ liveCouriers: ["por_definir"] }) }))).toBeNull();
    expect(limaCourierState(failed())).toBeNull();
    expect(limaCourierState(failed({ ops: ops({ liveCouriers: ["gf_courier"], reportedStatus: "INCIDENT:NO_ANSWER" }) }))).toBe("en_ruta");
  });

  it("qué pasa con el courier, dicho con palabras", () => {
    expect(courierStatusText("INCIDENT:CUSTOMER_ABSENT")).toBe("Incidencia: no estaba");
    expect(courierStatusText("DELIVERED · PICKED · CONFIRMED")).toBe("DELIVERED · PICKED · CONFIRMED");
    expect(courierStatusText(null)).toBeNull();
    expect(courierNowText(row({ stage: "en_curso", substage: "en_reparto", courier: "gf_courier", ops: ops({ liveCouriers: ["gf_courier"], reportedStatus: "OUT_FOR_DELIVERY" }) }))).toBe("GF Courier · En reparto");
    expect(courierNowText(row({ stage: "en_curso", substage: "en_reparto", courier: "propio", courierDetail: "Alexis", ops: ops({ liveCouriers: ["propio"] }) }))).toBe("Grupo GF · Alexis");
    expect(courierNowText(row())).toBeNull();
  });
});

describe("«Agenda»: Hoy, Mañana, Después y Sin fecha (owner, 15-11-2026: «lo del martes al viernes, ponlo dentro de Después»)", () => {
  it("«Mañana» es el próximo día de reparto; el sábado llega hasta el lunes (el domingo no se reparte)", () => {
    expect(AGENDA_NAMED_DAYS).toBe(1);
    expect(agendaWindow(TODAY)).toEqual(["2026-11-16"]);
    expect(agendaWindow("2026-11-14")).toEqual(["2026-11-15", "2026-11-16"]);
    expect(agendaWindow("2026-11-16")).toEqual(["2026-11-17"]);
    expect(agendaDayLabel("2026-11-16")).toBe("Lun 16");
    expect(agendaDayLabel("2026-11-17")).toBe("Mar 17");
  });

  it("lo vencido sigue en Hoy; el próximo día de reparto, Mañana; de martes a viernes y más allá, Después; sin día, Sin fecha", () => {
    expect(agendaKeyOf("2026-11-12", TODAY, WINDOW)).toBe("hoy");
    expect(agendaKeyOf(TODAY, TODAY, WINDOW)).toBe("hoy");
    expect(agendaKeyOf("2026-11-16", TODAY, WINDOW)).toBe("manana");
    for (const day of ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-12-01"]) expect(agendaKeyOf(day, TODAY, WINDOW), day).toBe("despues");
    expect(agendaKeyOf(null, TODAY, WINDOW)).toBe("sin_fecha");
    // Un sábado, un acuerdo para el domingo o el lunes es «Mañana».
    expect(agendaKeyOf("2026-11-15", "2026-11-14", agendaWindow("2026-11-14"))).toBe("manana");
    expect(agendaKeyOf("2026-11-16", "2026-11-14", agendaWindow("2026-11-14"))).toBe("manana");
    expect(agendaKeyOf("2026-11-17", "2026-11-14", agendaWindow("2026-11-14"))).toBe("despues");
  });

  it("el día: el acuerdo vigente, el programa de Grupo GF, el recojo del courier o «Programar envío», y de dónde sale", () => {
    expect(cls(row({ scheduledOn: "2026-11-17" }))).toMatchObject({ agenda: "despues", agendaDay: "2026-11-17", agendaOrigin: "envio" });
    expect(cls(row({ programmedFor: "2026-11-16", scheduledOn: "2026-11-17" }))).toMatchObject({ agenda: "manana", agendaDay: "2026-11-16", agendaOrigin: "programa" });
    expect(cls(row({ stage: "por_despachar", substage: "listo_para_recojo", courierPickup: { courier: "aliclik", date: "2026-11-18" } }))).toMatchObject({ agenda: "despues", agendaDay: "2026-11-18", agendaOrigin: "recojo", courier: "guia_creada" });
    expect(cls(failed({ programmedFor: "2026-11-16" }), caseOf({ list: "programados", agreement: { agreedOn: "2026-11-19" } }))).toMatchObject({ agenda: "despues", agendaDay: "2026-11-19", agendaOrigin: "acuerdo" });
  });

  it("con guía o sin guía: la guía viva de un courier o el rótulo cuentan; «por generar rótulo» y «por reprogramar Lima» no", () => {
    expect(cls(row({ programmedFor: TODAY })).guide).toBe(false);
    expect(cls(row({ substage: "por_armar", programmedFor: TODAY, ops: ops({ liveCouriers: ["propio"] }) })).guide).toBe(true);
    expect(cls(row({ stage: "por_despachar", substage: "listo_para_recojo", ops: ops({ liveCouriers: ["gf_courier"] }) })).guide).toBe(true);
    expect(cls(row({ courierPickup: { courier: "aliclik", date: "2026-11-16" } })).guide).toBe(true);
    expect(cls(failed(), caseOf({ list: "programados", agreement: { agreedOn: TODAY } })).guide).toBe(false);
  });

  it("con el courier, la Agenda solo lo lleva si tiene un día por delante; un día que pasó ya no es una fecha por cumplir", () => {
    expect(cls(row({ stage: "en_curso", substage: "en_reparto", courier: "propio", programmedFor: "2026-11-12", ops: ops({ liveCouriers: ["propio"] }) }))).toMatchObject({ agenda: null, courier: "en_ruta" });
    expect(cls(row({ stage: "por_despachar", substage: "listo_para_recojo", ops: ops({ liveCouriers: ["gf_courier"] }) }))).toMatchObject({ agenda: null, courier: "guia_creada" });
  });

  it("las cuatro tarjetas: Hoy, Mañana (con su día), Después y Sin fecha", () => {
    expect(agendaCards(TODAY).map((c) => c.key)).toEqual(["hoy", "manana", "despues", "sin_fecha"]);
    expect(agendaCards(TODAY).map((c) => c.label)).toEqual(["Hoy", "Mañana · Lun 16", "Después", "Sin fecha"]);
    // Un sábado, «Mañana» es el lunes: se dice el día, no «Mañana».
    expect(agendaCards("2026-11-14").map((c) => c.label)).toEqual(["Hoy", "Lun 16", "Después", "Sin fecha"]);
    expect(agendaCards(TODAY).find((c) => c.key === "despues")?.hint).toBe("Agendados después del lunes 16/11.");
  });
});

describe("los seis pasos suman el total (owner, 15-11-2026: «estos 5 no suman 1,438 pedidos»)", () => {
  const rows = [
    row({ orderId: "a" }),
    row({ orderId: "b", scheduledOn: "2026-11-17" }),
    row({ orderId: "c", stage: "por_despachar", substage: "listo_para_recojo", ops: ops({ liveCouriers: ["gf_courier"] }) }),
    row({ orderId: "d", stage: "en_curso", substage: "en_reparto", courier: "propio", ops: ops({ liveCouriers: ["propio"] }) }),
    failed({ orderId: "e" }),
    failed({ orderId: "f", ops: ops({ liveCouriers: ["gf_courier"], reportedStatus: "INCIDENT:NO_ANSWER" }) }),
    row({ orderId: "g", stage: "en_curso", substage: "en_retorno", courier: "aliclik" }),
    row({ orderId: "h", hasPriorDispatch: true }),
  ];
  const classes = classifyLimaRows(rows, [], TODAY);
  it("cada pedido está en un paso y solo uno; lo que falta sacar está siempre en la Agenda", () => {
    const counts = limaBoardCounts(rows, classes);
    expect(counts.step).toEqual({ novedad: 1, llamar_despues: 0, no_entregados: 1, por_sacar: 3, con_courier: 3, por_cerrar: 0 });
    expect(Object.values(counts.step).reduce((a, b) => a + b, 0)).toBe(counts.todos);
    for (const step of LIMA_STEP_CARDS.map((c) => c.key)) {
      expect(limaBoardRows(rows, classes, step).length, step).toBe(counts.step[step]);
    }
    for (const r of rows) {
      const c = classes.get(r.orderId)!;
      if (c.step === "por_sacar") expect(c.agenda, r.orderId).not.toBeNull();
    }
    expect(counts.task).toEqual({ primer_despacho: 1, no_entregados: 1, novedad: 1, llamar_despues: 0, por_cerrar: 0 });
    // Los filtros de adentro de «Con el courier» suman ese paso: la novedad (f) está en su propio paso.
    expect(counts.courier).toEqual({ guia_creada: 1, en_ruta: 1, retornando: 1 });
    expect(counts.courier.guia_creada + counts.courier.en_ruta + counts.courier.retornando).toBe(counts.step.con_courier);
    expect(limaBoardRows(rows, classes, "en_ruta").map((r) => r.orderId)).toEqual(["d"]);
    expect(counts.agenda).toEqual({ hoy: 0, manana: 0, despues: 1, sin_fecha: 2 });
  });
  it("en Todos, por paso: la novedad, lo que tiene hora, lo que falló, lo que falta sacar (por su día) y lo del courier", () => {
    expect(limaBoardRows(rows, classes, "todos").map((r) => r.orderId)).toEqual(["f", "e", "b", "a", "h", "c", "d", "g"]);
  });
  it("«Por cerrar» y «Con el courier» van plegados al final, pero cuentan: sin ellos la suma no cierra (owner, 15-11-2026)", () => {
    expect(LIMA_STEP_CARDS.map((c) => c.label)).toEqual(["Novedad del courier", "Llamar después", "No entregados", "Sacar a reparto", "Con el courier", "Por cerrar"]);
    expect([...LIMA_FOLDED_STEPS]).toEqual(["con_courier", "por_cerrar"]);
    expect(limaStepOf("por_cerrar", "en_ruta")).toBe("por_cerrar");
    expect(limaStepOf("por_cerrar", null)).toBe("por_cerrar");
    expect(limaStepOf("primer_despacho", null)).toBe("por_sacar");
    expect(limaStepOf(null, null)).toBe("por_sacar");
    expect(limaStepOf(null, "guia_creada")).toBe("con_courier");
    expect(limaStepOf("novedad", "en_ruta")).toBe("novedad");
    const tanders = row({ stage: "en_curso", substage: "en_transito", courier: "tanders", ops: ops({ liveCouriers: ["tanders"], reportedStatus: "DELIVERED", courierDelivered: { courier: "tanders" } }) });
    expect(cls(tanders)).toMatchObject({ task: "por_cerrar", step: "por_cerrar", courier: "en_ruta" });
    expect(cls(failed(), caseOf({ list: "cerrados" }))).toMatchObject({ task: "por_cerrar", step: "por_cerrar", awaitingCancel: true });
    const both = [tanders, failed({ orderId: "x" }), row({ orderId: "y" })];
    const bc = limaBoardCounts(both, classifyLimaRows(both, [{ orderId: "x", list: "cerrados" }], TODAY));
    expect(bc.step).toMatchObject({ por_cerrar: 2, por_sacar: 1 });
    expect(Object.values(bc.step).reduce((a, b) => a + b, 0)).toBe(bc.todos);
  });
  it("ruta vencida sin reporte: un día de reparto entero después del día de la ruta, ya no está con el courier, es un no entregado (owner, 15-11-2026)", () => {
    const at = (r: LimaPendingOrder, day: string) => classifyLimaRow(r, undefined, day, agendaWindow(day));
    // Grupo GF: salió el lunes 16 en la caja de Alexis.
    const gf = row({ stage: "en_curso", substage: "en_reparto", courier: "propio", macroSince: "2026-11-16T14:00:00Z", ops: ops({ liveCouriers: ["propio"], lastGfBox: { day: "2026-11-16", riderName: "Alexis" } }) });
    expect(limaRouteDay(gf)).toBe("2026-11-16");
    expect(at(gf, "2026-11-17")).toMatchObject({ step: "con_courier", noReport: false, courier: "en_ruta" });
    expect(at(gf, "2026-11-18")).toMatchObject({ step: "no_entregados", task: "no_entregados", noReport: true, routeDay: "2026-11-16" });
    expect(limaNextStep(gf, undefined, at(gf, "2026-11-18"), "2026-11-18")).toBe("Salió a ruta el lun 16/11 y el motorizado Alexis no reportó el resultado: se cuenta como no entregado. Pide el reporte; si no se entregó, acuerda el nuevo día con la clienta (Atender).");
    // El domingo no cuenta: salió el sábado 14; el lunes 16 todavía espera, el martes 17 ya no.
    const sat = row({ stage: "en_curso", substage: "en_transito", courier: "gf_courier", dispatchedAt: "2026-11-14T15:00:00Z", macroSince: "2026-11-14T15:00:00Z", ops: ops({ liveCouriers: ["gf_courier"], reportedStatus: "OUT_FOR_DELIVERY" }) });
    expect(at(sat, "2026-11-16").noReport).toBe(false);
    expect(at(sat, "2026-11-17")).toMatchObject({ noReport: true, step: "no_entregados" });
    expect(limaNextStep(sat, undefined, at(sat, "2026-11-17"), "2026-11-17")).toContain("Salió a ruta el sáb 14/11 y GF Courier no reportó el resultado");
    // Una salida nueva manda: el día más reciente es el de la ruta.
    expect(limaRouteDay(row({ ...gf, macroSince: "2026-11-18T14:00:00Z" }))).toBe("2026-11-18");
    expect(at(row({ ...gf, macroSince: "2026-11-18T14:00:00Z" }), "2026-11-18").noReport).toBe(false);
    // Lo que vuelve, lo dado por entregado y la novedad con la clienta siguen su paso.
    expect(at(row({ ...gf, substage: "en_retorno" }), "2026-11-20")).toMatchObject({ noReport: false, step: "con_courier", courier: "retornando" });
    expect(at(row({ ...gf, ops: ops({ liveCouriers: ["tanders"], reportedStatus: "DELIVERED", courierDelivered: { courier: "tanders" } }) }), "2026-11-20")).toMatchObject({ noReport: false, step: "por_cerrar" });
    expect(at(row({ ...sat, ops: ops({ liveCouriers: ["gf_courier"], reportedStatus: "INCIDENT:NO_ANSWER" }) }), "2026-11-20")).toMatchObject({ noReport: false, step: "novedad" });
    // Su filtro vive dentro de No entregados, y los pasos siguen sumando el total.
    const list = [gf, sat, row({ orderId: "z" })].map((r, i) => ({ ...r, orderId: `r${i}` }));
    const c = classifyLimaRows(list, [], "2026-11-18");
    const counts = limaBoardCounts(list, c);
    expect(counts.sub.sin_reporte).toBe(2);
    expect(counts.step).toMatchObject({ no_entregados: 2, con_courier: 0, por_sacar: 1 });
    expect(limaBoardRows(list, c, "sin_reporte").map((r) => r.orderId).sort()).toEqual(["r0", "r1"]);
    expect(LIMA_SUB_FILTERS.sin_reporte).toMatchObject({ parent: "no_entregados", label: "Sin reporte de la ruta" });
    expect(boardFilter("sin_reporte", TODAY)).toBe("sin_reporte");
  });
  it("Hoy y Mañana dicen cuántos tienen guía; los que no son una alerta con su filtro", () => {
    const day = [
      row({ orderId: "hoy-sin", programmedFor: TODAY }),
      row({ orderId: "vencido-sin", programmedFor: "2026-11-12" }),
      row({ orderId: "hoy-rotulo", substage: "por_armar", programmedFor: TODAY, ops: ops({ liveCouriers: ["propio"] }) }),
      row({ orderId: "manana-sin", scheduledOn: "2026-11-16" }),
      row({ orderId: "manana-guia", stage: "por_despachar", substage: "listo_para_recojo", courierPickup: { courier: "aliclik", date: "2026-11-16" } }),
      row({ orderId: "despues-sin", scheduledOn: "2026-11-18" }),
    ];
    const c = classifyLimaRows(day, [], TODAY);
    const counts = limaBoardCounts(day, c);
    expect(counts.agenda).toMatchObject({ hoy: 3, manana: 2, despues: 1 });
    expect(counts.sub).toMatchObject({ hoy_sin_guia: 2, manana_sin_guia: 1 });
    expect(limaBoardRows(day, c, "hoy_sin_guia").map((r) => r.orderId)).toEqual(["vencido-sin", "hoy-sin"]);
    expect(limaBoardRows(day, c, "manana_sin_guia").map((r) => r.orderId)).toEqual(["manana-sin"]);
    // La guía de Aliclik para mañana está con el courier, y en la Agenda de mañana.
    expect(c.get("manana-guia")).toMatchObject({ step: "con_courier", agenda: "manana", guide: true });
    const now = new Date("2026-11-15T16:00:00Z");
    const next = (id: string) => limaNextStep(day.find((r) => r.orderId === id)!, undefined, c.get(id)!, TODAY, now);
    expect(next("hoy-sin")).toBe("Sale hoy y no tiene guía ni rótulo: créala desde la Mesa de ruta para que salga.");
    expect(next("vencido-sin")).toBe("Debía salir el jue 12/11 y no tiene guía ni rótulo: créala hoy desde la Mesa de ruta o reagéndalo.");
    expect(next("manana-sin")).toBe("Sale mañana y no tiene guía ni rótulo: genérala hoy.");
    expect(next("hoy-rotulo")).toBe("Sale hoy.");
  });
  it("No entregados sigue el orden de los casos (`sortRepro`)", () => {
    const two = [failed({ orderId: "x" }), failed({ orderId: "y" })];
    const c2 = classifyLimaRows(two, [], TODAY);
    expect(limaBoardRows(two, c2, "no_entregados", new Map([["y", 0], ["x", 1]])).map((r) => r.orderId)).toEqual(["y", "x"]);
  });
});

describe("el filtro de la URL (`atencion`)", () => {
  it("las claves nuevas pasan; un día que pasó abre Hoy; lo desconocido, Todos", () => {
    for (const key of ["novedad", "llamar_despues", "no_entregados", "por_sacar", "con_courier", "por_cerrar", "guia_creada", "en_ruta", "retornando", "hoy", "manana", "despues", "sin_fecha", "reprogramados", "esperan_anulacion", "reintentos_aliclik", "mas_de_30", "hoy_sin_guia", "manana_sin_guia"]) {
      expect(boardFilter(key, TODAY)).toBe(key);
    }
    // «Confirmar primer despacho» de antes abre Sacar a reparto.
    expect(boardFilter("primer_despacho", TODAY)).toBe("por_sacar");
    // Un día guardado de la Agenda anterior abre su cajón de ahora.
    expect(boardFilter("2026-11-16", TODAY)).toBe("manana");
    expect(boardFilter("2026-11-18", TODAY)).toBe("despues");
    expect(boardFilter("2026-11-10", TODAY)).toBe("hoy");
    expect(boardFilter("2026-13-45", TODAY)).toBe("todos");
    expect(boardFilter("DROP", TODAY)).toBe("todos");
  });
  it("cada clave tiene su título y su vacío para la lista", () => {
    expect(boardCard("no_entregados", TODAY)).toMatchObject({ label: "No entregados", block: "gestion" });
    expect(boardCard("por_sacar", TODAY)).toMatchObject({ label: "Sacar a reparto", block: "gestion" });
    expect(boardCard("con_courier", TODAY)).toMatchObject({ label: "Con el courier", block: "gestion" });
    expect(boardCard("por_cerrar", TODAY)).toMatchObject({ label: "Por cerrar", block: "gestion" });
    expect(boardCard("manana", TODAY)).toMatchObject({ label: "Mañana · Lun 16", block: "agenda" });
    expect(boardCard("hoy_sin_guia", TODAY)).toMatchObject({ label: "Hoy sin guía", block: "agenda" });
    expect(boardCard("reintentos_aliclik", TODAY)).toMatchObject({ label: "Reintentos Aliclik", block: "gestion" });
    expect(boardCard("2026-11-17", TODAY)).toMatchObject({ label: "Mar 17", block: "agenda" });
    expect(boardCard("2026-12-01", TODAY)?.empty).toBe("No hay pedidos agendados para el mar 01/12 con estos filtros.");
    expect(boardCard("en_ruta", TODAY)).toMatchObject({ block: "courier" });
    expect(boardCard("todos", TODAY)).toBeNull();
  });
});

describe("el próximo paso de la fila", () => {
  const now = new Date("2026-11-15T16:00:00Z");
  it("dice qué toca por su tarea, su día o su courier", () => {
    expect(limaNextStep(row(), undefined, cls(row()), TODAY, now)).toBe("Sacarlo a reparto: Kapta sugiere el lun 16/11. Confírmalo (y los datos con la clienta si hace falta).");
    const sinDia = row({ hasPriorDispatch: true });
    expect(limaNextStep(sinDia, undefined, cls(sinDia), TODAY, now)).toBe("Sin día: Kapta sugiere el lun 16/11 para que salga.");
    expect(limaNextStep(failed(), undefined, cls(failed()), TODAY, now)).toBe("Llamar a la clienta y acordar el día y el courier (Atender).");
    const llamar = caseOf({ list: "llamar_despues", nextCallAt: "2026-11-15T20:00:00Z" });
    expect(limaNextStep(failed(), llamar, cls(failed(), llamar), TODAY, now)).toBe("Llamar hoy 15:00.");
    const b = row({ scheduledOn: "2026-11-17" });
    expect(limaNextStep(b, undefined, cls(b), TODAY, now)).toBe("Sale el mar 17/11. Sin gestión salvo que la clienta cambie algo.");
    const vencido = row({ substage: "por_armar", programmedFor: "2026-11-12", hasPriorDispatch: true, ops: ops({ liveCouriers: ["propio"] }) });
    expect(limaNextStep(vencido, undefined, cls(vencido), TODAY, now)).toBe("Debía salir el jue 12/11: revisa por qué no salió y reagéndalo.");
    const gf = row({ stage: "en_curso", substage: "en_reparto", courier: "gf_courier", ops: ops({ liveCouriers: ["gf_courier"] }) });
    expect(limaNextStep(gf, undefined, cls(gf), TODAY, now)).toBe("Solo seguimiento: lo tiene GF Courier.");
  });
});

describe("«Agendar»: con qué acción existente se pone el día", () => {
  const can = { canScheduleDispatch: true };
  it("con un acuerdo con la clienta, se cambia su día con el mismo courier (aunque esté vencido)", () => {
    expect(agendarPath(failed(), caseOf({ list: "programados", agreement: { agreedOn: "2026-11-17", courier: "propio", courierName: "Grupo GF" } }), can))
      .toEqual({ kind: "acuerdo", current: "2026-11-17", courierName: "Grupo GF", maxDays: 60 });
    expect(agendarPath(failed(), caseOf({ list: "por_decidir", agreement: { agreedOn: "2026-11-12", courier: "aliclik", courierName: "Aliclik" } }), can).kind).toBe("acuerdo");
  });
  it("sin acuerdo y sin rótulo, «Programar envío» (§6.2), solo con su permiso", () => {
    expect(agendarPath(row({ scheduledOn: "2026-11-17" }), undefined, can)).toEqual({ kind: "envio", current: "2026-11-17", maxDays: 45 });
    expect(agendarPath(row(), undefined, { canScheduleDispatch: false })).toEqual({ kind: null, why: "Tu rol no permite programar envíos." });
  });
  it("un no entregado sin acuerdo se acuerda en «Atender»; con guía, el día lo lleva el courier; con otra persona, no se toma", () => {
    expect(agendarPath(failed(), caseOf(), can)).toEqual({ kind: null, why: "Primero acuerda el día y el courier con la clienta en «Atender»." });
    expect(agendarPath(row({ stage: "por_despachar", substage: "listo_para_recojo", ops: ops({ liveCouriers: ["gf_courier"] }) }), undefined, can).kind).toBeNull();
    expect(agendarPath(row({ stage: "preparacion", substage: "por_armar", ops: ops({ liveCouriers: ["propio"] }) }), undefined, can)).toEqual({ kind: null, why: "Ya tiene rótulo: acuerda el día con la clienta en «Atender»." });
    expect(agendarPath(failed(), caseOf({ claim: { view: "otro", byName: "Diana" }, agreement: { agreedOn: "2026-11-17" } }), can)).toEqual({ kind: null, why: "Diana lo está atendiendo." });
    expect(agendarPath(failed(), caseOf({ list: "cerrados" }), can).kind).toBeNull();
  });
  it("Kapta propone el próximo día de reparto a lo que no tiene día; el equipo lo confirma (owner, 15-11-2026)", () => {
    expect(limaSuggestedDay(TODAY)).toBe("2026-11-16");
    expect(limaSuggestedDay("2026-11-14")).toBe("2026-11-16"); // el sábado, el lunes
    expect(limaSuggestedDay("2026-11-16")).toBe("2026-11-17");
  });
  it("«Hoy sin guía» es alerta desde las 10:30 de Lima; antes, se cuenta sin alarmar", () => {
    expect(HOY_SIN_GUIA_ALERT_MINUTE).toBe(630);
    expect(hoySinGuiaAlert(new Date("2026-11-15T15:29:00Z"))).toBe(false); // 10:29 en Lima
    expect(hoySinGuiaAlert(new Date("2026-11-15T15:30:00Z"))).toBe(true); // 10:30
    const hoy = row({ programmedFor: TODAY });
    expect(limaNextStep(hoy, undefined, cls(hoy), TODAY, new Date("2026-11-15T14:00:00Z"))).toBe("Sale hoy y todavía no tiene guía ni rótulo: si a las 10:30 no la tiene, créala desde la Mesa de ruta.");
    expect(limaNextStep(hoy, undefined, cls(hoy), TODAY, new Date("2026-11-15T16:00:00Z"))).toBe("Sale hoy y no tiene guía ni rótulo: créala desde la Mesa de ruta para que salga.");
  });
  it("los días que ofrece: hoy y los cinco próximos días de reparto (no cambia con la Agenda de cuatro cajones)", () => {
    expect(AGENDAR_QUICK_DAYS).toBe(5);
    expect(agendarQuickDays("2026-11-14")).toEqual(["2026-11-14", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
  });
});

describe("cada trabado tiene su sitio (§9.6, owner 15-11-2026)", () => {
  it("lo de las cajas y los motorizados de Grupo GF va a Despacho del día; lo del equipo se queda en Repro Lima", () => {
    expect(stuckReasonsOf("grupo_gf")).toEqual(["armado_sin_caja", "tomado_sin_caja", "caja_vencida", "sin_condiciones_gf", "reparto_sin_resultado"]);
    expect(stuckReasonsOf("courier")).toEqual(["courier_no_recogio", "courier_sin_resultado", "retorno_sin_recibir"]);
    expect(stuckReasonsOf("gestion")).toEqual(["entregado_sin_cierre", "novedad_con_clienta", "sin_rotulo", "rotulo_sin_armar", "incidencia_sin_resolver", "sin_rotulo_antiguo"]);
    // Ninguno sin sitio ni en dos.
    const all = [...stuckReasonsOf("grupo_gf"), ...stuckReasonsOf("courier"), ...stuckReasonsOf("gestion")];
    expect(new Set(all).size).toBe(LIMA_STUCK_RULES.length);
  });
  it("un enlace guardado con un motivo de Grupo GF no filtra en Repro Lima y dice a dónde se fue", () => {
    const team = ["gestion", "courier"] as const;
    expect(stuckFilter("armado_sin_caja", team)).toBeNull();
    expect(stuckMovedTo("armado_sin_caja", team)).toEqual({ reason: "armado_sin_caja", home: "grupo_gf" });
    expect(stuckFilter("courier_no_recogio", team)).toBe("courier_no_recogio");
    expect(stuckMovedTo("courier_no_recogio", team)).toBeNull();
    expect(stuckFilter("todos", team)).toBe("todos");
    // Sin pantalla, como antes.
    expect(stuckFilter("armado_sin_caja")).toBe("armado_sin_caja");
  });
  it("GF Courier dice la novedad con sus códigos; «pidió otra fecha» no lo es", () => {
    for (const code of ["INCIDENT:NO_ANSWER", "INCIDENT:CUSTOMER_ABSENT", "INCIDENT:WRONG_ADDRESS", "REFUSED", "NOT_RESPOND", "no contesta"]) expect(isCustomerNovelty(code), code).toBe(true);
    for (const code of ["INCIDENT:RESCHEDULE_REQUESTED", "OUT_FOR_DELIVERY", "RETURNING", null]) expect(isCustomerNovelty(code), String(code)).toBe(false);
    const gf = row({ stage: "en_curso", substage: "en_reparto", courier: "gf_courier", macroSince: "2026-11-10T15:00:00Z", ops: ops({ liveCouriers: ["gf_courier"], reportedStatus: "INCIDENT:NO_ANSWER" }) });
    expect(limaStuck(gf, TODAY)?.reason).toBe("novedad_con_clienta");
  });
});

describe("las piezas en pantalla", () => {
  it("el flujo del día numera los pasos en el orden del trabajo y lo de adentro va dentro de su paso", async () => {
    const { ReproLimaBlocks, LIMA_FLOW } = await import("@/components/repro-lima-blocks");
    // Owner, 15-11-2026: «falta ordenar un flujo de trabajo»; de lo que está en la calle a lo que solo falta cerrar.
    // Tercera vuelta: «Sacar a reparto» en vez de «Confirmar primer despacho», y lo que solo se mira, plegado al final.
    expect(LIMA_FLOW.map((step) => step.key)).toEqual(["novedad", "llamar_despues", "no_entregados", "por_sacar", "con_courier", "por_cerrar"]);
    const rows = [row(), failed({ orderId: "e" }), row({ orderId: "h", programmedFor: TODAY })];
    const counts = limaBoardCounts(rows, classifyLimaRows(rows, [], TODAY));
    const html = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts, today: TODAY, active: "no_entregados", onPick: () => {} }));
    for (const text of ["Flujo del día", "los seis suman el total", "Agenda", "Sacar a reparto", "Con el courier", "Por cerrar", "Mañana · Lun 16", "Después", "Sin fecha", "Hoy sin guía", "0 con guía"]) expect(html, text).toContain(text);
    for (const text of ["En manos del courier", "Confirmar primer despacho", "Mar 17"]) expect(html, text).not.toContain(text);
    // Antes de las 10:30, «Hoy sin guía» es un chip neutro; después, una alerta.
    const early = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts, today: TODAY, active: "todos", onPick: () => {}, guideAlert: false }));
    expect(early).toContain("Es alerta desde las 10:30.");
    expect(html).not.toContain("Es alerta desde las 10:30.");
    // La barra de reparto cierra con el total: los tramos en el orden de las celdas.
    expect(html).toContain(`= <b class="font-semibold text-ink-900">${counts.todos}</b> pedidos`);
    // Los plegados no llevan número de paso: solo los cuatro del trabajo.
    expect(html.match(/size-5 shrink-0 place-items-center rounded-full/g)).toHaveLength(4);
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*No entregados/);
    // «Reintentos Aliclik» vive DENTRO de «No entregados»: su filtro sale en el pie con el nombre del paso, no suelto.
    expect(html).toContain("Dentro de <b");
    expect(html).toContain("Reintentos Aliclik");
    // Sin un paso elegido, no hay chips de adentro sueltos debajo de la fila.
    const idle = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts, today: TODAY, active: "todos", onPick: () => {} }));
    expect(idle).not.toContain("Dentro de");
    expect(idle).toContain("Empieza aquí");
  });

  it("el total y los trabados van arriba, como excepción, no mezclados con las tarjetas", () => {
    const board = read("components/repro-lima-board.tsx");
    expect(board).toContain("pedidos de Lima por entregar");
    expect(board).toContain('label="Trabados"');
    expect(board).toContain('aria-label="Trabados por motivo"');
    expect(board).toContain('label="Etapa"');
    expect(board).not.toContain('label="Solo trabados"');
  });
});

describe("las guardas, en el código", () => {
  const agenda = read("app/dashboard/pedidos/repro-lima/agenda-actions.ts");
  const actions = read("app/dashboard/pedidos/repro-lima/actions.ts");
  const board = read("components/repro-lima-board.tsx");
  const page = read("app/dashboard/pedidos/repro-lima/page.tsx");
  const body = (src: string, signature: string) => {
    const start = src.indexOf(signature);
    expect(start, signature).toBeGreaterThanOrEqual(0);
    const next = src.indexOf("\nexport ", start + signature.length);
    return src.slice(start, next === -1 ? undefined : next);
  };

  it("«Agendar» pide Repro Lima antes de leer nada y no escribe por su cuenta: reusa «Programar envío» y el acuerdo", () => {
    expect(agenda.startsWith('"use server";')).toBe(true);
    expect([...agenda.matchAll(/^export async function (\w+)\(/gm)].map((m) => m[1])).toEqual(["agendarReproLima"]);
    expect(agenda).not.toMatch(/^export (const|let|class) /m);
    const fn = body(agenda, "export async function agendarReproLima(");
    expect(fn.indexOf("await requireReproLima()")).toBeGreaterThan(-1);
    expect(fn.indexOf("await requireReproLima()")).toBeLessThan(fn.indexOf("createAdminSupabase()"));
    expect(fn).toContain("if (!scope.storeIds.has(f.storeId)) return { error: REPRO_OUTSIDE_STORE };");
    expect(fn).toContain("await moveReproAgreement(");
    expect(fn).toContain("await scheduleOrderDispatch(input.orderId, { date: day, note: input.note ?? null })");
    // Ninguna escritura propia: ni casos, ni programas, ni el Master.
    expect(agenda).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(agenda).not.toContain("writeGfDispatchProgram");
    expect(agenda).not.toContain("dispatch_scheduled_on");
  });

  it("mover un acuerdo es «Confirma fecha» por el mismo camino: candado, acción de la caja y la RPC", () => {
    const fn = body(actions, "export async function moveReproAgreement(");
    expect(fn.indexOf("await requireReproLima()")).toBeLessThan(fn.indexOf("createAdminSupabase()"));
    expect(fn).toContain("const claim = await claimReproCase(input.orderId);");
    expect(fn).toContain("const decided = reproBoxAction({");
    expect(fn).toContain('outcome: "confirma",');
    expect(fn).toContain("return await recordCall(scope, {");
    expect(fn).toContain('if (input.channel !== "llamada" && input.channel !== "whatsapp")');
    expect(fn).toContain("if (!hadClaim) {");
    expect(fn).toContain('.update({ claimed_by: null, claimed_until: null })');
  });

  it("el tablero: «Agendar» y «Atender» en la fila, «Mover a…» en lote con un aviso por motivo, y sin «Sale a reparto»", () => {
    expect(flat(board)).toContain("<AgendarButton row={row} path={path} today={today} size={size}");
    // Sin día, «Agendar» llega con el día que propone Kapta, y en «Sin fecha» un toque los elige a todos para ese día.
    expect(board).toContain("suggested={classes.get(row.orderId)?.agendaDay ? undefined : limaSuggestedDay(today)}");
    expect(board).toContain('(key === "sin_fecha" || key === "por_sacar")');
    expect(board).toContain("setMoveDay(suggestedDay);");
    expect(board).toContain("Elegirlos para el {programDayLabel(suggestedDay)}");
    expect(board).toContain("guideAlert={hoySinGuiaAlert(now)}");
    expect(board).toContain('onClick={() => openDrawer(row.orderId, "reprolima")}>Atender</OpsButton>');
    expect(board).toContain("const result = await agendarReproLima({");
    expect(board).toContain("lines: groupApprovalFailures(failed),");
    // GF Courier no anuló o no creó la guía del día nuevo: el aviso abre su Mesa de ruta (§9.5).
    expect(board).toContain('onClick={() => openDrawer(m.orderId, "operar")}');
    expect(board).toContain('aria-label="Mover a otro día"');
    expect(board).not.toContain("DispatchPlanPanel");
    expect(board).not.toContain("planItems(");
    // Sin `repro_lima.manage` (solo reintentos) no hay Agendar ni Atender.
    expect(board).toContain("if (retriesOnly) return null;");
  });

  it("la página sigue pidiendo Repro Lima con «retries» y solo lee `master.edit` para ofrecer «Programar envío»", () => {
    expect(page).toContain("requireReproLima({ retries: true })");
    expect(page).toContain('canScheduleDispatch = permissions.can("master.edit");');
    expect(page).toContain("canScheduleDispatch={!scope.retriesOnly && canScheduleDispatch}");
  });
});

describe("el MOM, DESIGN.md y DEPLOY.md", () => {
  const mom = flat(read("docs/mom/master-pedidos-v1.md"));
  it("§9.5 cuenta la pantalla por tareas, de dónde sale cada cifra y qué se mudó", () => {
    expect(mom).toContain("#### Repro Lima por las tareas del equipo (owner, 15-11-2026)");
    for (const quote of [
      "«Por gestionar hoy»", "«Agenda»", "«En manos del courier»",
      "`limaTaskOf`", "`classifyLimaRow`", "`agendarPath`", "`agendarReproLima`", "`moveReproAgreement`", "`scheduleOrderDispatch`",
      "«Sale a reparto» y los trabados de las cajas y los motorizados de Grupo GF se mudaron a Grupo GF Courier → Despacho del día",
    ]) expect(mom, quote).toContain(quote);
    expect(mom.indexOf("#### Repro Lima por las tareas del equipo (owner, 15-11-2026)")).toBeGreaterThan(mom.indexOf("### 9.5 Reprogramación en Lima"));
    expect(mom.indexOf("#### Repro Lima por las tareas del equipo (owner, 15-11-2026)")).toBeLessThan(mom.indexOf("### 9.6 «Lima trabados»"));
  });
  it("§9.6 dice dónde se ve cada motivo y §29.16 que «Sale a reparto» queda en Despacho del día", () => {
    expect(mom).toContain("**Dónde se ve cada motivo (owner, 15-11-2026).**");
    expect(mom).toContain("**Desde el 15-11-2026 está en un solo sitio**");
  });
  it("§9.5 cuenta la tercera vuelta: los seis pasos suman el total, dos plegados, y la Agenda con o sin guía", () => {
    expect(mom).toContain("**Tercera vuelta: cinco pasos que suman el total (owner, 15-11-2026).**");
    for (const quote of ["`limaStepOf`", "**Sacar a reparto**", "**Con el courier**", "`LIMA_FOLDED_STEPS`", "**La barra de reparto.**", "`AGENDA_NAMED_DAYS = 1`", "**«Hoy sin guía»**", "**«Mañana sin guía»**", "**No suma el total**"]) {
      expect(mom, quote).toContain(quote);
    }
    expect(mom.indexOf("**Tercera vuelta: cinco pasos que suman el total")).toBeGreaterThan(mom.indexOf("**Segunda vuelta: el flujo del día"));
  });
  it("§9.5 cuenta la cuarta vuelta: ruta vencida solo en Repro Lima, la propuesta de día y la alerta de las 10:30", () => {
    expect(mom).toContain("**Cuarta vuelta: ruta vencida, propuesta de día y la hora de la alerta (owner, 15-11-2026).**");
    for (const quote of ["`routeWithoutReport`", "**un día de reparto entero**", "**«Sin reporte de la ruta»**", "**Solo en Repro Lima**", "**Kapta propone, el equipo confirma**", "**«Hoy sin guía» es alerta desde las 10:30 de Lima**"]) {
      expect(mom, quote).toContain(quote);
    }
  });
  it("DESIGN.md describe el flujo y la Agenda, y DEPLOY.md lleva sus entradas, sin migración", () => {
    const design = flat(read("DESIGN.md"));
    expect(design).toContain("### Repro Lima: el flujo del día y la Agenda sobre una lista (15-11-2026)");
    expect(design).toContain("«N con guía · **M sin guía**»");
    const entries = [...read("DEPLOY.md").matchAll(/^### (.+)$/gm)].map((m) => m[1]!);
    // Se busca por título: el orden de arriba lo deciden las entradas con migración.
    for (const title of ["Repro Lima por las tareas del equipo", "Repro Lima: seis pasos que suman el total", "Repro Lima: ruta vencida sin reporte a No entregados"]) {
      const entry = entries.find((t) => t.includes(title));
      expect(entry, title).toBeDefined();
      expect(entry, title).toContain("sin migración");
    }
  });
});
