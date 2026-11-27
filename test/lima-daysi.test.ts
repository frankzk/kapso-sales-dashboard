import { describe, expect, it } from "vitest";
import { classifyLimaRows, limaBoardCounts, limaNextStep, limaStepPart, LIMA_STEPS } from "@/lib/repro-lima-blocks";
import { limaHistoricalProviders, limaNeedsReview, limaSituationKey, limaSituations, isLimaSituationKey } from "@/lib/lima-situations";
import { limaDetailMatches } from "@/lib/lima-block-details";
import type { LimaPendingOrder, PendingCase } from "@/lib/repro-lima-pending";

const TODAY = "2026-11-18";
const row = (over: Partial<LimaPendingOrder> = {}): LimaPendingOrder => ({
  orderId: "o", storeId: "a", storeName: "Kenku", orderName: "#KP1", customerName: "Ejemplo", customerPhone: null,
  district: "Ate", orderTotal: 99, createdAt: "2026-11-18T15:00:00Z", macroSince: null,
  stage: "preparacion", substage: "por_generar_rotulo", courier: null, dispatchedAt: null, attempts: 0,
  hasPriorDispatch: false, lastDepartureAt: null, dispatchedWith: [], programmedFor: null, salesChannel: null, address: null, reference: null,
  management: { hasCall: false, lastCallAt: null, lastCallResult: null, movedToLimaAt: null }, ...over,
});
const classify = (r: LimaPendingOrder, cases: PendingCase[] = []) => classifyLimaRows([r], cases, TODAY).get(r.orderId)!;

describe("clasificación acordada con Daysi", () => {
  it("sin llamada es Nuevo; después de llamar es primera salida por sacar o programada", () => {
    const fresh = row();
    const called = row({ management: { ...fresh.management!, hasCall: true, lastCallAt: "2026-11-18T16:00:00Z" } });
    expect(classify(fresh).step).toBe("nuevos");
    expect(classify(called).step).toBe("por_sacar");
    expect(classify({ ...called, programmedFor: "2026-11-19" }).step).toBe("programados");
    expect(classify(fresh, [{ orderId: "o", list: "programados", agreement: { agreedOn: "2026-11-19" } }]).step).toBe("programados");
  });
  it.each(["aliclik", "fenix", "gf_courier"])("una guía viva de %s sale de Nuevos aunque nunca se haya repartido", (courier) => {
    const r = row({ substage: "listo_para_recojo", courier, ops: { liveCouriers: [courier], reportedStatus: null, courierDelivered: null, lastGfBox: null } });
    expect(classify(r).step).toBe("con_courier");
    expect(classify({ ...r, scheduledOn: "2026-11-19" }).step).toBe("programados");
  });
  it("la guía GF automática conserva Nuevo con su día y documento; gestión, acuerdo, otros couriers y salidas siguen excluyéndolo", () => {
    const r = row({ stage: "preparacion", substage: "por_armar", courier: "gf_courier", courierPickup: { courier: "gf_courier", date: "2026-11-19" },
      ops: { autoGfGuide: true, liveCouriers: ["gf_courier"], custody: "empresa", reportedStatus: "CREATED:TO_PREPARE", courierDelivered: null, lastGfBox: null } });
    expect(classify(r)).toMatchObject({ step: "nuevos", agenda: "manana", agendaDay: "2026-11-19", guide: true });
    expect(limaDetailMatches(r, classify(r), "auto-gf-guide")).toBe(true);
    expect(classify({ ...r, courierPickup: null })).toMatchObject({ step: "nuevos", guide: true });
    expect(classify({ ...r, ops: { ...r.ops!, autoGfGuide: false } }).step).toBe("programados");
    expect(classify({ ...r, management: { ...r.management!, hasCall: true, lastCallAt: "2026-11-18T16:00:00Z" } }).step).toBe("programados");
    expect(classify(r, [{ orderId: r.orderId, list: "programados", agreement: { agreedOn: "2026-11-19" } }]).step).toBe("programados");
    expect(classify({ ...r, ops: { ...r.ops!, liveCouriers: ["gf_courier", "aliclik"] } }).step).toBe("programados");
    expect(classify({ ...r, courierPickup: { courier: "aliclik", date: "2026-11-19" } }).step).toBe("programados");
    expect(classify({ ...r, hasPriorDispatch: true, attempts: 1 }).step).toBe("programados");
    expect(classify(r, [{ orderId: r.orderId, list: "cerrados" }]).step).toBe("por_cerrar");
    expect(limaSituations([r], new Map([[r.orderId, classify(r)]]), "nuevos", TODAY)[0]?.title).toContain("guía GF automática");
  });
  it("una llamada de caso anterior a crear el pedido tampoco bloquea Nuevos", () => {
    const r = row();
    expect(classify(r, [{ orderId: r.orderId, list: "por_decidir", lastCall: { at: "2026-11-18T14:59:59Z" } }]).step).toBe("nuevos");
    expect(classify(r, [{ orderId: r.orderId, list: "por_decidir", lastCall: { at: r.createdAt! } }]).step).toBe("por_sacar");
  });
  // 19-11-2026: asignado con día, Programados (asignación no es salida física). 27-11-2026 (#KP208991): asignado para la
  // ruta de HOY, Con el courier · Asignado hoy (`test/repro-lima-asignado-hoy.test.ts`); para otro día, sigue Programados.
  it.each(["Roycker", "Yhonny", "Yordani", "Alexis"])("GF automático asignado a %s: para mañana, Programados; para hoy, Con el courier · Asignado hoy", (rider) => {
    const r = row({ stage: "por_despachar", substage: "listo_para_recojo", courier: "gf_courier", courierPickup: { courier: "gf_courier", date: "2026-11-19" },
      gfAssigned: { rider, day: "19/11", routeDate: "2026-11-19" },
      ops: { autoGfGuide: true, liveCouriers: ["gf_courier"], custody: "empresa", reportedStatus: "AWAITING_OFFICE_CHECK", courierDelivered: null, lastGfBox: null } });
    const before = JSON.stringify(r);
    const cls = classify(r);
    expect(cls).toMatchObject({ step: "programados", agenda: "manana", agendaDay: "2026-11-19", courier: "guia_creada", guide: true, noReport: false });
    expect(limaSituations([r], new Map([[r.orderId, cls]]), "programados", TODAY)[0]).toMatchObject({ title: expect.stringContaining("Nunca salió"), detail: expect.stringContaining(`Asignado para la siguiente ruta: ${rider}`) });
    expect(classify({ ...r, gfAssigned: null, suggestedRiders: [rider] }).step).toBe("nuevos");
    const today: LimaPendingOrder = { ...r, courierPickup: { courier: "gf_courier", date: TODAY }, gfAssigned: { rider, day: "18/11", routeDate: TODAY } };
    expect(classify(today)).toMatchObject({ step: "con_courier", courier: "asignado_hoy", agendaDay: TODAY, guide: true, noReport: false });
    expect(classify(r, [{ orderId: "o", list: "llamar_despues" }]).step).toBe("llamar_despues");
    expect(classify(r, [{ orderId: "o", list: "cerrados" }]).step).toBe("por_cerrar");
    const counts = limaBoardCounts([r], new Map([[r.orderId, cls]]));
    expect(counts.step.nuevos).toBe(0);
    expect(counts.step.programados).toBe(1);
    expect(Object.values(counts.step).reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(JSON.stringify(r)).toBe(before);
  });
  it.each(["propio", "por_definir"])("el rótulo interno %s permite Nuevos solo mientras siga sin gestionar y sin salida", (courier) => {
    const r = row({ stage: "por_despachar", substage: "listo_para_asignar", courier, ops: { liveCouriers: [courier], custody: "empresa", reportedStatus: null, courierDelivered: null, lastGfBox: null } });
    expect(classify(r)).toMatchObject({ step: "nuevos", guide: true });
    expect(classify({ ...r, management: { ...r.management!, hasCall: true } }).step).toBe("por_sacar");
    expect(classify({ ...r, hasPriorDispatch: true, attempts: 1, dispatchedWith: ["gf:Roy"] }).step).toBe("no_entregados");
    expect(classify(r, [{ orderId: r.orderId, list: "programados", agreement: { agreedOn: "2026-11-19" } }]).step).toBe("programados");
    const external = { ...r, ops: { ...r.ops!, liveCouriers: [courier, "aliclik"] } };
    expect(classify(external).step).toBe("con_courier");
  });
  it.each([1, 2, 3])("%s intentos previos sin nuevo día son No entregados, incluso en Preparación", (attempts) => {
    const r = row({ attempts, dispatchedWith: ["gf:Roy"] });
    expect(classify(r).step).toBe("no_entregados");
    expect(classify({ ...r, programmedFor: "2026-11-19" }).step).toBe("programados");
  });
  it("una guía anulada antes del recojo no demuestra reparto; sin evidencia se revisa para primera salida", () => {
    const r = row({ stage: "en_curso", substage: "por_reprogramar_lima", neverLeft: true });
    expect(classify(r).step).toBe("nuevos");
    expect(classify({ ...r, management: { ...r.management!, hasCall: true } }).step).toBe("por_sacar");
    expect(classify({ ...r, neverLeft: false }).step).toBe("por_sacar");
  });
  it("provincia corregida a Lima aparece en Hoy sin crear una fecha; conserva fechas reales y otras prioridades", () => {
    const r = row({ management: { hasCall: false, lastCallAt: null, lastCallResult: null, movedToLimaAt: "2026-11-18T14:00:00Z" } });
    const c = classify(r);
    expect(c).toMatchObject({ step: "nuevos", agenda: "hoy", agendaDay: null, needsToday: true });
    expect(limaStepPart(c)).toBe("nuevos_hoy");
    expect(limaNextStep(r, undefined, c, TODAY)).toContain("gestionar hoy");
    expect(r.programmedFor).toBeNull();
    expect(classify({ ...r, programmedFor: "2026-11-20" })).toMatchObject({ agendaDay: "2026-11-20", needsToday: false });
    expect(classify(r, [{ orderId: "o", list: "cerrados" }]).step).toBe("por_cerrar");
    expect(classify(r, [{ orderId: "o", list: "llamar_despues", nextCallAt: "2026-11-18T20:00:00Z" }]).step).toBe("llamar_despues");
  });
  it("la revisión distingue courier de motorizado y no modifica la venta ni los datos", () => {
    const r = row({ dispatchedWith: ["gf:Roy", "gf:Alexis", "gf", "propio"] });
    const before = JSON.stringify(r);
    expect(limaHistoricalProviders(r)).toEqual(["gf"]);
    expect(limaNeedsReview(r)).toBe(false);
    expect(limaNeedsReview({ ...r, dispatchedWith: [...r.dispatchedWith!, "aliclik"] })).toBe(true);
    expect(limaHistoricalProviders(row({ dispatchedWith: ["fenix", "swayp"] }))).toEqual(["fenix"]);
    expect(JSON.stringify(r)).toBe(before);
  });
});

describe("situaciones completas que particionan cada bloque", () => {
  it("agrupa solo combinaciones iguales y cada cifra abre exactamente sus pedidos", () => {
    const rows = [row({ orderId: "a" }), row({ orderId: "b" }), row({ orderId: "c", attempts: 2, dispatchedWith: ["gf:Roy", "aliclik"] }), row({ orderId: "d", management: { hasCall: true, lastCallAt: "2026-11-17T15:00:00Z", lastCallResult: "no_contesta", movedToLimaAt: null } })];
    for (const step of LIMA_STEPS) {
      const classes = new Map(rows.map((r) => [r.orderId, { ...classify(r), step }]));
      const situations = limaSituations(rows, classes, step, TODAY);
      expect(situations.reduce((sum, s) => sum + s.count, 0)).toBe(limaBoardCounts(rows, classes).step[step]);
      expect(situations).toHaveLength(3);
      for (const s of situations) {
        expect(isLimaSituationKey(s.key)).toBe(true);
        expect(rows.filter((r) => limaDetailMatches(r, classes.get(r.orderId)!, s.key))).toHaveLength(s.count);
      }
      expect(situations.find((s) => s.count === 2)?.title).toContain("Nunca salió");
      expect(situations.some((s) => s.detail.includes("Revisar posible cierre"))).toBe(true);
    }
  });
  it("una combinación cambia si cambia guía, custodia, fecha o resultado; no llama salida al asignado", () => {
    const r = row(); const c = classify(r); const key = limaSituationKey(r, c);
    expect(limaSituationKey(r, { ...c, guide: true })).not.toBe(key);
    expect(limaSituationKey(r, { ...c, agendaDay: "2026-11-19" })).not.toBe(key);
    expect(limaSituationKey(r, { ...c, courier: "guia_creada" })).not.toBe(limaSituationKey(r, { ...c, courier: "en_ruta" }));
    expect(isLimaSituationKey(`situation:${JSON.stringify(JSON.parse(key.slice(10)).slice(0, 23))}`)).toBe(true);
    expect(isLimaSituationKey("situation:[]")).toBe(false);
    const assigned = row({ gfAssigned: { rider: "Alexis", day: TODAY } });
    const [s] = limaSituations([assigned], new Map([[assigned.orderId, classify(assigned)]]), "nuevos", TODAY);
    expect(s?.title).toContain("Nunca salió");
    expect(s?.detail).toContain("Asignado para la siguiente ruta: Alexis");
  });
});
