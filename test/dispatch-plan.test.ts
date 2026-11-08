// «Sale mañana» (owner, 07-11-2026; MOM §29.16): el día de cada pedido, lo que
// le falta y el resumen, iguales en Despacho del día y en Repro Lima.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DispatchPlanPanel, planDayOptions } from "@/components/dispatch-plan-panel";
import { deliveryDayOnOrAfter, inPlan, isDeliveryDay, nextDeliveryDay, planItems, planMissingText, planOpenDay, planOverdueSince, planStep, planSummary, type PlanCandidate } from "@/lib/dispatch-plan";
import { EMPTY_QUEUE_FILTERS, filterQueue, planCandidateFromQueue, type QueueRow } from "@/lib/dispatch-day";

const c = (over: Partial<PlanCandidate> = {}): PlanCandidate => ({ orderId: "o1", day: "2026-11-07", box: null, labeled: true, armed: true, ...over });
const box = (day: string, over: Partial<NonNullable<PlanCandidate["box"]>> = {}) => ({ day, riderName: "Jhon", officeChecked: false, pickedUp: false, ...over });
// Viernes 06-11-2026, sábado 07, domingo 08, lunes 09.
const VIE = "2026-11-06";
const SAB = "2026-11-07";
const DOM = "2026-11-08";
const LUN = "2026-11-09";

describe("los días de reparto", () => {
  it("el próximo es el día siguiente; después del sábado viene el lunes (Grupo GF no reparte domingo)", () => {
    expect(nextDeliveryDay(VIE)).toBe(SAB);
    expect(nextDeliveryDay(SAB)).toBe(LUN);
    expect(nextDeliveryDay(DOM)).toBe(LUN);
    expect(nextDeliveryDay("2026-12-31")).toBe("2027-01-01"); // cambio de año (viernes)
    expect(isDeliveryDay(SAB)).toBe(true);
    expect(isDeliveryDay(DOM)).toBe(false);
    expect(deliveryDayOnOrAfter(DOM)).toBe(LUN);
    expect(deliveryDayOnOrAfter(SAB)).toBe(SAB);
  });
  it("el primer día que se prepara: hoy antes del corte; después, o el domingo, el próximo reparto", () => {
    expect(planOpenDay(VIE, false)).toBe(VIE);
    expect(planOpenDay(VIE, true)).toBe(SAB);
    expect(planOpenDay(SAB, true)).toBe(LUN);
    expect(planOpenDay(DOM, false)).toBe(LUN);
  });
});

describe("qué sale ese día", () => {
  it("antes del corte: lo atrasado y lo de hoy salen hoy, no mañana; mañana solo lo de mañana", () => {
    const open = planOpenDay(VIE, false);
    expect(inPlan(c({ day: VIE }), VIE, open)).toBe(true);
    expect(inPlan(c({ day: "2026-11-04" }), VIE, open)).toBe(true);
    expect(inPlan(c({ day: SAB }), VIE, open)).toBe(false);
    expect(inPlan(c({ day: SAB }), SAB, open)).toBe(true);
    // Revisión 07-11: «Mañana» contaba lo de hoy como «debían salir antes».
    expect(inPlan(c({ day: VIE }), SAB, open)).toBe(false);
    expect(inPlan(c({ day: "2026-11-04" }), SAB, open)).toBe(false);
    expect(inPlan(c({ day: null }), VIE, open)).toBe(false);
    expect(planOverdueSince(c({ day: VIE }), open)).toBeNull();
    expect(planOverdueSince(c({ day: "2026-11-04" }), open)).toBe("2026-11-04");
  });
  it("sábado después del corte: lo del domingo es del lunes y no está atrasado; lo del sábado sin caja sí", () => {
    const open = planOpenDay(SAB, true);
    expect(open).toBe(LUN);
    expect(inPlan(c({ day: DOM }), LUN, open)).toBe(true);
    expect(planOverdueSince(c({ day: DOM }), open)).toBeNull();
    expect(inPlan(c({ day: SAB }), LUN, open)).toBe(true);
    expect(planOverdueSince(c({ day: SAB }), open)).toBe(SAB);
    // «Hoy» pasado el corte: solo lo que ya está en las cajas de hoy.
    expect(inPlan(c({ day: SAB }), SAB, open)).toBe(false);
    expect(inPlan(c({ day: SAB, box: box(SAB) }), SAB, open)).toBe(true);
    // Lo programado para después del lunes no sale el lunes.
    expect(inPlan(c({ day: "2026-11-10" }), LUN, open)).toBe(false);
  });
  it("en una caja: solo si la caja es de ese día; la caja manda sobre el programa y nunca está atrasada", () => {
    expect(inPlan(c({ day: "2026-11-05", box: box(SAB) }), SAB, VIE)).toBe(true);
    expect(inPlan(c({ day: SAB, box: box(VIE) }), SAB, VIE)).toBe(false);
    expect(planOverdueSince(c({ day: "2026-11-05", box: box(SAB) }), SAB)).toBeNull();
  });
});

describe("lo primero que le falta", () => {
  it("rótulo, armado, caja; en la caja sin armar sigue siendo «Sin armar»", () => {
    expect(planStep(c({ labeled: false, armed: false }))).toBe("sin_rotulo");
    expect(planStep(c({ armed: false }))).toBe("sin_armar");
    expect(planStep(c())).toBe("sin_caja");
    expect(planStep(c({ box: box("2026-11-07") }))).toBe("en_caja");
    expect(planStep(c({ armed: false, box: box("2026-11-07") }))).toBe("sin_armar");
  });
  it("el resumen cuenta cada pedido una vez, por motorizado, y dice lo que falta", () => {
    const items = planItems([
      c({ orderId: "a", labeled: false, armed: false }),
      c({ orderId: "b", armed: false, box: box("2026-11-07", { riderName: "Ana" }) }),
      c({ orderId: "c", day: "2026-11-05" }),
      c({ orderId: "d", box: box("2026-11-07", { riderName: "Ana", officeChecked: true }) }),
      c({ orderId: "e", box: box("2026-11-07", { riderName: "Luis", officeChecked: true, pickedUp: true }) }),
      c({ orderId: "f", day: "2026-11-09" }),
      // La misma orden en dos filas (la caja y la cola): cuenta una vez, la de la caja.
      c({ orderId: "d", day: "2026-11-07" }),
      c({ orderId: "g", day: "2026-11-07", awaitingOffice: true }),
    ], "2026-11-07", "2026-11-07");
    const s = planSummary(items);
    expect(s.total).toBe(6);
    expect(s.steps).toEqual({ sin_rotulo: 1, sin_armar: 1, sin_caja: 2, en_caja: 2 });
    expect(s.overdue).toBe(1);
    expect(s.awaitingOffice).toBe(1);
    expect(s.officeChecked).toBe(2);
    expect(s.pickedUp).toBe(1);
    expect(s.riders).toEqual([{ name: "Ana", count: 2, unarmed: 1 }, { name: "Luis", count: 1, unarmed: 0 }]);
    expect(planMissingText(s)).toBe("Faltan 1 sin rótulo, 1 sin armar y 2 sin caja.");
    // Con uno solo, en singular.
    expect(planMissingText(planSummary(items.filter((i) => i.orderId === "c" || i.step === "en_caja")))).toBe("Falta 1 sin caja.");
    expect(planMissingText(planSummary(items.filter((i) => i.step === "en_caja")))).toBe("Todo armado y en caja.");
    expect(planMissingText(planSummary([]))).toBe("Nada que sacar ese día.");
  });
});

const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  orderId: "o1", orderName: "#KP1", storeName: "Kenku", customerName: "x", customerPhone: null, district: "Ate",
  orderTotal: 100, createdAt: "2026-11-06T18:00:00Z", scheduledFor: "2026-11-07", tariffAmount: 13, taken: false,
  requestId: null, armed: null, observation: null, hasPriorDispatch: false, programmedFor: null, macroStage: "por_despachar",
  macroSubstage: "listo_para_asignar", assignable: true, route: null, ...over,
} as QueueRow);
const route = (routeDate: string, over: Record<string, unknown> = {}) => ({ riderName: "Jhon", routeDate, loadNumber: 1, state: "draft", officeCheckedAt: null, pickupCheckedAt: null, ...over });

describe("Despacho del día: cada fila de la cola", () => {
  const T = VIE;
  it("disponible: el día del corte o del programa; rótulo y armado por la subetapa", () => {
    expect(planCandidateFromQueue(row(), T)).toMatchObject({ day: SAB, labeled: true, armed: true, box: null });
    expect(planCandidateFromQueue(row({ macroSubstage: "por_armar" }), T)).toMatchObject({ labeled: true, armed: false });
    expect(planCandidateFromQueue(row({ macroStage: "preparacion", macroSubstage: "por_generar_rotulo" }), T)).toMatchObject({ labeled: false, armed: false });
    expect(planCandidateFromQueue(row({ programmedFor: LUN }), T)?.day).toBe(LUN);
    // Un reintento que sale con salida nueva todavía no tiene rótulo.
    expect(planCandidateFromQueue(row({ macroStage: "en_curso", macroSubstage: "por_reprogramar_lima", programmedFor: SAB, newOutputOnTake: true }), T)).toMatchObject({ labeled: false });
    // Una guía de Tanders o Swayp en revisión también: al tomarla nace otra salida.
    expect(planCandidateFromQueue(row({ macroStage: "en_curso", macroSubstage: "en_transito", tandersReview: { kind: "tanders" } as unknown as QueueRow["tandersReview"] }), T)).toMatchObject({ labeled: false, armed: false });
  });
  it("tomado sin caja: el día de la solicitud y su armado; en caja de hoy en adelante: el día de la caja y su motorizado", () => {
    expect(planCandidateFromQueue(row({ taken: true, armed: false, scheduledFor: "2026-11-05" }), T)).toMatchObject({ day: "2026-11-05", labeled: true, armed: false });
    expect(planCandidateFromQueue(row({ taken: true, assignable: false, armed: true, route: route(SAB, { officeCheckedAt: "x" }) }), T)).toMatchObject({
      box: { day: SAB, riderName: "Jhon", officeChecked: true, pickedUp: false }, armed: true,
    });
    // Seguimiento sin caja (cerrado): no es del plan.
    expect(planCandidateFromQueue(row({ assignable: false }), T)).toBeNull();
  });
  it("un «Por reprogramar Lima» tomado sin acuerdo ni programa espera a la tienda: no entra", () => {
    const retry = { macroStage: "en_curso", macroSubstage: "por_reprogramar_lima", taken: true, armed: true, scheduledFor: "2026-11-04" };
    expect(planCandidateFromQueue(row(retry), T)).toBeNull();
    expect(planCandidateFromQueue(row({ ...retry, programmedFor: LUN }), T)).toMatchObject({ day: LUN, box: null });
  });
  it("una caja de un día que pasó no fija el día: manda el programa y, si el motorizado la tiene, se recibe en oficina", () => {
    const old = { macroStage: "en_curso", macroSubstage: "por_reprogramar_lima", taken: true, assignable: false, armed: true };
    expect(planCandidateFromQueue(row({ ...old, route: route("2026-11-04", { state: "in_custody" }), planProgramDay: LUN }), T))
      .toMatchObject({ day: LUN, box: null, labeled: true, armed: true, awaitingOffice: true });
    // Sin programa ni acuerdo: espera a la tienda.
    expect(planCandidateFromQueue(row({ ...old, route: route("2026-11-04", { state: "in_custody" }) }), T)).toBeNull();
    // Una caja que nunca salió (borrador del 19/10): el paquete está en oficina.
    expect(planCandidateFromQueue(row({ ...old, route: route("2026-10-19"), planProgramDay: SAB }), T)).toMatchObject({ day: SAB, awaitingOffice: false });
    // Lo cerrado no vuelve al plan.
    expect(planCandidateFromQueue(row({ ...old, macroStage: "por_cerrar", route: route("2026-11-04"), planProgramDay: SAB }), T)).toBeNull();
  });
  it("el acuerdo de Repro Lima: con otro courier no sale con Grupo GF; con Grupo GF sale ese día; uno vencido no cuenta", () => {
    expect(planCandidateFromQueue(row({ reproAgreement: { day: "2026-11-16", courier: "aliclik" } }), T)).toBeNull();
    expect(planCandidateFromQueue(row({ reproAgreement: { day: "2026-11-11", courier: "propio" } }), T)?.day).toBe("2026-11-11");
    expect(planCandidateFromQueue(row({ reproAgreement: { day: "2026-11-02", courier: "aliclik" } }), T)?.day).toBe(SAB);
    // Ya en una caja vigente de Grupo GF, la caja manda.
    expect(planCandidateFromQueue(row({ assignable: false, taken: true, route: route(SAB), reproAgreement: { day: "2026-11-16", courier: "aliclik" } }), T)?.box?.day).toBe(SAB);
  });
  it("el filtro «Sale a reparto» lista también lo que ya está en una caja de ese día, y por paso", () => {
    const rows = [
      row({ orderId: "libre" }),
      row({ orderId: "despues", programmedFor: LUN }),
      row({ orderId: "en-caja", taken: true, assignable: false, armed: true, route: route(SAB) }),
      row({ orderId: "caja-hoy", taken: true, assignable: false, armed: true, route: route(VIE) }),
      row({ orderId: "sin-rotulo", macroStage: "preparacion", macroSubstage: "por_generar_rotulo" }),
    ];
    const plan = (step: null | "sin_caja" | "en_caja" | "sin_rotulo") => filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, plan: { day: SAB, openDay: VIE, step } }, VIE).map((r) => r.orderId);
    expect(plan(null)).toEqual(["libre", "en-caja", "sin-rotulo"]);
    expect(plan("sin_caja")).toEqual(["libre"]);
    expect(plan("en_caja")).toEqual(["en-caja"]);
    expect(plan("sin_rotulo")).toEqual(["sin-rotulo"]);
    // Sin el filtro, la cola de siempre: lo que está en caja no se lista.
    expect(filterQueue(rows, EMPTY_QUEUE_FILTERS, VIE).map((r) => r.orderId)).toEqual(["libre", "despues", "sin-rotulo"]);
  });
});

describe("la tarjeta «Sale a reparto»", () => {
  it("el domingo no ofrece «Hoy»: solo el lunes", () => {
    expect(planDayOptions(VIE, SAB).map((o) => o.label)).toEqual(["Hoy · vie 06/11", "Mañana · sáb 07/11"]);
    expect(planDayOptions(SAB, LUN).map((o) => o.label)).toEqual(["Hoy · sáb 07/11", "Próximo reparto · lun 09/11"]);
    expect(planDayOptions(DOM, LUN).map((o) => o.label)).toEqual(["Mañana · lun 09/11"]);
  });
  it("con uno, en singular: «debía salir», «cotejado», «recibido», y lo que se recibe en oficina", () => {
    const summary = planSummary(planItems([
      c({ orderId: "a", day: VIE }),
      c({ orderId: "b", box: box(SAB, { officeChecked: true, pickedUp: true }) }),
      c({ orderId: "g", day: SAB, awaitingOffice: true }),
    ], SAB, SAB));
    const html = renderToStaticMarkup(createElement(DispatchPlanPanel, { planDay: SAB, options: planDayOptions(VIE, SAB), onPlanDay: () => {}, summary, activeStep: null, onStep: () => {} }));
    expect(html).toContain("Faltan 2 sin caja.");
    expect(html).toContain("1 debía salir antes.");
    expect(html).toContain("1 sigue con el motorizado en una caja anterior: recíbelo en oficina.");
    expect(html).toContain("1 cotejado en oficina · 1 recibido por el motorizado");
  });
  it("Despacho del día decide el corte con la hora del servidor y mueve «Día de la caja» con el día del plan", () => {
    const board = readFileSync("components/dispatch-day-board.tsx", "utf8");
    expect(board).toContain("limaClock(props.nowIso ? new Date(props.nowIso) : new Date())");
    expect(board).toContain("const openDay = planOpenDay(day, afterCutoff);");
    expect(board).toContain("const [chosenPlanDay, setPlanDay] = useState(openDay);");
    const tap = board.slice(board.indexOf("const tapPlanStep = "), board.indexOf("const preparePlanDay = "));
    expect(tap).toContain("if (!off) setScanDay(planDay);");
    const choose = board.slice(board.indexOf("const choosePlanDay = "), board.indexOf("const substageOptions = "));
    expect(choose).toContain("if (filters.plan) setScanDay(next);");
    expect(readFileSync("app/dashboard/courier/page.tsx", "utf8")).toContain("nowIso={nowIso}");
    expect(readFileSync("components/grupo-gf-courier.tsx", "utf8")).toContain("nowIso={nowIso}");
  });
});
