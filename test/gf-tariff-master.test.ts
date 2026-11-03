// El recálculo del Master con el Tarifario de Grupo GF (mom-v1.31; MOM §14,
// §29.8): escribe la tarifa del distrito en `logistics_cost`, deja vacío lo
// que no la tiene y lee el Tarifario una vez —no una por pedido—, con la misma
// memoria de cinco minutos que `cost_tariffs`. La resolución pura, en
// test/gf-tariff-resolve.test.ts.

import { afterEach, describe, expect, it } from "vitest";
import {
  clearTariffCache,
  freshLogisticsCost,
  recomputeOrderMaster,
  type LogisticsCostSnapshot,
} from "@/lib/order-master";

// Stub de Supabase al estilo de test/pedidos-logistics-cost.test.ts, que
// además cuenta las lecturas por tabla.
function stubAdmin(tables: Record<string, any[]>) {
  const upserts: any[][] = [];
  const reads: Record<string, number> = {};
  const admin = {
    from(table: string) {
      reads[table] = (reads[table] ?? 0) + 1;
      const rows: any[] = tables[table] ?? [];
      let mutation = false;
      const builder: any = {
        select: () => builder,
        in: () => (mutation ? builder : Promise.resolve({ data: rows, error: null })),
        eq: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: rows, error: null }),
        upsert(batch: any[]) {
          upserts.push(batch);
          return Promise.resolve({ data: null, error: null });
        },
        update() {
          mutation = true;
          return builder;
        },
      };
      return builder;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  return { admin: admin as any, upserts, reads };
}

const order = (id: string, city: string, createdAt: string) => ({
  id,
  store_id: "store-a",
  shopify_order_id: id,
  name: `#KP${id}`,
  created_at: createdAt,
  cancelled_at: null,
  financial_status: "pending",
  shipping_mode: "cod",
  customer_phone: "51987654321",
  total_amount: 120,
  raw: { shippingAddress: { address1: "Jr. Uno 1", city, province: "Lima", name: "Ana" } },
});

// Entregas del cuaderno de Grupo GF: sin salida, entregadas con un override y
// con la parada de Roy (`dispatched_with` gf:Roy → «propio», MOM §14).
const delivered = (orderId: string, at: string) => ({
  order_id: orderId,
  kind: "status_override",
  occurred_at: at,
  courier: null,
  new_status: "entregado",
  new_operational: null,
});
const stop = (orderId: string) => ({
  id: `st-${orderId}`,
  order_id: orderId,
  status: "entregado",
  shipment_id: null,
  delivery_routes: { riders: { full_name: "Roy" } },
});

const tariff = (id: string, district: string, amount: number, over: Record<string, unknown> = {}) => ({
  id,
  provider_id: "gf",
  agreement_id: null,
  district_key: district,
  zone: null,
  // PostgREST devuelve `numeric` como texto.
  delivery_amount: amount.toFixed(2),
  rejection_amount: amount.toFixed(2),
  includes_igv: true,
  currency: "PEN",
  effective_from: "2026-08-31",
  effective_to: null,
  status: "active",
  ...over,
});

const NOW = "2026-10-21T12:00:00.000Z";

function tables() {
  return {
    orders: [
      order("1", "Ate", "2026-10-01T10:00:00.000Z"),
      order("2", "Surco", "2026-10-01T10:00:00.000Z"),
      // Entregada antes de que rija el Tarifario (31-08-2026).
      order("3", "Ate", "2026-08-15T10:00:00.000Z"),
      order("4", "Miraflores", "2026-10-01T10:00:00.000Z"),
    ],
    stores: [{ id: "store-a", org_id: "org-1" }],
    // Una tarifa de «propio» en Costos que ya no se mira para Grupo GF.
    cost_tariffs: [
      {
        id: "c",
        org_id: "org-1",
        store_id: null,
        courier: "propio",
        region: null,
        province: null,
        district: null,
        concept: "primer_intento",
        amount: 99,
        effective_from: "2026-01-01",
        effective_to: null,
      },
    ],
    logistics_providers: [{ id: "gf", org_id: "org-1" }],
    logistics_service_agreements: [
      { id: "ag-a", provider_id: "gf", store_id: "store-a", status: "active", effective_from: "2026-08-01", effective_to: null },
    ],
    logistics_district_tariffs: [
      tariff("ate", "ate", 12),
      tariff("surco-gen", "santiago de surco", 14),
      // La excepción del contrato de la tienda gana a la general.
      tariff("surco-ag", "santiago de surco", 13, { agreement_id: "ag-a" }),
    ],
    order_events: [
      delivered("1", "2026-10-05T15:00:00.000Z"),
      delivered("2", "2026-10-05T15:00:00.000Z"),
      delivered("3", "2026-08-20T15:00:00.000Z"),
      delivered("4", "2026-10-05T15:00:00.000Z"),
    ],
    delivery_stops: [stop("1"), stop("2"), stop("3"), stop("4")],
  };
}

const costOf = (upserts: any[][], orderId: string) =>
  upserts.flat().find((row) => row.order_id === orderId)?.logistics_cost;

describe("recomputeOrderMaster: Grupo GF con la tarifa de su Tarifario", () => {
  afterEach(() => clearTariffCache());

  it("la tarifa del distrito, la del contrato si la hay; sin tarifa o antes de su vigencia, vacío", async () => {
    const stub = stubAdmin(tables());
    const seen: Record<string, LogisticsCostSnapshot> = {};
    await recomputeOrderMaster(stub.admin, ["1", "2", "3", "4"], { now: NOW, onLogisticsCost: (id, cost) => (seen[id] = cost) });
    expect(costOf(stub.upserts, "1")).toBe(12);
    expect(costOf(stub.upserts, "2")).toBe(13);
    expect(costOf(stub.upserts, "3")).toBeNull();
    expect(costOf(stub.upserts, "4")).toBeNull();
    expect(seen["1"]).toEqual({ cost: 12, missing: [], courier: "propio", district: "Ate", day: "2026-10-05" });
    expect(seen["3"]).toMatchObject({
      cost: null,
      missing: ["primer_intento"],
      courier: "propio",
      day: "2026-08-20",
      tarifario: { reason: "antes_de_vigencia", since: "2026-08-31" },
    });
    expect(seen["4"]).toMatchObject({ cost: null, tarifario: { reason: "sin_tarifa", since: null } });
  });

  it("el día es el del último movimiento, también con Grupo GF: la caja que rellenó la 0270 toma la tarifa del día del relleno", async () => {
    const t = tables() as ReturnType<typeof tables> & { shipments?: Record<string, unknown>[] };
    // La caja «por definir» que rellenó la 0270 hoy (`updated_at`), con
    // `closed_at` = el día del cuaderno (20-08, antes de que rija el Tarifario),
    // y un comentario posterior.
    t.shipments = [
      {
        id: "s3",
        order_id: "3",
        store_id: "store-a",
        courier: "propio",
        created_via: "cuaderno_gf",
        delivery_status: "entregado",
        status_category: "delivered",
        delivered_source: "cuaderno_gf",
        guide_code: "MOM-KP3-PROPIO-S3",
        output_number: 1,
        output_code: "KP3-S01",
        dispatched_at: "2026-08-20T17:00:00.000Z",
        closed_at: "2026-08-20T17:00:00.000Z",
        created_at: "2026-08-18T10:00:00.000Z",
        updated_at: "2026-10-21T11:00:00.000Z",
      },
    ];
    (t.order_events as Record<string, unknown>[]).push({
      order_id: "3",
      kind: "comment",
      occurred_at: "2026-10-10T15:00:00.000Z",
      courier: null,
      new_status: null,
      new_operational: null,
    });
    const stub = stubAdmin(t);
    const seen: Record<string, LogisticsCostSnapshot> = {};
    await recomputeOrderMaster(stub.admin, ["3"], { now: NOW, onLogisticsCost: (id, cost) => (seen[id] = cost) });
    const row = stub.upserts.flat().find((r) => r.order_id === "3");
    expect(row.last_movement_at.slice(0, 10)).toBe("2026-10-21");
    // El Master sigue con la entrega del cuaderno; el costo, con el relleno.
    expect(row.delivered_at).toBe("2026-08-20T17:00:00.000Z");
    expect(seen["3"]).toEqual({ cost: 12, missing: [], courier: "propio", district: "Ate", day: "2026-10-21" });
    expect(row.logistics_cost).toBe(12);
  });

  it("antes de la vigencia no aguanta un movimiento posterior: observar la liquidación lleva el día del costo a ese día (MOM §14)", async () => {
    const t = tables();
    const seen: Record<string, LogisticsCostSnapshot> = {};
    // Entregado el 20-08 y sin más movimientos: «falta tarifa», antes de la vigencia.
    await recomputeOrderMaster(stubAdmin(t).admin, ["3"], { now: NOW, onLogisticsCost: (id, cost) => (seen[id] = cost) });
    expect(seen["3"]).toMatchObject({ cost: null, day: "2026-08-20", tarifario: { reason: "antes_de_vigencia", since: "2026-08-31" } });
    // «Observar liquidación» escribe `liquidation_observed` con la hora de ahora
    // (registerClosureAction): es el nuevo último movimiento.
    (t.order_events as Record<string, unknown>[]).push({
      order_id: "3",
      kind: "liquidation_observed",
      occurred_at: NOW,
      courier: null,
      new_status: null,
      new_operational: null,
    });
    const stub = stubAdmin(t);
    await recomputeOrderMaster(stub.admin, ["3"], { now: NOW, onLogisticsCost: (id, cost) => (seen[id] = cost) });
    expect(seen["3"]).toEqual({ cost: 12, missing: [], courier: "propio", district: "Ate", day: "2026-10-21" });
    expect(costOf(stub.upserts, "3")).toBe(12);
  });

  it("solo cobra los intentos de sus propias salidas: los de una guía anterior de Aliclik no son visitas de Grupo GF", async () => {
    const t = tables() as ReturnType<typeof tables> & { shipments?: Record<string, unknown>[] };
    t.order_events = [];
    t.delivery_stops = [];
    t.shipments = [
      // Salió con Aliclik, que reportó tres intentos, y se anuló.
      {
        id: "al1", order_id: "1", store_id: "store-a", courier: "aliclik", created_via: "aliclik_api", delivery_status: "anulado",
        status_category: "cancelled", guide_code: "AL-1", output_number: 1, output_code: "KP1-S01", aliclik_attempts: 3,
        dispatched_at: "2026-09-20T10:00:00.000Z", closed_at: "2026-09-25T10:00:00.000Z", created_at: "2026-09-19T10:00:00.000Z",
        updated_at: "2026-09-25T10:00:00.000Z",
      },
      // Luego la entregó Grupo GF en Ate.
      {
        id: "p2", order_id: "1", store_id: "store-a", courier: "propio", created_via: "mom_manual_route", delivery_status: "entregado",
        status_category: "delivered", guide_code: "MOM-KP1-PROPIO-P2", output_number: 2, output_code: "KP1-S02", aliclik_attempts: null,
        reroute_attempts: 0, dispatched_at: "2026-10-05T10:00:00.000Z", closed_at: "2026-10-05T17:00:00.000Z",
        created_at: "2026-10-04T10:00:00.000Z", updated_at: "2026-10-05T17:00:00.000Z",
      },
    ];
    const stub = stubAdmin(t);
    const seen: Record<string, LogisticsCostSnapshot> = {};
    await recomputeOrderMaster(stub.admin, ["1"], { now: NOW, onLogisticsCost: (id, cost) => (seen[id] = cost) });
    // El primer intento, S/ 12; no 3 × S/ 12 por las visitas de Aliclik.
    expect(seen["1"]).toMatchObject({ cost: 12, missing: [], courier: "propio" });
    expect(costOf(stub.upserts, "1")).toBe(12);
  });

  it("lee el Tarifario una vez por recálculo, no una por pedido, y lo recuerda como `cost_tariffs`", async () => {
    const stub = stubAdmin(tables());
    await recomputeOrderMaster(stub.admin, ["1", "2", "3", "4"], { now: NOW });
    expect(stub.reads.logistics_providers).toBe(1);
    expect(stub.reads.logistics_service_agreements).toBe(1);
    expect(stub.reads.logistics_district_tariffs).toBe(1);
    expect(stub.reads.cost_tariffs).toBe(1);
    // El siguiente recálculo de la instancia no vuelve a leer ninguna de las dos.
    await recomputeOrderMaster(stub.admin, ["1"], { now: NOW });
    expect(stub.reads.logistics_district_tariffs).toBe(1);
    expect(stub.reads.cost_tariffs).toBe(1);
  });

  it("si el Tarifario no se puede leer, Grupo GF queda sin tarifa —nunca S/ 0 ni la de Costos—, lo dice así y no lo recuerda", async () => {
    const t = tables();
    const stub = stubAdmin(t);
    const from = stub.admin.from;
    let down = true;
    stub.admin.from = (table: string) => {
      if (table !== "logistics_district_tariffs" || !down) return from(table);
      const failing: any = { select: () => failing, eq: () => failing, in: () => Promise.resolve({ data: null, error: { message: "caída" } }) };
      return failing;
    };
    const seen: Record<string, LogisticsCostSnapshot> = {};
    await recomputeOrderMaster(stub.admin, ["1"], { now: NOW, onLogisticsCost: (id, cost) => (seen[id] = cost) });
    expect(costOf(stub.upserts, "1")).toBeNull();
    // No se sabe si falta: no se afirma que Grupo GF no esté activado.
    expect(seen["1"]).toMatchObject({ cost: null, tarifario: { reason: "sin_lectura", since: null } });
    // Vuelve la base: el siguiente recálculo lo lee otra vez, sin esperar cinco minutos.
    down = false;
    stub.upserts.length = 0;
    await recomputeOrderMaster(stub.admin, ["1"], { now: NOW });
    expect(costOf(stub.upserts, "1")).toBe(12);
  });

  it("freshLogisticsCost olvida el Tarifario recordado: quien acaba de cargar la tarifa concilia sin esperar", async () => {
    const t = tables();
    const stub = stubAdmin(t);
    await recomputeOrderMaster(stub.admin, ["4"], { now: NOW });
    expect(costOf(stub.upserts, "4")).toBeNull();
    t.logistics_district_tariffs.push(tariff("miraflores", "miraflores", 15, { effective_from: "2026-10-01" }));
    const fresh = await freshLogisticsCost(stub.admin, "4");
    expect(fresh).toMatchObject({ cost: 15, missing: [], courier: "propio" });
    expect(fresh).not.toHaveProperty("tarifario");
    expect(stub.reads.logistics_district_tariffs).toBe(2);
  });
});
