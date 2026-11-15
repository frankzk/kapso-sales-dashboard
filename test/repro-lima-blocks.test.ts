// «Repro Lima» por las tareas del equipo (owner, 15-11-2026; MOM §9.5): las
// reglas puras de los tres bloques —«Por gestionar hoy», «Agenda» y «En manos
// del courier»—, con qué acción existente se agenda cada pedido, dónde se ve
// cada trabado (§9.6) y, leídas en el código, las guardas de «Agendar» y
// «Mover a…» y la mudanza de «Sale a reparto» a Grupo GF Courier.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LimaPendingOps, LimaPendingOrder } from "@/lib/repro-lima-pending";
import {
  AGENDA_NAMED_DAYS,
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
    expect(cls(failed(), caseOf({ list: "programados", agreement: { agreedOn: "2026-11-17", courier: "propio" } }))).toMatchObject({ task: null, agenda: "2026-11-17", agreed: true });
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

describe("«Agenda»: Hoy, los próximos días por su nombre, Después y Sin fecha", () => {
  it("nombra cinco días de reparto desde mañana; un domingo en medio queda dentro", () => {
    expect(AGENDA_NAMED_DAYS).toBe(5);
    expect(agendaWindow(TODAY)).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
    expect(agendaWindow("2026-11-14")).toEqual(["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
    expect(agendaDayLabel("2026-11-16")).toBe("Lun 16");
    expect(agendaDayLabel("2026-11-17")).toBe("Mar 17");
  });

  it("lo vencido sigue en Hoy; más allá de los días nombrados, Después; sin día, Sin fecha", () => {
    expect(agendaKeyOf("2026-11-12", TODAY, WINDOW)).toBe("hoy");
    expect(agendaKeyOf(TODAY, TODAY, WINDOW)).toBe("hoy");
    expect(agendaKeyOf("2026-11-20", TODAY, WINDOW)).toBe("2026-11-20");
    expect(agendaKeyOf("2026-11-21", TODAY, WINDOW)).toBe("despues");
    expect(agendaKeyOf(null, TODAY, WINDOW)).toBe("sin_fecha");
  });

  it("el día: el acuerdo vigente, el programa de Grupo GF, el recojo del courier o «Programar envío», y de dónde sale", () => {
    expect(cls(row({ scheduledOn: "2026-11-17" }))).toMatchObject({ agenda: "2026-11-17", agendaOrigin: "envio" });
    expect(cls(row({ programmedFor: "2026-11-16", scheduledOn: "2026-11-17" }))).toMatchObject({ agenda: "2026-11-16", agendaOrigin: "programa" });
    expect(cls(row({ stage: "por_despachar", substage: "listo_para_recojo", courierPickup: { courier: "aliclik", date: "2026-11-18" } }))).toMatchObject({ agenda: "2026-11-18", agendaOrigin: "recojo", courier: "guia_creada" });
    expect(cls(failed({ programmedFor: "2026-11-16" }), caseOf({ list: "programados", agreement: { agreedOn: "2026-11-19" } }))).toMatchObject({ agenda: "2026-11-19", agendaOrigin: "acuerdo" });
  });

  it("con el courier, la Agenda solo lo lleva si tiene un día por delante; un día que pasó ya no es una fecha por cumplir", () => {
    expect(cls(row({ stage: "en_curso", substage: "en_reparto", courier: "propio", programmedFor: "2026-11-12", ops: ops({ liveCouriers: ["propio"] }) }))).toMatchObject({ agenda: null, courier: "en_ruta" });
    expect(cls(row({ stage: "por_despachar", substage: "listo_para_recojo", ops: ops({ liveCouriers: ["gf_courier"] }) }))).toMatchObject({ agenda: null, courier: "guia_creada" });
  });

  it("las tarjetas: Hoy, cada día de reparto nombrado (el domingo solo con pedidos), Después y Sin fecha", () => {
    expect(agendaCards(TODAY, {}).map((c) => c.label)).toEqual(["Hoy", "Lun 16", "Mar 17", "Mié 18", "Jue 19", "Vie 20", "Después", "Sin fecha"]);
    expect(agendaCards("2026-11-14", {}).map((c) => c.label)).not.toContain("Dom 15");
    expect(agendaCards("2026-11-14", { "2026-11-15": 2 }).map((c) => c.label)).toContain("Dom 15");
  });
});

describe("ningún pedido se pierde: todos están en la Agenda o en manos del courier", () => {
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
  it("cada uno en uno o en los dos", () => {
    for (const r of rows) {
      const c = classes.get(r.orderId)!;
      expect(c.agenda !== null || c.courier !== null, r.orderId).toBe(true);
    }
    const counts = limaBoardCounts(rows, classes);
    expect(counts.task).toEqual({ primer_despacho: 1, no_entregados: 1, novedad: 1, llamar_despues: 0, por_cerrar: 0 });
    expect(counts.courier).toEqual({ guia_creada: 1, en_ruta: 2, retornando: 1 });
    expect(counts.agenda).toEqual({ hoy: 0, despues: 0, sin_fecha: 3, "2026-11-17": 1 });
  });
  it("en Todos, primero lo que pide al equipo (en el orden de sus tarjetas), después la Agenda, Sin fecha y el courier", () => {
    expect(limaBoardRows(rows, classes, "todos").map((r) => r.orderId)).toEqual(["a", "e", "f", "b", "h", "c", "d", "g"]);
  });
  it("No entregados sigue el orden de los casos (`sortRepro`)", () => {
    const two = [failed({ orderId: "x" }), failed({ orderId: "y" })];
    const c2 = classifyLimaRows(two, [], TODAY);
    expect(limaBoardRows(two, c2, "no_entregados", new Map([["y", 0], ["x", 1]])).map((r) => r.orderId)).toEqual(["y", "x"]);
  });
});

describe("el filtro de la URL (`atencion`)", () => {
  it("las claves nuevas pasan; un día que pasó abre Hoy; lo desconocido, Todos", () => {
    for (const key of ["primer_despacho", "no_entregados", "novedad", "llamar_despues", "por_cerrar", "guia_creada", "en_ruta", "retornando", "hoy", "despues", "sin_fecha", "reprogramados", "esperan_anulacion"]) {
      expect(boardFilter(key, TODAY)).toBe(key);
    }
    expect(boardFilter("2026-11-18", TODAY)).toBe("2026-11-18");
    expect(boardFilter("2026-11-10", TODAY)).toBe("hoy");
    expect(boardFilter("2026-13-45", TODAY)).toBe("todos");
    expect(boardFilter("DROP", TODAY)).toBe("todos");
  });
  it("cada clave tiene su título y su vacío para la lista", () => {
    expect(boardCard("no_entregados", TODAY)).toMatchObject({ label: "No entregados", block: "gestion" });
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
    expect(limaNextStep(row(), undefined, cls(row()), TODAY, now)).toBe("Confirmar los datos con la clienta y agendar la salida.");
    expect(limaNextStep(failed(), undefined, cls(failed()), TODAY, now)).toBe("Llamar a la clienta y acordar el día y el courier (Atender).");
    const llamar = caseOf({ list: "llamar_despues", nextCallAt: "2026-11-15T20:00:00Z" });
    expect(limaNextStep(failed(), llamar, cls(failed(), llamar), TODAY, now)).toBe("Llamar hoy 15:00.");
    const b = row({ scheduledOn: "2026-11-17" });
    expect(limaNextStep(b, undefined, cls(b), TODAY, now)).toBe("Sale el mar 17/11. Sin gestión salvo que la clienta cambie algo.");
    const vencido = row({ programmedFor: "2026-11-12", hasPriorDispatch: true });
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
  it("los días que ofrece: hoy y los próximos días de reparto", () => {
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
  it("los bloques dicen su cifra, filtran y llevan los trabados del equipo", async () => {
    const { ReproLimaBlocks } = await import("@/components/repro-lima-blocks");
    const rows = [row(), failed({ orderId: "e" })];
    const counts = limaBoardCounts(rows, classifyLimaRows(rows, [], TODAY));
    const html = renderToStaticMarkup(createElement(ReproLimaBlocks, {
      counts, today: TODAY, active: "no_entregados", onPick: () => {},
      stuck: { gestion: [{ reason: "sin_rotulo", count: 2 }], courier: [{ reason: "courier_no_recogio", count: 0 }] },
      activeStuck: null, onStuck: () => {},
    }));
    for (const text of ["Por gestionar hoy", "Agenda", "En manos del courier", "Confirmar primer despacho", "Lun 16", "Sin fecha", "Guía creada", "Trabados", "Sin rótulo"]) expect(html, text).toContain(text);
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*No entregados/);
    // Un trabado sin pedidos no se dibuja.
    expect(html).not.toContain("Guía creada y el courier no lo recogió");
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
    expect(board).toContain("<AgendarButton row={row} path={path} today={today} size={size}");
    expect(board).toContain('onClick={() => openDrawer(row.orderId, "reprolima")}>Atender</OpsButton>');
    expect(board).toContain("const result = await agendarReproLima({");
    expect(board).toContain("lines: groupApprovalFailures(failed) });");
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
  it("DESIGN.md describe los tres bloques y DEPLOY.md lleva su entrada, sin migración", () => {
    expect(flat(read("DESIGN.md"))).toContain("### Repro Lima: tres bloques sobre una lista (15-11-2026)");
    const entries = [...read("DEPLOY.md").matchAll(/^### (.+)$/gm)].map((m) => m[1]!);
    // Se busca por título: el orden de arriba lo deciden las entradas con migración.
    const entry = entries.find((title) => title.includes("Repro Lima por las tareas del equipo"));
    expect(entry).toBeDefined();
    expect(entry).toContain("sin migración");
  });
});
