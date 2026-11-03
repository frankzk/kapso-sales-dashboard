// Cerrar una ruta no escribe «entregado» sobre un pedido anulado en Shopify
// (MOM §11.4, §29.12). Pasó con #KP137541: anulado el 05/10 y entregado en la
// ruta de Yhoni del 01/10, que seguía abierta. El override de la entrega habría
// sido posterior a la anulación y la habría tapado (lib/order-status.ts,
// regla 0). La regla vive en la puerta única, así que vale para todas sus
// fuentes; el cierre de ruta nombra lo que saltó.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  orders: [] as { id: string; cancelled_at: string | null }[],
  ordersError: "" as string,
  inserted: [] as Record<string, any>[][],
  recomputed: [] as string[],
  rides: [] as any[],
  totals: new Map<string, { total: number | null; name: string | null; storeId: string | null }>(),
}));

// Doble de Supabase con los filtros de verdad: un `.not("cancelled_at", "is",
// null)` mal puesto cambiaría el resultado.
function fakeAdmin(): any {
  return {
    from: (table: string) => {
      const filters: ((r: any) => boolean)[] = [];
      let insert: any = null;
      const q: any = {
        select: () => q,
        in: (k: string, vs: any[]) => { filters.push((r) => vs.includes(r[k])); return q; },
        not: (k: string, op: string, v: any) => {
          if (op !== "is" || v !== null) throw new Error("filtro no previsto");
          filters.push((r) => r[k] !== null && r[k] !== undefined);
          return q;
        },
        insert: (rows: any) => { insert = rows; return q; },
        then: (done: any) => {
          if (insert) {
            db.inserted.push(insert);
            return Promise.resolve({ data: null, error: null }).then(done);
          }
          if (table === "orders" && db.ordersError) return Promise.resolve({ data: null, error: { message: db.ordersError } }).then(done);
          const rows = (table === "orders" ? db.orders : []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows, error: null }).then(done);
        },
      };
      return q;
    },
  };
}

vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: async (_admin: unknown, ids: string[]) => { db.recomputed.push(...ids); } }));
vi.mock("@/lib/order-companion-access", () => ({
  loadCompanionRides: async () => db.rides,
  loadOrderTotals: async () => db.totals,
}));

import { applyDeliveriesToMaster, masterDoorVerdict, shopifyCancelledNotice, type MasterDoorItem } from "@/lib/master-door";

const item = (orderId: string, over: Partial<MasterDoorItem> = {}): MasterDoorItem => ({
  orderId,
  storeId: "kenku",
  target: "entregado",
  source: "ruta",
  courier: "propio",
  actor: "coordinador",
  reason: "Entregado por el motorizado y confirmado al cerrar la ruta.",
  payload: { route_id: "r1" },
  guard: { stop: { status: "entregado", photo_path: "r1/s1/foto.jpg", voucher_path: null, reported_by: "u1" }, requireEvidence: true },
  ...over,
});

beforeEach(() => {
  db.orders = [
    { id: "kp137541", cancelled_at: "2026-10-05T17:45:43Z" },
    { id: "kp1", cancelled_at: null },
  ];
  db.ordersError = "";
  db.inserted = [];
  db.recomputed = [];
  db.rides = [];
  db.totals = new Map();
});

describe("la puerta no escribe la entrega sobre una anulación de Shopify", () => {
  it("el veredicto: anulado en Shopify rechaza siempre, con o sin guarda y aunque la parada esté entregada con foto", () => {
    const cancelled = { cancelledAt: "2026-10-05T17:45:43Z" };
    expect(masterDoorVerdict(item("kp137541"), cancelled)).toMatchObject({ ok: false, code: "anulado_en_shopify" });
    expect(masterDoorVerdict({ target: "entregado" }, cancelled)).toMatchObject({ ok: false, code: "anulado_en_shopify" });
    // Va antes que las demás guardas: lo que hay que decidir es la anulación.
    expect(masterDoorVerdict({ target: "entregado", guard: { openObservations: 2 } }, cancelled)).toMatchObject({ code: "anulado_en_shopify" });
    expect(masterDoorVerdict(item("kp1"), { cancelledAt: null })).toEqual({ ok: true });
    expect(masterDoorVerdict(item("kp1"))).toEqual({ ok: true });
  });

  it("el cierre de la ruta escribe la entrega del pedido vivo y salta el anulado, sin recalcularlo", async () => {
    const res = await applyDeliveriesToMaster(fakeAdmin(), [item("kp137541"), item("kp1")]);
    expect(res.error).toBeUndefined();
    expect(res.applied).toEqual(["kp1"]);
    expect(res.rejected).toEqual([{ orderId: "kp137541", code: "anulado_en_shopify", reason: expect.stringContaining("anulado en la tienda") }]);
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]!.map((e) => e.order_id)).toEqual(["kp1"]);
    expect(db.inserted[0]![0]).toMatchObject({ kind: "status_override", new_status: "entregado", source: "ruta" });
    expect(db.recomputed).toEqual(["kp1"]);
  });

  it("vale para toda fuente de la puerta, también la que llega sin guarda (Liquidaciones 1)", async () => {
    const res = await applyDeliveriesToMaster(fakeAdmin(), [item("kp137541", { source: "liquidacion", guard: undefined, courier: null })]);
    expect(res.applied).toEqual([]);
    expect(res.rejected.map((r) => r.code)).toEqual(["anulado_en_shopify"]);
    expect(db.inserted).toEqual([]);
    expect(db.recomputed).toEqual([]);
  });

  it("si no se puede leer la anulación, no escribe nada: «no lo sé» no es «no está anulado»", async () => {
    db.ordersError = "timeout";
    const res = await applyDeliveriesToMaster(fakeAdmin(), [item("kp1")]);
    expect(res.applied).toEqual([]);
    expect(res.error).toContain("anulados en la tienda");
    expect(db.inserted).toEqual([]);
  });

  it("un acompañante anulado en Shopify no sigue a su principal; queda aparte, con su código", async () => {
    db.orders.push({ id: "c1", cancelled_at: "2026-10-06T10:00:00Z" }, { id: "c2", cancelled_at: null });
    const ride = (companion: string) => ({
      link: { linkId: null, companionOrderId: companion, companionOrderName: null, hostOrderId: "kp1", hostOrderName: "#KP1", hostShipmentId: "s1", hostGuideCode: "S01", linkedAt: "2026-10-01T10:00:00Z" },
      shipment: { delivery_status: "en_ruta" },
      rawShipment: null,
    });
    db.rides = [ride("c1"), ride("c2")];
    db.totals = new Map([
      ["c1", { total: 50, name: "#KP900", storeId: "kenku" }],
      ["c2", { total: 60, name: "#KP901", storeId: "kenku" }],
    ]);
    const res = await applyDeliveriesToMaster(fakeAdmin(), [item("kp1")]);
    expect(res.applied).toEqual(["kp1", "c2"]);
    expect(res.rejected).toEqual([]);
    expect(res.companionsCancelled).toEqual([{ orderId: "c1", orderName: "#KP900", hostOrderId: "kp1" }]);
    expect(db.inserted.flat().map((e) => e.order_id)).toEqual(["kp1", "c2"]);
  });
});

describe("el aviso nombra los pedidos saltados", () => {
  it("uno, varios, repetidos y ninguno", () => {
    expect(shopifyCancelledNotice([])).toBeNull();
    expect(shopifyCancelledNotice([{ orderId: "kp137541", name: "#KP137541" }])).toBe(
      "#KP137541 está anulado en la tienda: no se marcó entregado en el Master y sigue donde estaba. Decide en su ficha qué pasó con la entrega.",
    );
    expect(shopifyCancelledNotice([
      { orderId: "a", name: "#KP1" },
      { orderId: "b", name: "#KP2" },
      { orderId: "a", name: "#KP1" },
    ])).toBe(
      "2 pedidos están anulados en la tienda (#KP1, #KP2): no se marcaron entregados en el Master y siguen donde estaban. Decide en la ficha de cada uno qué pasó con la entrega.",
    );
    expect(shopifyCancelledNotice([{ orderId: "x", name: null }])).toBe(
      "Un pedido sin código está anulado en la tienda: no se marcó entregado en el Master y sigue donde estaba. Decide en su ficha qué pasó con la entrega.",
    );
  });
});

describe("closeRoute: la ruta se cierra igual y el aviso sale en el mensaje", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const src = read("app/dashboard/rutas/actions.ts");
  const start = src.indexOf("export async function closeRoute(");
  const body = src.slice(start, src.indexOf("\nexport ", start + 1));

  it("nombra los anulados (también los acompañantes) y no los cuenta como «no cruzaron» por otra razón", () => {
    expect(body).toContain("const cancelledNotice = shopifyCancelledNotice([");
    expect(body).toContain('.filter((r) => r.code === "anulado_en_shopify")');
    expect(body).toContain("name: stopOf.get(r.orderId)?.order?.name");
    expect(body).toContain("...(door.companionsCancelled ?? []).map((c) => ({ orderId: c.orderId, name: c.orderName })),");
    expect(body).toContain("if (cancelledNotice) problems.push(cancelledNotice);");
    expect(body).toContain('const otherRejected = door.rejected.filter((r) => r.code !== "anulado_en_shopify");');
    // El aviso no frena el cierre: va a «Ojo:» y la ruta pasa a cerrada después.
    expect(body.indexOf("problems.push(cancelledNotice)")).toBeLessThan(body.indexOf('status: "cerrada"'));
    expect(body).not.toMatch(/if \(cancelledNotice\) return/);
  });

  it("la puerta lee la anulación ella misma, y el reporte de parada no pasa por la puerta", () => {
    const door = read("lib/master-door.ts");
    expect(door).toContain('.from("orders")');
    expect(door).toContain('.not("cancelled_at", "is", null)');
    expect(door).toContain("masterDoorVerdict(item, { cancelledAt: cancelled.get(item.orderId) ?? null, cancelledInKapta: localCancelled.has(item.orderId) })");
    // /reparto escribe solo en la parada: el Master no se toca al reportar.
    expect(read("app/reparto/actions.ts")).not.toContain("applyDeliveriesToMaster");
    expect(read("lib/stop-report.ts")).not.toContain("applyDeliveriesToMaster");
    expect(read("lib/stop-report.ts")).not.toContain('kind: "status_override"');
  });
});

describe("las otras fuentes de la puerta cuentan lo que de verdad cruzó", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const bodyOf = (src: string, signature: string) => {
    const start = src.indexOf(signature);
    expect(start, signature).toBeGreaterThan(-1);
    const next = src.indexOf("\nexport ", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  };

  it("Liquidaciones 1 cuenta door.applied y nombra los anulados en Shopify", () => {
    const body = bodyOf(read("app/dashboard/liquidaciones/actions.ts"), "export async function applySettlementToMaster(");
    expect(body).not.toContain("${pending.length} entregado(s)");
    expect(body).toContain("Master actualizado: ${door.applied.length} entregado(s).");
    expect(body).toContain("const cancelledNotice = shopifyCancelledNotice([");
    expect(body).toContain("name: detail.orderNames[r.orderId]");
    expect(body).toContain("...(door.companionsCancelled ?? []).map((c) => ({ orderId: c.orderId, name: c.orderName })),");
  });

  it("Liquidaciones 2 no mete un anulado en Shopify en «parada no entregada»", () => {
    const body = bodyOf(read("app/dashboard/liquidaciones-2/actions.ts"), "export async function applyCuadernoRowsToMaster(");
    expect(body).not.toContain("summary.paradaNoEntregada = door.rejected.length;");
    expect(body).toContain('door.rejected.filter((r) => r.code === "anulado_en_shopify").length');
    expect(body).toContain("summary.saltadosAnulado += cancelledAtDoor;");
  });

  it("Urpi cuenta el anulado en la puerta con los que no se tocaron", () => {
    const src = read("lib/urpi-report-apply.ts");
    expect(src).toContain('for (const r of door.rejected) if (r.code === "anulado_en_shopify") cancelledAtDoor.add(r.orderId);');
    expect(src).toContain("observed += cancelledAtDoor.size;");
    // Y su caja «por definir» no se rellena como salida de Urpi entregada.
    expect(src).toContain("delivered.filter((id) => !cancelledAtDoor.has(id))");
  });
});
