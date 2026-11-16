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
  courierRouteText,
  courierStatusText,
  callDue,
  limaBoardCounts,
  limaBoardRows,
  limaCourierState,
  limaNextStep,
  nextDeliveryDay,
  agendaDayText,
  limaOwnRoute,
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
    // «Nunca salieron», como lo llama el equipo (owner, 16-11-2026: «no veo el bloque de no salieron nunca»).
    expect(LIMA_TASK_CARDS.map((c) => c.label)).toEqual(["Nunca salieron", "No entregados", "Novedad del courier", "Llamar después", "Por cerrar"]);
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
    // Con su día acordado sale de No entregados: es un Programado (16-11-2026), el mar 17 en «Después», y sin guía todavía.
    expect(cls(failed(), caseOf({ list: "programados", agreement: { agreedOn: "2026-11-17", courier: "propio" } }))).toMatchObject({ task: null, step: "programados", agenda: "despues", agendaDay: "2026-11-17", agreed: true, guide: false });
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
    // Aliclik, con las palabras de su Excel; lo desconocido va como llegó.
    expect(courierStatusText("DELIVERED · PICKED · CONFIRMED")).toBe("Entregado · Recolectado · Confirmado");
    expect(courierStatusText("PENDING_DELIVERY · PREPARED · CONFIRMED")).toBe("Por entregar · Validado · Confirmado");
    expect(courierStatusText("PENDING_DELIVERY · FOO")).toBe("Por entregar · FOO");
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

  it("lo vencido sale el próximo día de reparto: Hoy de lunes a sábado, Mañana el domingo; de martes a viernes y más allá, Después; sin día, Sin fecha", () => {
    // Domingo (sin reparto, owner 16-11-2026: «si saldrían mañana de todas maneras»): lo de hoy y lo vencido, a Mañana.
    expect(agendaKeyOf("2026-11-12", TODAY, WINDOW)).toBe("manana");
    expect(agendaKeyOf(TODAY, TODAY, WINDOW)).toBe("manana");
    // Martes: lo vencido y lo de hoy, en Hoy.
    expect(agendaKeyOf("2026-11-12", "2026-11-17", agendaWindow("2026-11-17"))).toBe("hoy");
    expect(agendaKeyOf("2026-11-17", "2026-11-17", agendaWindow("2026-11-17"))).toBe("hoy");
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

  it("las tarjetas de Programados: Hoy, Mañana (con su día) y Después, sin «Sin fecha»; el domingo, sin «Hoy»", () => {
    // Owner, 16-11-2026: «¿qué sentido tiene un programado sin fecha?». Lo sin día vive en Sacar a reparto.
    expect(agendaCards(TODAY).map((c) => c.key)).toEqual(["manana", "despues"]);
    expect(agendaCards(TODAY).map((c) => c.label)).toEqual(["Mañana · Lun 16", "Después"]);
    expect(agendaCards(TODAY)[0]!.hint).toContain("hoy no se reparte");
    expect(agendaCards("2026-11-17").map((c) => c.label)).toEqual(["Hoy", "Mañana · Mié 18", "Después"]);
    // Un sábado, «Mañana» es el lunes: se dice el día, no «Mañana».
    expect(agendaCards("2026-11-14").map((c) => c.label)).toEqual(["Hoy", "Lun 16", "Después"]);
    expect(agendaCards(TODAY).find((c) => c.key === "despues")?.hint).toBe("Agendados después del lunes 16/11.");
  });
});

describe("los siete pasos suman el total (owner, 15-11-2026: «estos 5 no suman 1,438 pedidos»; Programados, 16-11-2026)", () => {
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
    // g (retornando) es un no entregado: el courier lo está devolviendo.
    // b tiene día (el 17): es un Programado; en Sacar a reparto queda lo que no tiene día (a, h).
    expect(counts.step).toEqual({ novedad: 1, llamar_despues: 0, no_entregados: 2, por_sacar: 2, programados: 1, con_courier: 2, por_cerrar: 0 });
    expect(Object.values(counts.step).reduce((a, b) => a + b, 0)).toBe(counts.todos);
    for (const step of LIMA_STEP_CARDS.map((c) => c.key)) {
      expect(limaBoardRows(rows, classes, step).length, step).toBe(counts.step[step]);
    }
    for (const r of rows) {
      const c = classes.get(r.orderId)!;
      if (c.step === "por_sacar") expect(c.agenda, r.orderId).not.toBeNull();
    }
    expect(counts.task).toEqual({ primer_despacho: 1, no_entregados: 2, novedad: 1, llamar_despues: 0, por_cerrar: 0 });
    // Guía creada y En ruta suman «Con el courier» (la novedad f está en su paso); Retornando vive en No entregados.
    expect(counts.courier).toEqual({ guia_creada: 1, en_ruta: 1, retornando: 1 });
    expect(counts.courier.guia_creada + counts.courier.en_ruta).toBe(counts.step.con_courier);
    expect(limaBoardRows(rows, classes, "en_ruta").map((r) => r.orderId)).toEqual(["d"]);
    expect(limaBoardRows(rows, classes, "retornando").map((r) => r.orderId)).toEqual(["g"]);
    expect(classes.get("g")).toMatchObject({ step: "no_entregados", task: "no_entregados", courier: "retornando" });
    expect(limaNextStep(rows[6]!, undefined, classes.get("g")!, TODAY)).toBe("Lo está devolviendo Aliclik: llama a la clienta y acuerda el nuevo día (Atender); sale otra vez cuando llegue al almacén.");
    expect(counts.agenda).toEqual({ hoy: 0, manana: 0, despues: 1 });
    expect(classes.get("b")).toMatchObject({ step: "programados", agenda: "despues" });
  });
  it("en Todos, por paso: la novedad, lo que tiene hora, lo que falló, lo que falta sacar (por su día) y lo del courier", () => {
    expect(limaBoardRows(rows, classes, "todos").map((r) => r.orderId)).toEqual(["f", "e", "g", "a", "h", "b", "c", "d"]);
  });
  it("«Por cerrar» y «Con el courier» van plegados al final, pero cuentan: sin ellos la suma no cierra (owner, 15-11-2026)", () => {
    expect(LIMA_STEP_CARDS.map((c) => c.label)).toEqual(["Novedad del courier", "Llamar después", "No entregados", "Sacar a reparto", "Programados", "Con el courier", "Por cerrar"]);
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
    expect(at(gf, "2026-11-17")).toMatchObject({ step: "con_courier", noReport: false, courier: "en_ruta", routeToday: false });
    expect(at(gf, "2026-11-16")).toMatchObject({ step: "con_courier", routeToday: true });
    // «¿Cuándo estuvieron en ruta?»: En ruta se cuenta por el día de la ruta (hoy o la anterior).
    const twoDays = [gf, row({ ...gf, orderId: "nuevo", macroSince: "2026-11-17T14:00:00Z", ops: ops({ liveCouriers: ["propio"], lastGfBox: { day: "2026-11-17", riderName: "Roy" } }) })];
    const tc = limaBoardCounts(twoDays, classifyLimaRows(twoDays, [], "2026-11-17"));
    expect(tc.courier.en_ruta).toBe(2);
    expect(tc.enRutaHoy).toBe(1);
    expect(at(gf, "2026-11-18")).toMatchObject({ step: "no_entregados", task: "no_entregados", noReport: true, routeDay: "2026-11-16" });
    expect(limaOwnRoute(gf)).toBe(true);
    expect(limaNextStep(gf, undefined, at(gf, "2026-11-18"), "2026-11-18")).toBe("Salió a ruta el lun 16/11 y el motorizado Alexis no reportó el resultado: se cuenta como no entregado. Llama a la clienta; si no lo recibió, regístralo con «No se entregó» (con la captura) y acuerda el nuevo día.");
    // El domingo no cuenta: salió el sábado 14; el lunes 16 todavía espera, el martes 17 ya no.
    const sat = row({ stage: "en_curso", substage: "en_transito", courier: "gf_courier", dispatchedAt: "2026-11-14T15:00:00Z", macroSince: "2026-11-14T15:00:00Z", ops: ops({ liveCouriers: ["gf_courier"], reportedStatus: "OUT_FOR_DELIVERY" }) });
    expect(at(sat, "2026-11-16").noReport).toBe(false);
    expect(at(sat, "2026-11-17")).toMatchObject({ noReport: true, step: "no_entregados" });
    // La guía de otro courier no tiene parada en Kapta: se pide el reporte al courier (owner, 15-11-2026).
    expect(limaOwnRoute(sat)).toBe(false);
    expect(limaNextStep(sat, undefined, at(sat, "2026-11-17"), "2026-11-17")).toBe("Salió a ruta el sáb 14/11 y GF Courier no reportó el resultado: se cuenta como no entregado. Pide el reporte a GF Courier: el pedido cambia cuando el courier lo reporte.");
    // Una salida nueva manda: el día más reciente es el de la ruta.
    expect(limaRouteDay(row({ ...gf, macroSince: "2026-11-18T14:00:00Z" }))).toBe("2026-11-18");
    expect(at(row({ ...gf, macroSince: "2026-11-18T14:00:00Z" }), "2026-11-18").noReport).toBe(false);
    // Lo que vuelve es No entregados por su cuenta (Retornando, no «sin reporte»); lo dado por entregado y la novedad siguen su paso.
    expect(at(row({ ...gf, substage: "en_retorno" }), "2026-11-20")).toMatchObject({ noReport: false, step: "no_entregados", courier: "retornando" });
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
  it("una guía que el courier no recogió en su día todavía no salió: está en Sacar a reparto, en Hoy como vencida (owner, 15-11-2026)", () => {
    const missed = row({ orderId: "m", stage: "por_despachar", substage: "listo_para_asignar", courierPickup: { courier: "aliclik", date: "2026-11-13" } });
    const waiting = row({ orderId: "w", stage: "por_despachar", substage: "listo_para_recojo", courierPickup: { courier: "aliclik", date: "2026-11-16" } });
    // Viernes 13 sin recoger y el sábado pasó entero: guía sin recoger; el domingo va a Mañana (sale el lunes).
    expect(cls(missed)).toMatchObject({ step: "por_sacar", missedPickup: true, courier: "guia_creada", agenda: "manana", guide: true });
    expect(classifyLimaRow(missed, undefined, "2026-11-17", agendaWindow("2026-11-17"))).toMatchObject({ missedPickup: true, agenda: "hoy" });
    expect(cls(waiting)).toMatchObject({ step: "programados", missedPickup: false, agenda: "manana" });
    expect(limaNextStep(missed, undefined, cls(missed), TODAY)).toBe("Aliclik debía recogerlo el vie 13/11 y no lo recogió: coordina el recojo o crea la guía con otro courier (Mesa de ruta).");
    const both = [missed, waiting];
    const c = classifyLimaRows(both, [], TODAY);
    const counts = limaBoardCounts(both, c);
    expect(counts.sub.guia_sin_recoger).toBe(1);
    // La guía que espera su recojo tiene día: es un Programado, no «Con el courier» (16-11-2026).
    expect(counts.courier.guia_creada).toBe(0);
    expect(counts.step).toMatchObject({ por_sacar: 1, programados: 1, con_courier: 0 });
    expect(limaBoardRows(both, c, "guia_sin_recoger").map((r) => r.orderId)).toEqual(["m"]);
    expect(LIMA_SUB_FILTERS.guia_sin_recoger.parent).toBe("por_sacar");
  });
  it("«Llamar después»: cuando llega la hora, ya toca: el paso lo cuenta y la fila lo dice primero (owner, 15-11-2026)", async () => {
    const llamar = caseOf({ list: "llamar_despues", nextCallAt: "2026-11-15T15:00:00Z" }); // 10:00 de Lima
    expect(callDue(llamar, new Date("2026-11-15T14:59:00Z"))).toBe(false);
    expect(callDue(llamar, new Date("2026-11-15T15:00:00Z"))).toBe(true);
    expect(callDue(caseOf({ list: "por_decidir", nextCallAt: "2026-11-15T15:00:00Z" }), new Date("2026-11-15T16:00:00Z"))).toBe(false);
    expect(limaNextStep(failed(), llamar, cls(failed(), llamar), TODAY, new Date("2026-11-15T16:00:00Z"))).toBe("Ya toca llamar (pidió hoy 10:00).");
    const { ReproLimaBlocks } = await import("@/components/repro-lima-blocks");
    const rows = [failed()];
    const counts = limaBoardCounts(rows, classifyLimaRows(rows, [llamar], TODAY));
    const html = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts, today: TODAY, active: "todos", onPick: () => {}, callsDue: 1 }));
    expect(html).toContain("1 ya toca");
    expect(read("components/repro-lima-pending.tsx")).toContain('cls.task === "llamar_despues" && callDue(repro, now ?? new Date()) ? "font-medium text-warn-fg"');
  });
  it("con el courier, la fila dice la fecha de su ruta: el recojo, el día pedido a GF Courier o el día en que salió (owner, 15-11-2026)", () => {
    const at = (r: LimaPendingOrder) => courierRouteText(r, cls(r), TODAY);
    // Aliclik debía recogerlo el viernes y no lo recogió.
    expect(at(row({ stage: "por_despachar", substage: "listo_para_asignar", courierPickup: { courier: "aliclik", date: "2026-11-13" } }))).toEqual({ day: "Vencido · vie 13/11", detail: "Recojo de Aliclik", overdue: true });
    expect(at(row({ stage: "por_despachar", substage: "listo_para_recojo", courierPickup: { courier: "gf_courier", date: TODAY }, ops: ops({ liveCouriers: ["gf_courier"] }) }))).toEqual({ day: "Hoy", detail: "Sale con GF Courier", overdue: false });
    expect(at(row({ stage: "por_despachar", substage: "listo_para_recojo", ops: ops({ liveCouriers: ["gf_courier"] }) }))).toEqual({ day: "Guía creada", detail: "Sin día del courier", overdue: false });
    // En la calle: el día de la ruta.
    expect(at(row({ stage: "en_curso", substage: "en_reparto", courier: "propio", macroSince: "2026-11-15T14:00:00Z", ops: ops({ liveCouriers: ["propio"], lastGfBox: { day: TODAY, riderName: "Alexis" } }) }))).toEqual({ day: "Hoy", detail: "En ruta", overdue: false });
    expect(at(row({ stage: "en_curso", substage: "en_retorno", courier: "aliclik", dispatchedAt: "2026-11-12T15:00:00Z", macroSince: "2026-11-12T15:00:00Z" }))).toEqual({ day: "jue 12/11", detail: "Retornando", overdue: false });
    expect(courierRouteText(row(), cls(row()), TODAY)).toBeNull();
  });
  it("«Mañana sin guía» no alarma por lo que creará la guía GF automática en Activo (owner, 15-11-2026)", async () => {
    const day = [
      row({ orderId: "auto", storeId: "a", scheduledOn: "2026-11-16" }),
      row({ orderId: "otra", storeId: "b", scheduledOn: "2026-11-16" }),
      failed({ orderId: "acuerdo", storeId: "a" }),
    ];
    const cases = [{ orderId: "acuerdo", list: "programados" as const, agreement: { agreedOn: "2026-11-16", courier: "aliclik" } }];
    const c = classifyLimaRows(day, cases, TODAY, agendaWindow(TODAY), { autoGuideStores: new Set(["a"]) });
    expect(c.get("auto")).toMatchObject({ agenda: "manana", guide: false, autoGuide: true });
    expect(c.get("otra")?.autoGuide).toBe(false);
    // Con un acuerdo de Repro Lima la pasada no lo toma (`gfAutoSkip`): sigue siendo alerta.
    expect(c.get("acuerdo")).toMatchObject({ agenda: "manana", autoGuide: false });
    const counts = limaBoardCounts(day, c);
    expect(counts.sub.manana_sin_guia).toBe(2);
    expect(counts.autoGuideManana).toBe(1);
    expect(limaBoardRows(day, c, "manana_sin_guia").map((r) => r.orderId).sort()).toEqual(["acuerdo", "otra"]);
    expect(limaNextStep(day[0]!, undefined, c.get("auto")!, TODAY)).toBe("Sale mañana: la guía GF automática la crea mañana en la mañana.");
    const { ReproLimaBlocks } = await import("@/components/repro-lima-blocks");
    const html = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts, today: TODAY, active: "programados", onPick: () => {} }));
    expect(html).toContain("1 de mañana la crea la automática");
    // Sin la automática, todo lo de mañana sin guía alarma, como antes.
    expect(limaBoardCounts(day, classifyLimaRows(day, cases, TODAY)).sub.manana_sin_guia).toBe(3);
  });
  it("Hoy y Mañana dicen cuántos tienen guía; los que no son una alerta con su filtro", () => {
    // Un martes: lo vencido sale hoy.
    const TUE = "2026-11-17";
    const day = [
      row({ orderId: "hoy-sin", programmedFor: TUE }),
      row({ orderId: "vencido-sin", programmedFor: "2026-11-12" }),
      row({ orderId: "hoy-rotulo", substage: "por_armar", programmedFor: TUE, ops: ops({ liveCouriers: ["propio"] }) }),
      row({ orderId: "manana-sin", scheduledOn: "2026-11-18" }),
      row({ orderId: "manana-guia", stage: "por_despachar", substage: "listo_para_recojo", courierPickup: { courier: "aliclik", date: "2026-11-18" } }),
      row({ orderId: "despues-sin", scheduledOn: "2026-11-20" }),
    ];
    const c = classifyLimaRows(day, [], TUE);
    const counts = limaBoardCounts(day, c);
    expect(counts.agenda).toMatchObject({ hoy: 3, manana: 2, despues: 1 });
    expect(counts.sub).toMatchObject({ hoy_sin_guia: 2, manana_sin_guia: 1 });
    expect(limaBoardRows(day, c, "hoy_sin_guia").map((r) => r.orderId)).toEqual(["vencido-sin", "hoy-sin"]);
    expect(limaBoardRows(day, c, "manana_sin_guia").map((r) => r.orderId)).toEqual(["manana-sin"]);
    // La guía de Aliclik para mañana es un Programado de mañana, con guía.
    expect(c.get("manana-guia")).toMatchObject({ step: "programados", agenda: "manana", guide: true });
    const now = new Date("2026-11-17T16:00:00Z");
    const next = (id: string) => limaNextStep(day.find((r) => r.orderId === id)!, undefined, c.get(id)!, TUE, now);
    expect(next("hoy-sin")).toBe("Sale hoy y no tiene guía ni rótulo: créala desde la Mesa de ruta para que salga.");
    expect(next("vencido-sin")).toBe("Debía salir el jue 12/11 y no tiene guía ni rótulo: créala hoy desde la Mesa de ruta o reagéndalo.");
    expect(next("manana-sin")).toBe("Sale mañana y no tiene guía ni rótulo: genérala hoy.");
    expect(next("hoy-rotulo")).toBe("Sale hoy.");
    // El domingo, lo de hoy y lo vencido van a Mañana (sale el lunes) y su falta de guía es de mañana.
    const sun = limaBoardCounts(day, classifyLimaRows(day, [], TODAY));
    expect(sun.agenda.hoy ?? 0).toBe(0);
    expect(sun.sub.hoy_sin_guia).toBe(0);
  });
  it("un no entregado que ya tiene su guía nueva esperando recojo es un Programado, no por gestionar (owner, 16-11-2026, #KP204876)", () => {
    // Alexis no lo entregó el 10/11 (Por reprogramar Lima) y el 14/11 se le creó otra guía Aliclik para el lunes.
    const kp = failed({ orderId: "kp204876", courierPickup: { courier: "aliclik", date: "2026-11-16" }, ops: ops({ liveCouriers: ["aliclik", "propio"], reportedStatus: "PENDING_DELIVERY · PREPARED · CONFIRMED" }) });
    expect(limaCourierState(kp)).toBe("guia_creada");
    expect(limaTaskOf(kp)).toBeNull();
    expect(cls(kp)).toMatchObject({ step: "programados", task: null, courier: "guia_creada", agenda: "manana", agendaDay: "2026-11-16" });
    expect(limaNextStep(kp, undefined, cls(kp), TODAY)).toBe("Lo recoge Aliclik el lun 16/11.");
    // Sin guía nueva sigue siendo un no entregado por gestionar.
    expect(cls(failed())).toMatchObject({ step: "no_entregados", task: "no_entregados" });
    // Con la guía de GF viva y una novedad, sigue siendo novedad (no espera recojo).
    expect(limaTaskOf(failed({ ops: ops({ liveCouriers: ["gf_courier"], reportedStatus: "INCIDENT:NO_ANSWER" }) }))).toBe("novedad");
  });
  it("la guía que espera su recojo y cuyo día pasó sin un día de reparto entero: la recoge el próximo día de reparto, sin «Vencido» (owner, 16-11-2026, #KP204807)", () => {
    // Guía Aliclik del sábado 14 (su regla de corte decía sábado); el domingo la valida y la recoge el lunes.
    const kp = row({ orderId: "kp204807", stage: "por_despachar", substage: "listo_para_asignar", courierPickup: { courier: "aliclik", date: "2026-11-14" }, ops: ops({ liveCouriers: ["aliclik"], reportedStatus: "PENDING_DELIVERY · PREPARED · CONFIRMED" }) });
    const sun = cls(kp);
    expect(sun).toMatchObject({ step: "programados", missedPickup: false, pickupRolled: true, courier: "guia_creada", agenda: "manana", agendaDay: "2026-11-16" });
    expect(limaNextStep(kp, undefined, sun, TODAY)).toBe("Lo recoge Aliclik el lun 16/11.");
    expect(agendaDayText(sun.agendaDay, TODAY)).toBe("lun 16/11");
    // El lunes todavía no pasó un día de reparto entero: la recoge hoy.
    const mon = classifyLimaRow(kp, undefined, "2026-11-16", agendaWindow("2026-11-16"));
    expect(mon).toMatchObject({ missedPickup: false, agenda: "hoy", agendaDay: "2026-11-16" });
    expect(limaNextStep(kp, undefined, mon, "2026-11-16")).toBe("Lo recoge Aliclik hoy.");
    // El martes, el lunes pasó entero sin recogerla: guía sin recoger, por sacar a reparto.
    expect(classifyLimaRow(kp, undefined, "2026-11-17", agendaWindow("2026-11-17"))).toMatchObject({ missedPickup: true, step: "por_sacar", agenda: "hoy" });
    expect(nextDeliveryDay(TODAY)).toBe("2026-11-16");
    expect(nextDeliveryDay("2026-11-17")).toBe("2026-11-17");
  });
  it("No entregados sigue el orden de los casos (`sortRepro`)", () => {
    const two = [failed({ orderId: "x" }), failed({ orderId: "y" })];
    const c2 = classifyLimaRows(two, [], TODAY);
    expect(limaBoardRows(two, c2, "no_entregados", new Map([["y", 0], ["x", 1]])).map((r) => r.orderId)).toEqual(["y", "x"]);
  });
});

describe("el filtro de la URL (`atencion`)", () => {
  it("las claves nuevas pasan; un día que pasó abre Hoy; lo desconocido, Todos", () => {
    for (const key of ["novedad", "llamar_despues", "no_entregados", "por_sacar", "con_courier", "por_cerrar", "guia_creada", "en_ruta", "retornando", "manana", "despues", "reprogramados", "esperan_anulacion", "reintentos_aliclik", "mas_de_30", "hoy_sin_guia", "manana_sin_guia", "programados", "nunca_salieron", "salieron_sin_dia", "por_acordar", "guia_sin_recoger", "sin_reporte"]) {
      expect(boardFilter(key, TODAY)).toBe(key);
    }
    // «Confirmar primer despacho» de antes abre Sacar a reparto; «Sin fecha» también (ya no es de Programados).
    expect(boardFilter("primer_despacho", TODAY)).toBe("por_sacar");
    expect(boardFilter("sin_fecha", TODAY)).toBe("por_sacar");
    // «Agendados» (dentro de Sacar a reparto hasta el 16-11-2026) y «Programados por paso» abren Programados y su día.
    expect(boardFilter("agendados", TODAY)).toBe("programados");
    expect(boardFilter("por_sacar:despues", TODAY)).toBe("despues");
    // Un día guardado de la Agenda anterior abre su cajón de ahora.
    expect(boardFilter("2026-11-16", TODAY)).toBe("manana");
    expect(boardFilter("2026-11-18", TODAY)).toBe("despues");
    // Un día que pasó abre el próximo día de reparto: el domingo, Mañana; un martes, Hoy.
    expect(boardFilter("2026-11-10", TODAY)).toBe("manana");
    expect(boardFilter("2026-11-10", "2026-11-17")).toBe("hoy");
    expect(boardFilter("hoy", TODAY)).toBe("manana");
    expect(boardFilter("hoy", "2026-11-17")).toBe("hoy");
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
    // Un martes (el domingo no hay «Hoy»).
    const TUE = "2026-11-17";
    const hoy = row({ programmedFor: TUE });
    const c = classifyLimaRow(hoy, undefined, TUE, agendaWindow(TUE));
    expect(limaNextStep(hoy, undefined, c, TUE, new Date("2026-11-17T14:00:00Z"))).toBe("Sale hoy y todavía no tiene guía ni rótulo: si a las 10:30 no la tiene, créala desde la Mesa de ruta.");
    expect(limaNextStep(hoy, undefined, c, TUE, new Date("2026-11-17T16:00:00Z"))).toBe("Sale hoy y no tiene guía ni rótulo: créala desde la Mesa de ruta para que salga.");
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
    // «Programados» es su propio paso (owner, 16-11-2026: «un programado es un programado»), sin bloque aparte.
    expect(LIMA_FLOW.map((step) => step.key)).toEqual(["novedad", "llamar_despues", "no_entregados", "por_sacar", "programados", "con_courier", "por_cerrar"]);
    const rows = [row(), failed({ orderId: "e" }), row({ orderId: "h", programmedFor: TODAY })];
    const counts = limaBoardCounts(rows, classifyLimaRows(rows, [], TODAY));
    const html = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts, today: TODAY, active: "no_entregados", onPick: () => {} }));
    for (const text of ["Flujo del día", "los siete suman el total", "Programados", "Sacar a reparto", "Con el courier", "Por cerrar"]) expect(html, text).toContain(text);
    for (const text of ["En manos del courier", "Confirmar primer despacho", "Mar 17", "Sin fecha", "repro-agenda"]) expect(html, text).not.toContain(text);
    // La celda de Programados: sus días y lo de mañana sin guía, como alerta.
    expect(html).toContain("1 mañana · ");
    expect(html).toContain("1 sin guía</span>");
    // Elegido, sus días son sus partes y «Mañana sin guía» su alerta.
    const prog = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts, today: TODAY, active: "programados", onPick: () => {} }));
    for (const text of [">Programados</b>:", "Mañana · Lun 16", "Después", "Mañana sin guía"]) expect(prog, text).toContain(text);
    // «Nunca salieron» con su nombre en la nota del paso y como filtro de adentro (owner, 16-11-2026).
    expect(html).toContain("1 nunca salieron");
    const inside = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts, today: TODAY, active: "nunca_salieron", onPick: () => {} }));
    const chips = inside.slice(inside.indexOf(">Sacar a reparto</b>:"));
    expect(chips).toContain("Nunca salieron");
    expect(chips).not.toContain("Sin fecha");
    // Antes de las 10:30, «Hoy sin guía» es un chip neutro; después, una alerta.
    // (un martes: el domingo no hay «Hoy»)
    const tueRows = [row({ orderId: "t", programmedFor: "2026-11-17" })];
    const tueCounts = limaBoardCounts(tueRows, classifyLimaRows(tueRows, [], "2026-11-17"));
    const early = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts: tueCounts, today: "2026-11-17", active: "programados", onPick: () => {}, guideAlert: false }));
    const late = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts: tueCounts, today: "2026-11-17", active: "programados", onPick: () => {}, guideAlert: true }));
    expect(early).toContain("Es alerta desde las 10:30.");
    expect(late).not.toContain("Es alerta desde las 10:30.");
    expect(late).toContain("Hoy sin guía");
    // La barra de reparto cierra con el total: los tramos en el orden de las celdas.
    expect(html).toContain(`= <b class="font-semibold text-ink-900">${counts.todos}</b> pedidos`);
    // Los plegados no llevan número de paso: solo los cinco del trabajo.
    expect(html.match(/size-5 shrink-0 place-items-center rounded-full/g)).toHaveLength(5);
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*No entregados/);
    // «Reintentos Aliclik» vive DENTRO de «No entregados»: su filtro sale en el pie con el nombre del paso, no suelto.
    expect(html).toContain("Dentro de <b");
    expect(html).toContain("Reintentos Aliclik");
    // Sin un paso elegido, no hay chips de adentro sueltos debajo de la fila.
    const idle = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts, today: TODAY, active: "todos", onPick: () => {} }));
    expect(idle).not.toContain("Dentro de");
    expect(idle).toContain("Empieza aquí");
  });

  it("el total va arriba y los trabados dentro de su paso, no como píldora aparte (owner, 15-11-2026)", () => {
    const board = read("components/repro-lima-board.tsx");
    expect(board).toContain("pedidos de Lima por entregar");
    expect(board).not.toContain('label="Trabados"');
    expect(board).not.toContain('aria-label="Trabados por motivo"');
    expect(board).toContain("stuck={{ byStep: stuckByStep, active: Boolean(stuck), onPick: chooseStepStuck }}");
    expect(board).toContain('label="Etapa"');
    expect(board).not.toContain('label="Solo trabados"');
  });
  it("cada paso tiene su matiz: número, tramo de la barra, celda elegida y cabecera de la lista (owner, 16-11-2026)", async () => {
    const { ReproLimaBlocks, STEP_TONE, activeStep } = await import("@/components/repro-lima-blocks");
    // Clasificación, no estados: ni rojo ni verde.
    for (const tone of Object.values(STEP_TONE)) expect(JSON.stringify(tone)).not.toMatch(/red-|green-|emerald-|crit|ok-/);
    const rows = [row(), failed({ orderId: "e" })];
    const counts = limaBoardCounts(rows, classifyLimaRows(rows, [], TODAY));
    const html = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts, today: TODAY, active: "por_sacar", onPick: () => {} }));
    expect(html).toContain(STEP_TONE.por_sacar.on);
    expect(html).toContain(STEP_TONE.por_sacar.numOn);
    expect(html).toContain(STEP_TONE.no_entregados.num);
    expect(html).toContain(STEP_TONE.no_entregados.segDim);
    for (const part of ["guia_sin_recoger", "nunca_salieron", "mas_de_30", "salieron_sin_dia"] as const) expect(activeStep(part)).toBe("por_sacar");
    for (const part of ["por_acordar", "reintentos_aliclik", "retornando", "sin_reporte"] as const) expect(activeStep(part)).toBe("no_entregados");
    for (const part of ["hoy", "manana", "despues", "hoy_sin_guia", "manana_sin_guia", "reprogramados"] as const) expect(activeStep(part)).toBe("programados");
    const board = read("components/repro-lima-board.tsx");
    expect(board).toContain('listStep ? STEP_TONE[listStep].band : "bg-wash/70"');
  });
  it("cada paso dice sus trabados y, elegido, lleva su filtro «Trabados»", async () => {
    const { ReproLimaBlocks } = await import("@/components/repro-lima-blocks");
    const rows = [row(), failed({ orderId: "e" })];
    const counts = limaBoardCounts(rows, classifyLimaRows(rows, [], TODAY));
    const byStep = { novedad: 0, llamar_despues: 0, no_entregados: 0, por_sacar: 3, programados: 0, con_courier: 0, por_cerrar: 0 };
    const html = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts, today: TODAY, active: "por_sacar", onPick: () => {}, stuck: { byStep, active: false, onPick: () => {} } }));
    expect(html).toContain("3 trabados");
    expect(html).toMatch(/Dentro de <b[^>]*>Sacar a reparto<\/b>/);
    expect(html).toContain(">Trabados<");
    // Un paso sin trabados no lleva el filtro.
    const quiet = renderToStaticMarkup(createElement(ReproLimaBlocks, { counts, today: TODAY, active: "novedad", onPick: () => {}, stuck: { byStep, active: false, onPick: () => {} } }));
    expect(quiet).not.toContain(">Trabados<");
  });
});

describe("«No se entregó»: por el camino de Coordinación, con captura, solo en el reparto propio (owner, 15-11-2026)", () => {
  const action = read("app/dashboard/pedidos/repro-lima/no-entrego-actions.ts");
  const dialog = read("components/repro-lima-no-entrego.tsx");
  const board = read("components/repro-lima-board.tsx");
  const page = read("app/dashboard/pedidos/repro-lima/page.tsx");
  it("la acción solo busca la parada: pide Repro Lima, la tienda del pedido y la llave de /reparto; no escribe", () => {
    expect(action.startsWith('"use server";')).toBe(true);
    expect([...action.matchAll(/^export async function (\w+)\(/gm)].map((m) => m[1])).toEqual(["loadNoEntregoStop"]);
    expect(action).toContain("const scope = await requireReproLima();");
    expect(action).toContain("if (!storeId || !scope.storeIds.has(storeId)) return { error: REPRO_OUTSIDE_STORE };");
    expect(action).toContain("const access = await routeReportAccess(stop.route_id);");
    expect(action).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
  it("el reporte va por `reportStop` con el motivo del catálogo y la captura obligatoria", () => {
    expect(dialog).toContain('import { reportStop } from "@/app/reparto/actions";');
    expect(dialog).toContain('status: "no_entregado",');
    expect(dialog).toContain("reportReason: NO_ENTREGO_REPORT_REASON,");
    expect(dialog).toContain('!photoPath ? "Adjunta la captura del chat o de la llamada con la clienta."');
    expect(dialog).toContain("NON_DELIVERY_REASONS.map");
  });
  it("el botón sale solo en una ruta vencida del reparto propio y con el permiso de Coordinación", () => {
    expect(board).toContain("canReportForRider && classes.get(row.orderId)?.noReport && limaOwnRoute(row) && (");
    expect(page).toContain('canReportForRider = permissions.can("routes.report_others");');
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
    expect(board).toContain('(key === "por_sacar" || key === "nunca_salieron" || key === "mas_de_30" || key === "salieron_sin_dia")');
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
  it("§9.5 cuenta la quinta vuelta: Retornando, la fecha de la ruta, los trabados en su paso, la automática y «No se entregó»", () => {
    expect(mom).toContain("**Quinta vuelta: lo que vuelve, la fecha de la ruta, los trabados dentro de su paso, la guía automática de mañana y «No se entregó» (owner, 15-11-2026).**");
    for (const quote of ["**Retornando es un no entregado.**", "`courierRouteText`", "**Los trabados viven dentro de su paso.**", "`loadGfAutoActiveStores`", "**la captura obligatoria**", "`routes.report_others`", "`limaOwnRoute`"]) {
      expect(mom, quote).toContain(quote);
    }
  });
  it("§9.5 cuenta la sexta vuelta: la guía sin recoger, las llamadas que ya tocan y Aliclik con palabras", () => {
    expect(mom).toContain("**Sexta vuelta: la guía sin recoger, las llamadas que ya tocan y los estados de Aliclik (owner, 16-11-2026).**");
    for (const quote of ["`missedPickup`", "**«Guía sin recoger»**", "`callDue`", "**Los estados de Aliclik con palabras**"]) expect(mom, quote).toContain(quote);
  });
  it("§9.5 cuenta la séptima vuelta: lo vencido al próximo día de reparto y la guía que espera recojo sin «Vencido»", () => {
    expect(mom).toContain("**Séptima vuelta: lo vencido sale el próximo día de reparto (owner, 16-11-2026).**");
    for (const quote of ["`pickupRolled`", "`nextDeliveryDay`", "No hay cajón «Atrasados».", "#KP204807", "#KP204876", "**Un no entregado que ya tiene su guía nueva**"]) expect(mom, quote).toContain(quote);
  });
  it("DESIGN.md describe el flujo con Programados como paso, y DEPLOY.md lleva sus entradas, sin migración", () => {
    const design = flat(read("DESIGN.md"));
    expect(design).toContain("### Repro Lima: el flujo del día sobre una lista (15-11-2026; Programados como paso, 16-11-2026)");
    expect(design).toContain("«N mañana · M después · **K sin guía**»");
    expect(design).toContain("Programados en violeta");
    expect(flat(read("docs/mom/master-pedidos-v1.md"))).toContain("**«Programados», su propio paso del flujo**");
    const entries = [...read("DEPLOY.md").matchAll(/^### (.+)$/gm)].map((m) => m[1]!);
    // Se busca por título: el orden de arriba lo deciden las entradas con migración.
    for (const title of ["Repro Lima por las tareas del equipo", "Repro Lima: seis pasos que suman el total", "Repro Lima: ruta vencida sin reporte a No entregados", "Repro Lima: Retornando a No entregados", "Repro Lima: guía sin recoger a Sacar a reparto", "Repro Lima: lo vencido sale el próximo día de reparto"]) {
      const entry = entries.find((t) => t.includes(title));
      expect(entry, title).toBeDefined();
      expect(entry, title).toContain("sin migración");
    }
  });
});

describe("las partes de un paso suman su cifra (owner, 16-11-2026: «la suma de las partes no da 216»)", () => {
  it("Sacar a reparto (guía sin recoger, nunca salieron, más de 30 días, ya salieron sin día), No entregados y Programados (sus días)", async () => {
    const { LIMA_STEP_PARTS, limaStepPart } = await import("@/lib/repro-lima-blocks");
    const rows = [
      row({ orderId: "nunca" }),
      row({ orderId: "viejo", createdAt: "2026-10-01T15:00:00Z" }),
      row({ orderId: "agendado", programmedFor: TODAY }),
      row({ orderId: "despues", scheduledOn: "2026-11-20" }),
      row({ orderId: "volvio", hasPriorDispatch: true }),
      row({ orderId: "sin-recoger", substage: "por_armar", courierPickup: { courier: "aliclik", date: "2026-11-12" }, ops: ops({ liveCouriers: ["aliclik"] }) }),
      failed({ orderId: "acordar" }),
      failed({ orderId: "acordar-2", courier: null }),
      row({ orderId: "ruta", stage: "en_curso", substage: "en_reparto", courier: "aliclik", macroSince: "2026-11-10T15:00:00Z", ops: ops({ liveCouriers: ["aliclik"] }) }),
      row({ orderId: "vuelve", stage: "en_curso", substage: "en_retorno", courier: "aliclik", ops: ops({ liveCouriers: ["aliclik"] }) }),
    ];
    const classes = classifyLimaRows(rows, [], TODAY);
    const counts = limaBoardCounts(rows, classes);
    const part = (id: string) => limaStepPart(classes.get(id)!);
    expect([part("nunca"), part("viejo"), part("volvio"), part("sin-recoger")]).toEqual(["nunca_salieron", "mas_de_30", "salieron_sin_dia", "guia_sin_recoger"]);
    expect([part("acordar"), part("acordar-2"), part("ruta"), part("vuelve")]).toEqual(["por_acordar", "por_acordar", "sin_reporte", null]);
    expect([classes.get("agendado")!.step, classes.get("despues")!.step]).toEqual(["programados", "programados"]);
    const sum = (keys: readonly string[]) =>
      keys.reduce((n, key) => n + ((counts.sub as Record<string, number>)[key] ?? (counts.courier as Record<string, number>)[key] ?? counts.agenda[key] ?? 0), 0);
    for (const step of ["por_sacar", "no_entregados", "programados", "con_courier"] as const) {
      expect(sum(LIMA_STEP_PARTS[step]!), step).toBe(counts.step[step]);
    }
    expect(counts.step).toMatchObject({ por_sacar: 4, no_entregados: 4, programados: 2 });
  });

  it("un reintento cuya guía nueva espera recojo no se cuenta como reintento: es un Programado", async () => {
    const { limaStepPart } = await import("@/lib/repro-lima-blocks");
    const r = failed({ orderId: "r", courierPickup: { courier: "aliclik", date: "2026-11-16" }, ops: ops({ liveCouriers: ["aliclik"] }) });
    const cases = [{ orderId: "r", retryChain: { attempt: 1 } }] as never;
    const classes = classifyLimaRows([r], cases, TODAY);
    expect(classes.get("r")!.step).toBe("programados");
    expect(limaStepPart(classes.get("r")!)).toBeNull();
    expect(limaBoardCounts([r], classes).sub.reintentos_aliclik).toBe(0);
  });
});

describe("«Programados», su propio paso (owner, 16-11-2026: «un programado es un programado»)", () => {
  it("lo que tiene día y todavía no sale: de No entregados, de Sacar a reparto o la guía que espera su recojo", async () => {
    const { boardMatches } = await import("@/lib/repro-lima-blocks");
    const rows = [
      row({ orderId: "a", programmedFor: TODAY }),
      row({ orderId: "b", programmedFor: "2026-11-20" }),
      row({ orderId: "c", substage: "por_armar", courierPickup: { courier: "aliclik", date: "2026-11-16" }, ops: ops({ liveCouriers: ["aliclik"] }) }),
      // #KP143245: «Por reprogramar Lima» con su día en el programa de Grupo GF, sin acuerdo: ya no es un no entregado.
      failed({ orderId: "gf", programmedFor: "2026-11-16" }),
      failed({ orderId: "d" }),
      row({ orderId: "ruta", stage: "en_curso", substage: "en_reparto", courier: "propio", programmedFor: "2026-11-16", ops: ops({ liveCouriers: ["propio"], lastGfBox: { day: TODAY, riderName: "Alexis" } }) }),
    ];
    const classes = classifyLimaRows(rows, [], TODAY);
    const counts = limaBoardCounts(rows, classes);
    expect(["a", "b", "c", "gf"].map((id) => classes.get(id)!.step)).toEqual(["programados", "programados", "programados", "programados"]);
    // Sin día sigue en No entregados; lo que ya salió, con el courier.
    expect(classes.get("d")!.step).toBe("no_entregados");
    expect(classes.get("ruta")!.step).toBe("con_courier");
    expect(counts.step.programados).toBe(4);
    expect(counts.agenda).toEqual({ hoy: 0, manana: 3, despues: 1 });
    // Sus días filtran solo dentro de Programados.
    expect(rows.filter((r) => boardMatches(classes.get(r.orderId)!, "manana")).map((r) => r.orderId)).toEqual(["a", "c", "gf"]);
    expect(rows.filter((r) => boardMatches(classes.get(r.orderId)!, "programados")).map((r) => r.orderId)).toEqual(["a", "b", "c", "gf"]);
    expect(limaBoardRows(rows, classes, "programados").map((r) => r.orderId)).toEqual(["a", "c", "gf", "b"]);
  });
});

describe("la fila de Repro Lima y la guía directo (owner, 16-11-2026: «como un fast forward»)", () => {
  it("ofrece crear la guía solo a lo que no tiene guía ni rótulo, antes de salir o por reprogramar", async () => {
    const { limaQuickGuideEligible } = await import("@/lib/repro-lima-blocks");
    const sin = row();
    expect(limaQuickGuideEligible({ ...sin, stage: "preparacion", substage: "por_generar_rotulo" }, { guide: false, step: "por_sacar" })).toBe(true);
    expect(limaQuickGuideEligible(failed(), { guide: false, step: "no_entregados" })).toBe(true);
    expect(limaQuickGuideEligible({ ...sin, stage: "preparacion", substage: "por_armar" }, { guide: true, step: "programados" })).toBe(false);
    expect(limaQuickGuideEligible({ ...sin, stage: "por_confirmar", substage: null }, { guide: false, step: "por_sacar" })).toBe(false);
    expect(limaQuickGuideEligible(failed(), { guide: false, step: "novedad" })).toBe(false);
    expect(limaQuickGuideEligible(failed(), { guide: false, step: "por_cerrar" })).toBe(false);
  });

  it("Aliclik elige AUTOECOM si se puede; GF y Aliclik van por las acciones de la Mesa de ruta", async () => {
    const { defaultAliclikTransport } = await import("@/lib/repro-lima-blocks");
    const quote = (transportId: number, transportName: string, selectable = true) => ({ transportId, transportName, selectable, addDays: 1, deliveryCost: 13.5, returnCost: 0, flagDeliveryExpress: false });
    expect(defaultAliclikTransport([quote(1, "ALIDRIVER"), quote(2, "AutoEcom Logistic")])).toBe(2);
    expect(defaultAliclikTransport([quote(1, "ALIDRIVER"), quote(2, "AutoEcom Logistic", false)])).toBe(1);
    expect(defaultAliclikTransport([quote(2, "AutoEcom Logistic", false)])).toBeNull();
    const quick = read("components/repro-lima-quick-guide.tsx");
    for (const call of ["previewAliclikGuide(row.orderId)", "createAliclikGuide(row.orderId, {", "expectedCollectTotal: ok.collectTotal ?? null", "createGfCourierGuide(row.orderId)"]) expect(quick, call).toContain(call);
    // Sin atajos: nada de llamar a Aliclik o GF por fuera de las acciones (permiso, compuertas y candado).
    expect(quick).not.toMatch(/fetch\(|lib\/aliclik"|createAliclikGuideFor|createGfGuideFor/);
    const board = read("components/repro-lima-board.tsx");
    expect(board.indexOf(">Atender</OpsButton>")).toBeLessThan(board.indexOf("<QuickGuideButtons"));
    expect(board).toContain("limaQuickGuideEligible(row, cls)");
    const page = read("app/dashboard/pedidos/repro-lima/page.tsx");
    expect(page).toContain('aliclik: permissions.can("aliclik.create_guide")');
    expect(page).toContain('gfStores: permissions.can("gf_courier.create_guide") ? gfStores : []');
  });

  it("la fila: sin tienda ni valor, la etapa bajo el código y la fecha entre «Qué pasa» y «Próximo paso»", () => {
    const pendingSrc = read("components/repro-lima-pending.tsx");
    expect(pendingSrc).not.toContain("{row.storeName}");
    expect(pendingSrc).not.toContain("soles(row.orderTotal)");
    const header = pendingSrc.slice(pendingSrc.indexOf(">Pedido</th>"));
    expect(header.indexOf(">Qué pasa</th>")).toBeLessThan(header.indexOf(">Fecha agendada</th>"));
    expect(header.indexOf(">Fecha agendada</th>")).toBeLessThan(header.indexOf(">Próximo paso</th>"));
    expect(pendingSrc).toContain("{row.orderName}</OrderLink><StageBadges row={row} />");
  });
});
