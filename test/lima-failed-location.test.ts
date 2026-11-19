import { describe, expect, it } from "vitest";
import { classifyLimaRows, limaBoardCounts, limaNextStep } from "@/lib/repro-lima-blocks";
import { limaBlockDetails, limaDetailMatches } from "@/lib/lima-block-details";
import { limaReviewReasons } from "@/lib/lima-review";
import { limaSituations } from "@/lib/lima-situations";
import type { LimaPendingOrder, PendingCase } from "@/lib/repro-lima-pending";

const today = "2026-11-18";
const row = (over: Partial<LimaPendingOrder> = {}): LimaPendingOrder => ({
  orderId: "o", storeId: "s", storeName: "Kenku", orderName: "#Ejemplo", customerName: "Ejemplo", customerPhone: null,
  district: "Ate", orderTotal: 99, createdAt: "2026-11-09T15:00:00Z", macroSince: "2026-11-09T15:00:00Z",
  stage: "en_curso", substage: "en_transito", courier: "fenix", dispatchedAt: null, hasPriorDispatch: false,
  lastDepartureAt: null, attempts: 0, dispatchedWith: ["fenix"], programmedFor: null, salesChannel: null, address: null, reference: null,
  ops: { liveCouriers: ["fenix"], custody: "empresa", reportedStatus: null, courierDelivered: null, lastGfBox: null }, ...over,
});
const classify = (r: LimaPendingOrder, cases: PendingCase[] = []) => classifyLimaRows([r], cases, today).get(r.orderId)!;

describe("corrección de No entregados por evidencia de su salida", () => {
  it("la incidencia GF de una salida que sigue con el courier prevalece sobre el acuerdo vencido", () => {
    const r = row({ courier: "gf_courier", dispatchedWith: ["gf_courier"], dispatchedAt: "2026-11-16T15:00:00Z",
      ops: { ...row().ops!, custody: "courier", liveCouriers: ["gf_courier"], reportedStatus: "INCIDENT:NO_ANSWER" } });
    const old: PendingCase = { orderId: "o", list: "programados", agreement: { agreedOn: "2026-11-16", courier: "gf_courier" } };
    const cls = classify(r, [old]);
    expect(cls).toMatchObject({ step: "novedad", noReport: false, courier: "en_ruta", guide: true });
    expect(limaNextStep(r, old, cls, today)).toContain("acuerdo anterior vencido");
    expect(classify(r, [{ ...old, agreement: { ...old.agreement!, agreedOn: "2026-11-19" } }]).step).not.toBe("novedad");
    expect(classify(r, [{ ...old, list: "llamar_despues" }]).step).toBe("llamar_despues");
    expect(classify(r, [{ ...old, list: "cerrados" }]).step).toBe("por_cerrar");
    expect(classify({ ...r, substage: "en_retorno" }, [old]).step).not.toBe("novedad");
    expect(classify({ ...r, ops: { ...r.ops!, custody: "empresa" } }, [old]).step).not.toBe("novedad");
  });

  it("dos guías externas vivas priorizan conciliar las cajas sobre pedir otro intento, sin anular nada", () => {
    const r = row({ substage: "en_retorno", attempts: 1, ops: { ...row().ops!, custody: "retorno", liveCouriers: ["fenix", "gf_courier"] } });
    const before = JSON.stringify(r);
    const cls = classify(r);
    expect(cls.step).toBe("no_entregados");
    expect(limaNextStep(r, undefined, cls, today)).toContain("guías vivas de Swayp y GF Courier");
    expect(limaNextStep(r, undefined, cls, today)).toContain("antes de crear otra salida");
    expect(limaReviewReasons(r, cls)).toContain("guides");
    expect(JSON.stringify(r)).toBe(before);
  });
  it("Generada pendiente de recojo con acuerdo futuro pasa a Programados; sin esa prueba conserva bloque y pide revisión", () => {
    const r = row({ ops: { ...row().ops!, pickupPending: true } });
    const c: PendingCase = { orderId: "o", list: "programados", agreement: { agreedOn: "2026-11-19", courier: "fenix" } };
    expect(classify(r, [c])).toMatchObject({ step: "programados", courier: "guia_creada", noReport: false, agendaDay: "2026-11-19" });
    const doubtful = row();
    expect(classify(doubtful)).toMatchObject({ step: "no_entregados", noReport: true });
    expect(limaReviewReasons(doubtful, classify(doubtful))).toEqual(["custody", "departure"]);
    expect(limaNextStep(doubtful, undefined, classify(doubtful), today)).toContain("Verificar la salida");
    expect(classify(r, [{ orderId: "o", list: "cerrados" }]).step).toBe("por_cerrar");
  });

  it("la salida devuelta sin guía viva permanece No entregados por acordar, sin guía ni ruta sin reporte; un día nuevo permite Programados", () => {
    const r = row({ dispatchedAt: "2026-11-16T15:00:00Z", dispatchedWith: ["aliclik"], ops: { ...row().ops!, custody: "devuelto", liveCouriers: [], returnedToWarehouse: true } });
    const before = JSON.stringify(r);
    const cls = classify(r);
    expect(cls).toMatchObject({ step: "no_entregados", courier: null, guide: false, noReport: false });
    expect(limaDetailMatches(r, cls, "failed-agree")).toBe(true);
    expect(limaDetailMatches(r, cls, "location:warehouse")).toBe(true);
    expect(limaNextStep(r, undefined, cls, today)).toContain("devuelto a almacén");
    expect(classify({ ...r, programmedFor: "2026-11-19" }).step).toBe("programados");
    expect(JSON.stringify(r)).toBe(before);
  });

  it("ubicación suma el bloque, gestión se cruza y revisión cuenta una vez aun con varios motivos", () => {
    const rows = ["empresa", "courier", "retorno", "devuelto", null].map((custody, i) => row({ orderId: String(i), substage: "por_reprogramar_lima", attempts: 1, dispatchedWith: ["gf:Roy", "aliclik"], ops: { ...row().ops!, custody } }));
    const classes = classifyLimaRows(rows, [], today);
    const groups = limaBlockDetails(rows, classes, "no_entregados");
    expect(limaBoardCounts(rows, classes).failedLocation).toEqual({ warehouse: 2, courier: 1, returning: 1, unknown: 1 });
    expect(groups[0]?.items.reduce((sum, item) => sum + item.count, 0)).toBe(5);
    expect(groups[1]?.items.find((item) => item.key === "review")?.count).toBe(5);
    for (const group of groups) for (const item of group.items) expect(rows.filter((r) => limaDetailMatches(r, classes.get(r.orderId)!, item.key))).toHaveLength(item.count);
    expect(limaSituations(rows, classes, "no_entregados", today).reduce((sum, s) => sum + s.count, 0)).toBe(5);
    expect(limaNextStep(rows[2]!, undefined, classes.get("2")!, today)).toContain("cuando llegue al almacén");
  });

  it("Urpi en ruta con custodia empresa y acuerdo vencido conservan No entregados y sus motivos; no anula guías duplicadas", () => {
    const r = row({ courier: "urpi", dispatchedAt: "2026-11-16T17:00:00Z", dispatchedWith: ["urpi"], ops: { ...row().ops!, liveCouriers: ["urpi"] } });
    const c: PendingCase = { orderId: "o", list: "programados", agreement: { agreedOn: "2026-11-16" } };
    const cls = classify(r, [c]);
    expect(cls.step).toBe("no_entregados");
    expect(limaReviewReasons(r, cls)).toEqual(["custody", "agreement"]);
    const missing = { ...r, dispatchedWith: [], ops: { ...r.ops!, custody: "courier" } };
    expect(limaReviewReasons(missing, classify(missing))).toEqual(["history"]);
    const duplicate = { ...r, ops: { ...r.ops!, liveCouriers: ["fenix", "aliclik"] } };
    expect(limaReviewReasons(duplicate, classify(duplicate))).toContain("guides");
  });
});
