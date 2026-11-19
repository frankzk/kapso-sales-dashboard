import { describe, expect, it } from "vitest";
import { limaBlockDetails, limaDepartureState, limaDetailMatches, limaHistoryText } from "@/lib/lima-block-details";
import { classifyLimaRows, LIMA_STEPS, type LimaRowClass, type LimaStep } from "@/lib/repro-lima-blocks";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";

const row = (extra: Partial<LimaPendingOrder> = {}): LimaPendingOrder => ({
  orderId: "a", storeId: "s", storeName: "Kenku", orderName: "#KP1", customerName: "María", customerPhone: null,
  district: "Ate", orderTotal: 99, createdAt: "2026-11-17T15:00:00Z", macroSince: null,
  stage: "preparacion", substage: "por_generar_rotulo", courier: null, dispatchedAt: null,
  hasPriorDispatch: false, lastDepartureAt: null, attempts: 0, dispatchedWith: [], programmedFor: null,
  salesChannel: null, address: null, reference: null, ...extra,
});
const cls = (r: LimaPendingOrder) => classifyLimaRows([r], [], "2026-11-18").get(r.orderId)!;

describe("detalle operativo de los ocho bloques", () => {
  it("una guía o motorizado asignado no demuestra una salida; cero visitas tampoco demuestra que nunca salió", () => {
    const fresh = row({ courier: "gf_courier", gfAssigned: { rider: "Alexis", day: "2026-11-18" } });
    expect(limaDepartureState(fresh)).toBe("never");
    expect(limaHistoryText(fresh)).not.toContain("Alexis");
    const inRoute = row({ stage: "en_curso", substage: "en_reparto", dispatchedAt: "2026-11-18T14:00:00Z" });
    expect(limaDepartureState(inRoute)).toBe("left");
    expect(limaHistoryText(inRoute)).toContain("0 intentos registrados");
    expect(limaDepartureState(row({ stage: "en_curso", substage: "por_reprogramar_lima" }))).toBe("unknown");
    expect(limaDepartureState(row({ stage: "en_curso", substage: "por_reprogramar_lima", neverLeft: true }))).toBe("never");
  });

  it("en cada paso, las particiones suman y cada cifra abre exactamente los pedidos contados", () => {
    for (const step of LIMA_STEPS) {
      const rows = [row(), row({ orderId: "b", attempts: 2, hasPriorDispatch: true, dispatchedWith: ["gf:Roy", "aliclik", "aliclik"], programmedFor: "2026-11-19" }), row({ orderId: "c", stage: "en_curso", substage: "por_reprogramar_lima" })];
      const classes = new Map(rows.map((r) => [r.orderId, { ...cls(r), step }]));
      const groups = limaBlockDetails(rows, classes, step);
      for (const index of [0, 1]) expect(groups[index]!.items.reduce((sum, item) => sum + item.count, 0)).toBe(3);
      for (const index of [2, 3]) expect(groups[index]!.items.slice(0, 2).reduce((sum, item) => sum + item.count, 0)).toBe(3);
      for (const group of groups) for (const item of group.items) {
        expect(item.count).toBe(rows.filter((r) => limaDetailMatches(r, classes.get(r.orderId)!, item.key)).length);
      }
      expect(groups.find((g) => g.title === "Salió con (historial)")?.items.find((i) => i.label === "Aliclik")?.count).toBe(1);
      expect(limaBlockDetails(rows.slice(1, 2), classes, step)[0]!.items.find((i) => i.key === "left")?.count).toBe(1);
    }
  });

  it("cuenta una vez por pedido aunque tenga varias guías y conserva el documento anulado del caso por cerrar", () => {
    const r = row({ attempts: 1, ops: { liveCouriers: [], reportedStatus: null, courierDelivered: null, lastGfBox: null, guides: { total: 3, annulled: 2, returned: 1 } } });
    const c: LimaRowClass = { ...cls(r), step: "por_cerrar", awaitingCancel: true, guide: false };
    const groups = limaBlockDetails([r], new Map([[r.orderId, c]]), "por_cerrar");
    expect(groups.flatMap((g) => g.items).find((i) => i.key === "any-guide-cancel")?.count).toBe(1);
    expect(limaDetailMatches(r, c, "guide-cancel")).toBe(false);
    expect(limaDetailMatches(r, c, "annulled-guide")).toBe(true);
    expect(limaDetailMatches(r, c, "returned-guide")).toBe(true);
  });

  it("reprogramados son el acuerdo vigente o una nueva fecha después de salir, no una ruta que sigue en la calle", () => {
    const r = row({ hasPriorDispatch: true, attempts: 2, programmedFor: "2026-11-19" });
    expect(limaDetailMatches(r, { ...cls(r), guide: true }, "guide-reprogrammed")).toBe(true);
    expect(limaDetailMatches(r, { ...cls(r), guide: false }, "no-guide-reprogrammed")).toBe(true);
    expect(limaDetailMatches(r, { ...cls(r), courier: "en_ruta" }, "reprogrammed")).toBe(false);
    expect(limaDetailMatches(row(), { ...cls(row()), agreed: true, agendaDay: "2026-11-19" }, "reprogrammed")).toBe(true);
    expect(limaDetailMatches(row(), cls(row()), "reprogrammed")).toBe(false);
  });

  it("el courier histórico no se reemplaza por el courier de la siguiente salida", () => {
    const r = row({ courier: "gf_courier", courierDetail: "Alexis", dispatchedWith: ["tanders", "gf:Roy"], attempts: 2 });
    const c = cls(r);
    expect(limaDetailMatches(r, c, "with:gf:Roy")).toBe(true);
    expect(limaDetailMatches(r, c, "with:gf_courier")).toBe(false);
    expect(limaHistoryText(r)).toContain("Grupo GF · Roy");
    expect(limaHistoryText(r)).not.toContain("Alexis");
    const other = { ...c, step: "no_entregados" as LimaStep };
    expect(limaBlockDetails([r], new Map([[r.orderId, other]]), "nuevos")[0]!.items.every((i) => i.count === 0)).toBe(true);
  });

  it("un courier histórico elegido sigue visible con cero al cambiar los filtros", () => {
    const r = row();
    const groups = limaBlockDetails([r], new Map([[r.orderId, cls(r)]]), "nuevos", "with:gf:Roy");
    expect(groups.flatMap((g) => g.items).find((i) => i.key === "with:gf:Roy")).toMatchObject({ count: 0, label: "Grupo GF · Roy" });
    const many = row({ attempts: 5 });
    expect(limaBlockDetails([many], new Map([[many.orderId, { ...cls(many), step: "nuevos" }]]), "nuevos")[1]?.items.find((i) => i.key === "attempts:5")?.count).toBe(1);
    expect(limaDetailMatches(many, cls(many), "attempts:5")).toBe(true);
  });
});
