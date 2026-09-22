// Grupo GF en la ficha del pedido (MOM §29.13): quién lo tiene y en qué quedó.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gfDeliverySentence, gfDeliverySummary, limaWhen, pickLatestBox, pickLatestStop, type GfBoxItem, type GfStop } from "@/lib/gf-delivery";

const box = (over: Partial<GfBoxItem> = {}): GfBoxItem => ({
  manifestId: "m1",
  routeDate: "2026-09-22",
  loadNumber: 1,
  boxState: "in_custody",
  riderId: "roy",
  riderName: "Roy",
  addedAt: "2026-09-22T14:00:00Z",
  officeCheckedAt: "2026-09-22T14:05:00Z",
  pickupCheckedAt: null,
  pickupDeclinedAt: null,
  pickupDeclinedReason: null,
  removedAt: null,
  removalReason: null,
  ...over,
});

const stop = (over: Partial<GfStop> = {}): GfStop => ({
  id: "s1",
  status: "pendiente",
  outcomeReason: null,
  note: null,
  reportedAt: null,
  paymentMethod: null,
  collectedAmount: null,
  photoPath: null,
  voucherPath: null,
  pickupConfirmed: null,
  routeDate: "2026-09-22",
  routeStatus: "en_curso",
  riderName: "Roy",
  seq: 3,
  ...over,
});

describe("gfDeliverySummary", () => {
  it("sin caja ni parada no hay nada que decir", () => {
    expect(gfDeliverySummary({ shipmentId: "x", box: null, stop: null })).toBeNull();
    expect(gfDeliverySentence(null)).toBeNull();
  });

  it("en la caja sin «Lo llevo»: dice la caja y si está cotejado", () => {
    const s = gfDeliverySummary({ shipmentId: "x", box: box(), stop: null })!;
    expect(s.phase).toBe("en_caja");
    expect(s.label).toBe("En la caja de Roy");
    expect(s.detail).toBe("caja del 22/09 · cotejado en oficina · sin «Lo llevo» del motorizado");
    expect(gfDeliverySummary({ shipmentId: "x", box: box({ officeCheckedAt: null, loadNumber: 2 }), stop: null })!.detail).toContain("carga 2 · sin cotejar");
  });

  it("«Lo llevo»: lo lleva Roy desde la hora, con la parada pendiente", () => {
    const s = gfDeliverySummary({ shipmentId: "x", box: box({ pickupCheckedAt: "2026-09-22T15:32:00Z" }), stop: stop() })!;
    expect(s.phase).toBe("lo_lleva");
    expect(s.tone).toBe("sky");
    expect(s.label).toBe("Lo lleva Roy");
    // 15:32Z son las 10:32 en Lima.
    expect(s.detail).toBe("desde 22/09 10:32 · caja del 22/09 · parada 3 pendiente");
    expect(gfDeliverySentence({ shipmentId: "x", box: box({ pickupCheckedAt: "2026-09-22T15:32:00Z" }), stop: null })).toBe("Lo lleva Roy · desde 22/09 10:32 · caja del 22/09 · parada pendiente");
  });

  it("«No lo llevo» manda sobre la caja, con su motivo", () => {
    const s = gfDeliverySummary({ shipmentId: "x", box: box({ pickupDeclinedAt: "2026-09-22T15:40:00Z", pickupDeclinedReason: "danado", removedAt: "2026-09-22T15:40:00Z", removalReason: "No recogido por Roy: danado" }), stop: null })!;
    expect(s.phase).toBe("no_lo_llevo");
    expect(s.label).toBe("No lo llevó Roy");
    expect(s.detail).toBe("Está dañado · 22/09 10:40 · vuelve a «por asignar»");
  });

  it("retirado por el supervisor, con el motivo escrito", () => {
    const s = gfDeliverySummary({ shipmentId: "x", box: box({ removedAt: "2026-09-22T16:00:00Z", removalReason: "Movido a la caja de Yhoni" }), stop: null })!;
    expect(s.phase).toBe("retirado");
    expect(s.label).toBe("Retirado de la caja de Roy");
    expect(s.detail).toBe("Movido a la caja de Yhoni · 22/09 11:00 · caja del 22/09");
  });

  it("la parada reportada manda sobre la caja: entregado con cobro y hora", () => {
    const s = gfDeliverySummary({
      shipmentId: "x",
      box: box({ pickupCheckedAt: "2026-09-22T15:32:00Z" }),
      stop: stop({ status: "entregado", reportedAt: "2026-09-22T19:32:00Z", paymentMethod: "yape", collectedAmount: 89, pickupConfirmed: true }),
    })!;
    expect(s.phase).toBe("entregado");
    expect(s.tone).toBe("emerald");
    expect(s.label).toBe("Entregado por Roy");
    expect(s.detail).toBe("22/09 14:32 · Yape S/ 89.00");
  });

  it("entregado sin «Lo llevo» lo dice, y sin cobro también", () => {
    const s = gfDeliverySummary({ shipmentId: "x", box: box(), stop: stop({ status: "entregado", reportedAt: "2026-09-22T19:32:00Z", paymentMethod: "sin_cobro", pickupConfirmed: false, note: "Dejado con el portero" }) })!;
    expect(s.detail).toBe("22/09 14:32 · sin cobro · entregado sin confirmar recojo · Dejado con el portero");
  });

  it("no entregado: rechazado es rojo; reprogramado o «no estaba» es postergado en ámbar", () => {
    const rejected = gfDeliverySummary({ shipmentId: "x", box: box(), stop: stop({ status: "no_entregado", outcomeReason: "rechazado", reportedAt: "2026-09-22T19:00:00Z" }) })!;
    expect(rejected.phase).toBe("no_entregado");
    expect(rejected.tone).toBe("red");
    expect(rejected.label).toBe("No entregado por Roy");
    expect(rejected.detail).toBe("Rechazó el pedido · 22/09 14:00");
    const later = gfDeliverySummary({ shipmentId: "x", box: box(), stop: stop({ status: "no_entregado", outcomeReason: "reprogramado", reportedAt: "2026-09-22T19:00:00Z", note: "Mañana en la tarde" }) })!;
    expect(later.phase).toBe("postergado");
    expect(later.tone).toBe("amber");
    expect(later.label).toBe("Postergado por Roy");
    expect(later.detail).toBe("Reprogramado por el cliente · 22/09 14:00 · Mañana en la tarde");
    expect(gfDeliverySummary({ shipmentId: "x", box: box(), stop: stop({ status: "no_entregado", outcomeReason: "no_estaba" }) })!.phase).toBe("postergado");
  });

  it("solo parada, sin caja (rutas del cuaderno): en la ruta de Roy", () => {
    const s = gfDeliverySummary({ shipmentId: "x", box: null, stop: stop() })!;
    expect(s.label).toBe("En la ruta de Roy");
    expect(s.detail).toBe("ruta del 22/09 · parada pendiente");
    expect(gfDeliverySummary({ shipmentId: "x", box: null, stop: stop({ routeStatus: "cerrada" }) })!.detail).toBe("ruta del 22/09 · ruta cerrada sin reporte");
  });

  it("sin nombre de motorizado no inventa uno", () => {
    const s = gfDeliverySummary({ shipmentId: "x", box: box({ riderName: "", riderId: null }), stop: null })!;
    expect(s.riderName).toBeNull();
    expect(s.label).toBe("En la caja del motorizado");
    expect(gfDeliverySummary({ shipmentId: "x", box: null, stop: stop({ riderName: null, status: "entregado" }) })!.label).toBe("Entregado por el motorizado");
  });
});

describe("elegir la caja y la parada más recientes", () => {
  it("la caja activa gana a la retirada; a igualdad, la última añadida", () => {
    const old = box({ manifestId: "a", addedAt: "2026-09-20T10:00:00Z", removedAt: "2026-09-20T12:00:00Z" });
    const active = box({ manifestId: "b", addedAt: "2026-09-22T10:00:00Z" });
    const newerRemoved = box({ manifestId: "c", addedAt: "2026-09-23T10:00:00Z", removedAt: "2026-09-23T11:00:00Z" });
    expect(pickLatestBox([old, active, newerRemoved])!.manifestId).toBe("b");
    expect(pickLatestBox([old, newerRemoved])!.manifestId).toBe("c");
    expect(pickLatestBox([])).toBeNull();
  });
  it("la parada reportada gana a la pendiente; a igualdad, la más reciente", () => {
    const pending = stop({ id: "p", routeDate: "2026-09-23" });
    const reported = stop({ id: "r", status: "entregado", reportedAt: "2026-09-22T19:00:00Z" });
    expect(pickLatestStop([pending, reported])!.id).toBe("r");
    expect(pickLatestStop([stop({ id: "p1", routeDate: "2026-09-21" }), pending])!.id).toBe("p");
  });
});

describe("limaWhen", () => {
  it("día y hora de Lima; solo día para una fecha", () => {
    expect(limaWhen("2026-09-22T15:32:00Z")).toBe("22/09 10:32");
    expect(limaWhen("2026-09-22")).toBe("22/09");
    expect(limaWhen(null)).toBeNull();
    expect(limaWhen("nada")).toBeNull();
  });
});

describe("cableado: la ficha lee caja y parada y las pinta bajo la salida", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  it("getOrderMasterDetail carga gfDeliveries desde caja, parada, ruta y motorizado", () => {
    const access = read("lib/orders-master-access.ts");
    expect(access).toContain("async function loadGfDeliveries(");
    for (const table of ["dispatch_manifest_items", "dispatch_manifests", "delivery_stops", "delivery_routes", "riders"]) {
      expect(access).toContain(`from("${table}")`);
    }
    expect(access).toContain("gfDeliveries,");
    // La mesa de ruta lee `pickupState`; sin la columna en el select llegaba undefined.
    expect(access).toContain('"pickup_state,"');
  });
  it("el drawer pinta la línea de Grupo GF bajo la salida y en la tarjeta de acción", () => {
    const drawer = read("components/order-drawer.tsx");
    expect(drawer).toContain("function GfDeliveryLine(");
    expect(drawer).toContain("detail.gfDeliveries.find((d) => d.shipmentId === g.id)");
    expect(drawer).toContain("gfDeliverySentence(gfActive)");
    expect(drawer).toContain("/api/reparto/foto?path=${encodeURIComponent(photo)}");
  });
});
