import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  shipment: {} as Record<string, any>,
  item: null as Record<string, any> | null,
  receipts: [] as Record<string, any>[],
  stopStatus: "no_entregado",
  failRead: false,
  store: "store",
  rpcs: [] as string[],
  writes: [] as string[],
}));
const receipt = () => ({ shipment_id: "s01", kind: "returned_to_office", source: "dispatch", actor: "actor", occurred_at: "2026-10-28T18:51:04Z", payload: { manifest_id: "box" } });

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "actor" }), getAdminOrgs: async () => [{ org_id: "org" }], getAccessibleStores: async () => [] }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn() }));
vi.mock("@/lib/repro-lima-program", async (original) => {
  const mod = await original<typeof import("@/lib/repro-lima-program")>();
  return { ...mod, materializeWaitingAgreementsSafe: async () => mod.emptyReproReception() };
});
vi.mock("@/app/dashboard/pedidos/despacho/actions", () => ({ lookupDispatchShipment: async () => ({ shipment: state.shipment, byOrderName: false }) }));
vi.mock("@/lib/gf-active-boxes", () => ({ loadActiveBoxes: async () => new Map(state.item ? [["s01", { manifestId: "box", undeliveredReason: state.stopStatus === "no_entregado" ? "rechazado" : null }]] : []) }));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const filters: Array<(row: Record<string, any>) => boolean> = [];
    const q: any = {};
    q.select = () => q;
    q.in = (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return q; };
    q.eq = q.is = (key: string, value: unknown) => { filters.push(row => row[key] === value); return q; };
    q.not = (key: string, _operator: string, value: unknown) => { filters.push(row => row[key] !== value); return q; };
    q.insert = q.update = q.delete = () => { state.writes.push(table); return q; };
    const result = (single = false) => {
      const rows = table === "stores" ? [{ id: state.store, org_id: "org" }]
        : table === "shipments" ? [state.shipment]
        : table === "dispatch_manifest_items" ? (state.item ? [state.item] : [])
        : table === "order_events" ? state.receipts
        : table === "order_master" ? [{ order_id: "order", order_name: "#KP200152" }] : [];
      const data = rows.filter(row => filters.every(filter => filter(row)));
      return { data: single ? data[0] ?? null : data, error: state.failRead && table === "order_events" ? { message: "read failed" } : null };
    };
    q.maybeSingle = async () => result(true);
    q.then = (ok: any, no: any) => Promise.resolve(result()).then(ok, no);
    return q;
  };
  return { createAdminSupabase: () => ({ from, rpc: async (name: string) => {
    state.rpcs.push(name);
    state.item = null; state.shipment.custody_state = "empresa"; state.shipment.dispatched_at = null;
    state.receipts.push({ shipment_id: "s01", kind: "returned_to_office", source: "dispatch", actor: "actor", occurred_at: "2026-10-28T18:51:04Z", payload: { manifest_id: "box" } });
    return { data: "order", error: null };
  } }), createServerSupabase: async () => ({ from }) };
});

import { findOfficeReceipts } from "@/lib/gf-office-receipts";
import { createAdminSupabase } from "@/lib/db";
import { returnUndeliveredByCode, returnUndeliveredOutputs } from "@/app/dashboard/courier/actions";

beforeEach(() => {
  state.shipment = { id: "s01", store_id: "store", order_id: "order", courier: "propio", custody_state: "empresa", delivery_status: "pendiente", dispatched_at: null };
  state.item = null; state.receipts = [receipt()]; state.stopStatus = "no_entregado";
  state.failRead = false; state.store = "store"; state.rpcs = []; state.writes = [];
});

describe("volver a escanear una devolución GF", () => {
  it("KP200152: ya recibido devuelve confirmación y la identidad de la salida, sin escribir", async () => {
    const result = await returnUndeliveredByCode("org", "KP200152-S01");
    expect(result).toMatchObject({ orderName: "#KP200152", receivedShipmentIds: ["s01"] });
    expect(result.error).toBeUndefined();
    expect(result.notice).toContain("ya estaba recibida en oficina");
    expect(state.rpcs).toEqual([]); expect(state.writes).toEqual([]);
  });
  it("recibir y repetir escribe una sola recepción", async () => {
    state.item = { id: "item", manifest_id: "box", shipment_id: "s01", removed_at: null };
    state.shipment.custody_state = "courier"; state.shipment.dispatched_at = "2026-10-27T18:11:00Z"; state.receipts = [];
    expect((await returnUndeliveredByCode("org", "KP200152-S01")).receivedShipmentIds).toEqual(["s01"]);
    expect((await returnUndeliveredByCode("org", "KP200152-S01")).notice).toContain("ya estaba recibida");
    expect(state.rpcs).toEqual(["gf_return_to_office"]);
  });
  it("una ruta no confirma la recepción de otra caja", async () => {
    const result = await returnUndeliveredOutputs("org", ["s01"], { manifestIds: ["another-box"] });
    expect(result.error).toBeTruthy(); expect(result.receivedShipmentIds).toBeUndefined();
    expect((await returnUndeliveredOutputs("org", ["s01"], { manifestIds: ["box"] })).receivedShipmentIds).toEqual(["s01"]);
  });
  it("fuera de la organización no revela recepción ni nombre", async () => {
    state.store = "other-store";
    const result = await returnUndeliveredByCode("org", "KP200152-S01");
    expect(result.error).toBeTruthy(); expect(result.orderName).toBeUndefined(); expect(result.receivedShipmentIds).toBeUndefined();
  });
  it("sin evidencia, en otra caja o tras salir otra vez no se da por recibida", async () => {
    state.receipts = [];
    expect(await findOfficeReceipts(createAdminSupabase(), ["s01"])).toEqual([]);
    state.receipts = [receipt()]; state.item = { shipment_id: "s01", removed_at: null };
    expect(await findOfficeReceipts(createAdminSupabase(), ["s01"])).toEqual([]);
    state.item = null; state.shipment.dispatched_at = "2026-10-29T12:00:00Z";
    expect(await findOfficeReceipts(createAdminSupabase(), ["s01"])).toEqual([]);
  });
  it.each(["courier", "retorno"])("custodia %s no permite confirmar una recepción vieja", async (custody) => {
    state.shipment.custody_state = custody;
    expect(await findOfficeReceipts(createAdminSupabase(), ["s01"])).toEqual([]);
  });
  it("entregado o evidencia sin actor no confirma devolución", async () => {
    state.shipment.delivery_status = "entregado";
    expect(await findOfficeReceipts(createAdminSupabase(), ["s01"])).toEqual([]);
    state.shipment.delivery_status = "pendiente"; state.receipts[0]!.actor = null;
    expect(await findOfficeReceipts(createAdminSupabase(), ["s01"])).toEqual([]);
  });
  it("una lectura fallida no se interpreta como recepción confirmada", async () => {
    state.failRead = true;
    await expect(findOfficeReceipts(createAdminSupabase(), ["s01"])).rejects.toThrow("read failed");
    expect((await returnUndeliveredByCode("org", "KP200152-S01")).error).toContain("No se pudo comprobar");
    expect(state.rpcs).toEqual([]);
  });
});
