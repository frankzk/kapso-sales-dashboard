import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
const mocks = vi.hoisted(() => ({ recompute: vi.fn(), rides: vi.fn() }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: mocks.recompute }));
vi.mock("@/lib/order-companion-access", () => ({ loadCompanionRides: mocks.rides }));
import { cancelHistoricalShopifySale } from "@/lib/legacy-sale-cancel-server";
import { legacySaleManifestBlock, legacySaleSendBlock } from "@/lib/legacy-sale-cancel-access";
import { LEGACY_SALE_CANCELLED } from "@/lib/legacy-sale-cancel";

let tables: Record<string, Record<string, any>[]>;
let fail: string | null;
let inserts: Record<string, unknown>[];
const admin = { from(table: string) {
  let rows = [...(tables[table] ?? [])];
  const q: any = {
    select: () => q,
    eq: (field: string, value: unknown) => { rows = rows.filter((row) => row[field] === value); return q; },
    in: (field: string, values: unknown[]) => { rows = rows.filter((row) => values.includes(row[field])); return q; },
    maybeSingle: async () => ({ data: rows[0] ?? null, error: fail === table ? { message: "lectura fallida" } : null }),
    insert: async (row: Record<string, unknown>) => {
      expect(table).toBe("order_events");
      if (fail === "insert") return { error: { code: "network", message: "sin conexión" } };
      if (inserts.some((insert) => insert.operation_id === row.operation_id)) return { error: { code: "23505" } };
      inserts.push(row); tables.order_events!.push(row); return { error: null };
    },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: fail === table ? { message: "lectura fallida" } : null }).then(resolve),
  }; return q;
} } as unknown as SupabaseClient;

const cancel = () => cancelHistoricalShopifySale({ admin, orderId: "o1", userId: "diana",
  reasonCode: "entrega_no_lograda", reasonText: "La clienta no recibirá; no se reintentará.", requestId: "ea465b44-abcd-4abc-abcd-000000000001" });

beforeEach(() => {
  vi.clearAllMocks(); fail = null; inserts = [];
  mocks.recompute.mockResolvedValue({ written: 1, requested: 1 }); mocks.rides.mockResolvedValue([]);
  tables = {
    orders: [{ id: "o1", store_id: "s1", name: "#AUR177555", platform: "shopify", created_at: "2026-09-27T00:00:00Z", cancelled_at: null, financial_status: "pending" }],
    stores: [{ id: "s1", platform: "woocommerce", platform_switched_at: "2026-10-25T00:00:00Z" }],
    order_master: [{ order_id: "o1", general_status: "en_proceso" }],
    shipments: [{ id: "s1", order_id: "o1", courier: "propio", guide_code: "GF1", delivery_status: "pendiente", custody_state: "courier" }],
    order_payments: [], order_events: [], delivery_stops: [],
  };
});

describe("anulación comercial histórica del servidor", () => {
  it("Woo ya recibido para reprogramar llega al RPC de terminar venta con la evidencia del historial",async()=>{
    tables.orders![0]!.platform="woocommerce";
    tables.shipments![0]!.custody_state="empresa";
    tables.order_events!.push({order_id:"o1",kind:"returned_to_office",shipment_id:"s1",source:"dispatch",actor:"almacen",occurred_at:"2026-10-28T18:51:04Z"});
    const rpc=vi.fn().mockResolvedValue({error:null}); Object.assign(admin,{rpc});
    const result=await cancelHistoricalShopifySale({admin,orderId:"o1",userId:"diana",reasonCode:"entrega_no_lograda",reasonText:"No habrá otro intento",requestId:"request-123456",wooReturn:true});
    expect(result.error).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("woo_end_sale_pending_return",expect.objectContaining({p_order_id:"o1",p_actor:"diana"}));
  });
  it("Woo termina localmente por RPC sin mutar fuente, salidas ni llamar a la tienda",async()=>{
    tables.orders![0]!.platform="woocommerce";
    const rpc=vi.fn().mockResolvedValue({error:null}); Object.assign(admin,{rpc});
    const before=JSON.stringify({orders:tables.orders,shipments:tables.shipments,payments:tables.order_payments});
    const result=await cancelHistoricalShopifySale({admin,orderId:"o1",userId:"diana",reasonCode:"entrega_no_lograda",reasonText:"No habrá otro intento",requestId:"request-123456",wooReturn:true});
    expect(result.notice).toContain("venta terminada");expect(rpc).toHaveBeenCalledWith("woo_end_sale_pending_return",expect.objectContaining({p_order_id:"o1",p_actor:"diana"}));
    expect(JSON.stringify({orders:tables.orders,shipments:tables.shipments,payments:tables.order_payments})).toBe(before);
  });
  it("anula la venta con actor y motivo, sin modificar Shopify, caja ni pagos", async () => {
    const original = JSON.stringify({ order: tables.orders, shipments: tables.shipments, payments: tables.order_payments });
    expect((await cancel()).notice).toContain("venta anulada en Kapta");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ kind: LEGACY_SALE_CANCELLED, actor: "diana", source: "kapta", new_status: "anulado", order_id: "o1", store_id: "s1" });
    expect(inserts[0]?.reason).toContain("La clienta no recibirá");
    expect(JSON.stringify({ order: tables.orders, shipments: tables.shipments, payments: tables.order_payments })).toBe(original);
    expect(mocks.recompute).toHaveBeenCalledWith(admin, ["o1"]);
    expect(await legacySaleSendBlock(admin, "o1")).toContain("No se permiten nuevos envíos");
  });
  it("un reintento no duplica el hecho y sí vuelve a intentar el recálculo", async () => {
    await cancel(); await cancel();
    expect(inserts).toHaveLength(1); expect(mocks.recompute).toHaveBeenCalledTimes(2);
  });
  it("si el recálculo falla, el hecho duradero sigue bloqueando nuevos envíos", async () => {
    mocks.recompute.mockResolvedValue({ written: 0, requested: 1 });
    expect((await cancel()).notice).toContain("pendiente de recalcular");
    expect(await legacySaleSendBlock(admin, "o1")).toContain("No se permiten nuevos envíos");
  });
  it.each(["orders", "stores", "order_master", "shipments", "order_payments", "order_events", "delivery_stops", "insert"])(
    "sin poder comprobar o guardar %s no confirma la anulación", async (table) => {
      fail = table;
      expect((await cancel()).error).toBeTruthy(); expect(inserts).toHaveLength(0);
      expect(mocks.recompute).not.toHaveBeenCalled();
    },
  );
  it("sin poder leer la anulación comercial no permite otro envío", async () => {
    fail = "order_events"; expect(await legacySaleSendBlock(admin, "o1")).toContain("No se pudo comprobar");
  });
  it("una caja ya cotejada no sale con una venta anulada; hay que retirar ese paquete", async () => {
    tables.dispatch_manifest_items = [{ manifest_id: "m1", shipment_id: "s1", removed_at: null }];
    await cancel();
    expect(await legacySaleManifestBlock(admin, "m1")).toContain("Retira su paquete");
    tables.dispatch_manifest_items[0]!.removed_at = "2026-10-28T17:00:00Z";
    expect(await legacySaleManifestBlock(admin, "m1")).toBeNull();
  });
  it("una lectura fallida no libera una caja para despacho", async () => {
    tables.dispatch_manifest_items = [{ manifest_id: "m1", shipment_id: "s1", removed_at: null }];
    fail = "order_events";
    expect(await legacySaleManifestBlock(admin, "m1")).toContain("No se pudo comprobar");
  });
  it("rechaza WooCommerce, tiendas aún en Shopify y pedidos posteriores al cambio", async () => {
    tables.orders![0]!.platform = "woocommerce"; expect((await cancel()).error).toContain("históricos");
    tables.orders![0]!.platform = "shopify"; tables.stores![0]!.platform = "shopify"; expect((await cancel()).error).toContain("históricos");
    tables.stores![0]!.platform = "woocommerce"; tables.orders![0]!.created_at = "2026-10-26T00:00:00Z"; expect((await cancel()).error).toContain("históricos");
    expect(inserts).toHaveLength(0);
  });
  it("la entrega en Rutas bloquea aunque el Master todavía diga en proceso", async () => {
    tables.delivery_stops = [{ order_id: "o1", status: "entregado" }];
    expect((await cancel()).error).toContain("entrega reportada"); expect(inserts).toHaveLength(0);
  });
  it("un pago o un pedido acompañante bloquea esta anulación sin resolución previa", async () => {
    tables.order_payments = [{ order_id: "o1", validation_status: "validado" }];
    expect((await cancel()).error).toContain("dinero"); expect(inserts).toHaveLength(0);
    tables.order_payments = []; mocks.rides.mockRejectedValue(new Error("lectura rota"));
    expect((await cancel()).error).toBeTruthy(); expect(inserts).toHaveLength(0);
  });
});
