import { afterEach, describe, expect, it } from "vitest";
import type { CostTariff, LogisticsCostInput } from "@/lib/costs";
import { costCourier } from "@/lib/delivery-courier";
import {
  clearTariffCache,
  freshLogisticsCost,
  masterLogisticsCost,
  recomputeOrderMaster,
  type LogisticsCostSnapshot,
} from "@/lib/order-master";

// FALTA NO ES CERO (MOM §14, §29.8). Auditoría del 14-10-2026: 4.586 de 4.629
// pedidos de Lima en «Pendiente de liquidación» tenían S/ 0 porque no hay
// tarifa para Grupo GF ni Urpi, y conciliar los habría cerrado con flete cero.

const tariff = (over: Partial<CostTariff>): CostTariff => ({
  id: over.id ?? "t",
  store_id: null,
  courier: "aliclik",
  region: null,
  province: null,
  district: null,
  concept: "primer_intento",
  amount: 10,
  effective_from: "2026-01-01",
  effective_to: null,
  ...over,
});

const base: LogisticsCostInput = {
  ctx: { storeId: "store-a", courier: "aliclik", region: "Lima", province: "Lima", district: "Ate" },
  attempts: 1,
  generalStatus: "entregado",
  agency: false,
  day: "2026-10-01",
};

describe("masterLogisticsCost", () => {
  it("con tarifa: el total", () => {
    expect(masterLogisticsCost([tariff({})], base)).toEqual({ cost: 10, missing: [] });
  });

  it("sin tarifa para ese courier: null y el concepto que falta, nunca S/ 0", () => {
    const propio = { ...base, ctx: { ...base.ctx, courier: "propio" } };
    expect(masterLogisticsCost([tariff({})], propio)).toEqual({ cost: null, missing: ["primer_intento"] });
    expect(masterLogisticsCost([], propio)).toEqual({ cost: null, missing: ["primer_intento"] });
  });

  it("un cero configurado es un cero legítimo", () => {
    expect(masterLogisticsCost([tariff({ amount: 0 })], base)).toEqual({ cost: 0, missing: [] });
  });

  it("el acompañante que viaja en la caja del principal no paga flete (MOM §32)", () => {
    expect(masterLogisticsCost([], { ...base, ridesInHostBox: true })).toEqual({ cost: 0, missing: [] });
  });

  it("el precio real del courier cubre la entrega aunque no haya tarifa", () => {
    expect(masterLogisticsCost([], { ...base, actual: { delivery: 14.5 } })).toEqual({ cost: 14.5, missing: [] });
  });

  it("si falta un concepto (intento adicional) el costo está incompleto: null", () => {
    expect(masterLogisticsCost([tariff({})], { ...base, attempts: 2 })).toEqual({
      cost: null,
      missing: ["intento_adicional"],
    });
  });

  it("la tarifa tiene que regir el día del pedido: una que empieza después no le llega", () => {
    // Un pedido de Urpi entregado el 03-10; la tarifa se cargó con la fecha que
    // trae Costos por defecto (hoy, 16-10). «Cárgala y vuelve a conciliar»
    // devolvía el mismo rechazo sin decir por qué (MOM §14).
    const urpi = { ...base, ctx: { ...base.ctx, courier: "urpi" }, day: "2026-10-03" };
    expect(masterLogisticsCost([tariff({ courier: "urpi", effective_from: "2026-10-16" })], urpi)).toEqual({
      cost: null,
      missing: ["primer_intento"],
    });
    // Vigente desde el día que nombra el aviso, o antes: sí.
    expect(masterLogisticsCost([tariff({ courier: "urpi", effective_from: "2026-10-03" })], urpi)).toEqual({
      cost: 10,
      missing: [],
    });
  });
});

describe("costCourier — con qué courier se busca la tarifa de una entrega sin courier", () => {
  const propio = tariff({ courier: "propio", amount: 7 });
  const costOf = (courier: string | null) =>
    masterLogisticsCost([propio], { ...base, ctx: { ...base.ctx, courier } });

  it("entregado con la caja «por definir» y «Salió con» Grupo GF: la tarifa de «propio»", () => {
    const courier = costCourier({ generalStatus: "entregado", currentCourier: "por_definir", dispatchedWith: ["gf:Roy"] });
    expect(courier).toBe("propio");
    expect(costOf(courier)).toEqual({ cost: 7, missing: [] });
  });

  it("el orden es el de settlementCourier: la entrega, el último courier, y «Salió con»", () => {
    expect(costCourier({ generalStatus: "entregado", currentCourier: null, deliveredCourier: "urpi" })).toBe("urpi");
    expect(costCourier({ generalStatus: "entregado", currentCourier: "por_definir", lastCourier: "urpi" })).toBe("urpi");
    expect(costCourier({ generalStatus: "entregado", currentCourier: null, dispatchedWith: ["urpi"] })).toBe("urpi");
    // Varios distintos no dicen quién entregó: queda lo que había.
    expect(costCourier({ generalStatus: "entregado", currentCourier: null, dispatchedWith: ["gf:Roy", "urpi"] })).toBeNull();
    expect(costCourier({ generalStatus: "entregado", currentCourier: "por_definir", dispatchedWith: [] })).toBe("por_definir");
  });

  it("un courier vigente de verdad manda, y uno no entregado no infiere nada", () => {
    expect(costCourier({ generalStatus: "entregado", currentCourier: "aliclik", dispatchedWith: ["gf:Roy"] })).toBe("aliclik");
    // Un anulado con una salida cancelada no tuvo primer intento de nadie.
    const anulado = costCourier({ generalStatus: "anulado", currentCourier: "por_definir", lastCourier: "urpi", dispatchedWith: ["urpi"] });
    expect(anulado).toBe("por_definir");
    expect(costOf(anulado)).toEqual({ cost: null, missing: ["primer_intento"] });
  });
});

// Stub de Supabase al estilo de test/order-master.test.ts, con tiendas y tarifas.
function stubAdmin(tables: Record<string, any[]>) {
  const upserts: any[][] = [];
  const admin = {
    from(table: string) {
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
  return { admin: admin as any, upserts };
}

const ORDER = {
  id: "order-1",
  store_id: "store-a",
  shopify_order_id: "9001",
  name: "#KP200001",
  created_at: "2026-10-01T10:00:00.000Z",
  cancelled_at: null,
  financial_status: "pending",
  shipping_mode: "cod",
  customer_phone: "51987654321",
  total_amount: 120,
  raw: { shippingAddress: { address1: "Jr. Uno 1", city: "Ate", province: "Lima", name: "Ana" } },
};
const STORES = [{ id: "store-a", org_id: "org-1" }];
const NOW = "2026-10-14T12:00:00.000Z";

describe("recomputeOrderMaster escribe null cuando falta la tarifa", () => {
  afterEach(() => clearTariffCache());

  it("sin ninguna tarifa que le aplique: logistics_cost null y el aviso con lo que falta", async () => {
    const stub = stubAdmin({ orders: [ORDER], stores: STORES, cost_tariffs: [{ ...tariff({}), org_id: "org-1" }] });
    const seen: Record<string, LogisticsCostSnapshot> = {};
    await recomputeOrderMaster(stub.admin, ["order-1"], { now: NOW, onLogisticsCost: (id, cost) => (seen[id] = cost) });
    expect(stub.upserts[0]?.[0]).toMatchObject({ order_id: "order-1", logistics_cost: null });
    expect(seen["order-1"]).toEqual({
      cost: null,
      missing: ["primer_intento"],
      courier: null,
      district: "Ate",
      day: "2026-10-01",
    });
  });

  it("con una tarifa general que le aplica: el importe", async () => {
    const stub = stubAdmin({
      orders: [ORDER],
      stores: STORES,
      cost_tariffs: [{ ...tariff({ courier: null, amount: 9 }), org_id: "org-1" }],
    });
    await recomputeOrderMaster(stub.admin, ["order-1"], { now: NOW });
    expect(stub.upserts[0]?.[0]).toMatchObject({ order_id: "order-1", logistics_cost: 9 });
  });

  it("freshLogisticsCost recalcula y devuelve lo que quedó escrito", async () => {
    const stub = stubAdmin({ orders: [ORDER], stores: STORES, cost_tariffs: [] });
    expect(await freshLogisticsCost(stub.admin, "order-1")).toEqual({
      cost: null,
      missing: ["primer_intento"],
      courier: null,
      district: "Ate",
      day: "2026-10-01",
    });
    expect(stub.upserts.length).toBe(1);
  });

  it("la entrega del cuaderno de Grupo GF, sin salida, se calcula con la tarifa de «propio»", async () => {
    // 1.868 entregas así esperaban liquidación el 16-10-2026: con el courier
    // vacío, ni una tarifa de «propio» les llegaba.
    const tables = {
      orders: [ORDER],
      stores: STORES,
      cost_tariffs: [{ ...tariff({ courier: "propio", amount: 7 }), org_id: "org-1" }],
      order_events: [
        { order_id: "order-1", kind: "status_override", occurred_at: "2026-10-05T15:00:00.000Z", courier: null, new_status: "entregado", new_operational: null },
      ],
      delivery_stops: [
        { id: "st-1", order_id: "order-1", status: "entregado", shipment_id: null, delivery_routes: { riders: { full_name: "Roy" } } },
      ],
    };
    const stub = stubAdmin(tables);
    const seen: Record<string, LogisticsCostSnapshot> = {};
    await recomputeOrderMaster(stub.admin, ["order-1"], { now: NOW, onLogisticsCost: (id, cost) => (seen[id] = cost) });
    const row = stub.upserts[0]?.[0];
    expect(row).toMatchObject({ general_status: "entregado", dispatched_with: ["gf:Roy"], logistics_cost: 7 });
    // El courier de la fila no cambia: solo la tarifa se busca con el de la entrega.
    expect(row.current_courier).toBeNull();
    expect(seen["order-1"]).toMatchObject({ cost: 7, courier: "propio" });

    // El mismo pedido sin entregar no infiere a nadie.
    const pendiente = stubAdmin({
      ...tables,
      order_events: [{ ...tables.order_events[0], new_status: "en_proceso" }],
    });
    clearTariffCache();
    await recomputeOrderMaster(pendiente.admin, ["order-1"], { now: NOW });
    expect(pendiente.upserts[0]?.[0]).toMatchObject({ logistics_cost: null });
  });

  it("freshLogisticsCost: null si el pedido no existe", async () => {
    const stub = stubAdmin({ orders: [], stores: STORES, cost_tariffs: [] });
    expect(await freshLogisticsCost(stub.admin, "order-x")).toBeNull();
  });
});
