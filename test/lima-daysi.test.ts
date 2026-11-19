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
