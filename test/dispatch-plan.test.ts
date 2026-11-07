// «Sale mañana» (owner, 07-11-2026; MOM §29.16): el día de cada pedido, lo que
// le falta y el resumen, iguales en Despacho del día y en Repro Lima.
import { describe, expect, it } from "vitest";
import { inPlan, nextDeliveryDay, planItems, planMissingText, planOverdueSince, planStep, planSummary, type PlanCandidate } from "@/lib/dispatch-plan";
import { EMPTY_QUEUE_FILTERS, filterQueue, planCandidateFromQueue, type QueueRow } from "@/lib/dispatch-day";

const c = (over: Partial<PlanCandidate> = {}): PlanCandidate => ({ orderId: "o1", day: "2026-11-07", box: null, labeled: true, armed: true, ...over });
const box = (day: string, over: Partial<NonNullable<PlanCandidate["box"]>> = {}) => ({ day, riderName: "Jhon", officeChecked: false, pickedUp: false, ...over });

describe("el próximo día de reparto", () => {
  it("es el día siguiente; después del sábado viene el lunes (Grupo GF no reparte domingo)", () => {
    expect(nextDeliveryDay("2026-11-06")).toBe("2026-11-07"); // vie → sáb
    expect(nextDeliveryDay("2026-11-07")).toBe("2026-11-09"); // sáb → lun
    expect(nextDeliveryDay("2026-11-08")).toBe("2026-11-09"); // dom → lun
    expect(nextDeliveryDay("2026-12-31")).toBe("2027-01-01"); // cambio de año (viernes)
  });
});

describe("qué sale ese día", () => {
  it("sin caja: su día o antes (lo que no salió sale en la próxima ruta); un día posterior no", () => {
    expect(inPlan(c({ day: "2026-11-07" }), "2026-11-07")).toBe(true);
    expect(inPlan(c({ day: "2026-11-05" }), "2026-11-07")).toBe(true);
    expect(inPlan(c({ day: "2026-11-09" }), "2026-11-07")).toBe(false);
    expect(inPlan(c({ day: null }), "2026-11-07")).toBe(false);
  });
  it("en una caja: solo si la caja es de ese día; la caja manda sobre el programa", () => {
    expect(inPlan(c({ day: "2026-11-05", box: box("2026-11-07") }), "2026-11-07")).toBe(true);
    expect(inPlan(c({ day: "2026-11-07", box: box("2026-11-06") }), "2026-11-07")).toBe(false);
  });
  it("lo que debía salir antes se marca; en caja no", () => {
    expect(planOverdueSince(c({ day: "2026-11-05" }), "2026-11-07")).toBe("2026-11-05");
    expect(planOverdueSince(c({ day: "2026-11-07" }), "2026-11-07")).toBeNull();
    expect(planOverdueSince(c({ day: "2026-11-05", box: box("2026-11-07") }), "2026-11-07")).toBeNull();
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
    ], "2026-11-07");
    const s = planSummary(items);
    expect(s.total).toBe(5);
    expect(s.steps).toEqual({ sin_rotulo: 1, sin_armar: 1, sin_caja: 1, en_caja: 2 });
    expect(s.overdue).toBe(1);
    expect(s.officeChecked).toBe(2);
    expect(s.pickedUp).toBe(1);
    expect(s.riders).toEqual([{ name: "Ana", count: 2, unarmed: 1 }, { name: "Luis", count: 1, unarmed: 0 }]);
    expect(planMissingText(s)).toBe("Faltan 1 sin rótulo, 1 sin armar y 1 sin caja.");
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
  it("disponible: el día del corte o del programa; rótulo y armado por la subetapa", () => {
    expect(planCandidateFromQueue(row())).toMatchObject({ day: "2026-11-07", labeled: true, armed: true, box: null });
    expect(planCandidateFromQueue(row({ macroSubstage: "por_armar" }))).toMatchObject({ labeled: true, armed: false });
    expect(planCandidateFromQueue(row({ macroStage: "preparacion", macroSubstage: "por_generar_rotulo" }))).toMatchObject({ labeled: false, armed: false });
    expect(planCandidateFromQueue(row({ programmedFor: "2026-11-09" }))?.day).toBe("2026-11-09");
    // Un reintento que sale con salida nueva todavía no tiene rótulo.
    expect(planCandidateFromQueue(row({ macroStage: "en_curso", macroSubstage: "por_reprogramar_lima", newOutputOnTake: true }))).toMatchObject({ labeled: false });
  });
  it("tomado sin caja: el día de la solicitud y su armado; en caja: el día de la caja y su motorizado", () => {
    expect(planCandidateFromQueue(row({ taken: true, armed: false, scheduledFor: "2026-11-06" }))).toMatchObject({ day: "2026-11-06", labeled: true, armed: false });
    expect(planCandidateFromQueue(row({ taken: true, assignable: false, armed: true, route: route("2026-11-07", { officeCheckedAt: "x" }) }))).toMatchObject({
      box: { day: "2026-11-07", riderName: "Jhon", officeChecked: true, pickedUp: false }, armed: true,
    });
    // Seguimiento sin caja (cerrado): no es del plan.
    expect(planCandidateFromQueue(row({ assignable: false }))).toBeNull();
  });
  it("el filtro «Sale mañana» lista también lo que ya está en una caja de ese día, y por paso", () => {
    const rows = [
      row({ orderId: "libre" }),
      row({ orderId: "despues", programmedFor: "2026-11-09" }),
      row({ orderId: "en-caja", taken: true, assignable: false, armed: true, route: route("2026-11-07") }),
      row({ orderId: "caja-hoy", taken: true, assignable: false, armed: true, route: route("2026-11-06") }),
      row({ orderId: "sin-rotulo", macroStage: "preparacion", macroSubstage: "por_generar_rotulo" }),
    ];
    const plan = (step: null | "sin_caja" | "en_caja" | "sin_rotulo") => filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, plan: { day: "2026-11-07", step } }, "2026-11-06").map((r) => r.orderId);
    expect(plan(null)).toEqual(["libre", "en-caja", "sin-rotulo"]);
    expect(plan("sin_caja")).toEqual(["libre"]);
    expect(plan("en_caja")).toEqual(["en-caja"]);
    expect(plan("sin_rotulo")).toEqual(["sin-rotulo"]);
    // Sin el filtro, la cola de siempre: lo que está en caja no se lista.
    expect(filterQueue(rows, EMPTY_QUEUE_FILTERS, "2026-11-06").map((r) => r.orderId)).toEqual(["libre", "despues", "sin-rotulo"]);
  });
});
