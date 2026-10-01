import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  allowed: true, member: true, providerActive: true, custody: "empresa", programmed: false,
  reads: [] as { table: string; columns: string; filters: Record<string, unknown> }[],
  writes: [] as { table: string; value: any }[],
  lookup: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("login"); } }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "actor" }), getAdminOrgs: async () => state.member ? [{ org_id: "org" }] : [], getAccessibleStores: async () => [] }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => state.allowed }) }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn() }));
vi.mock("@/app/dashboard/pedidos/despacho/actions", () => ({ lookupDispatchShipment: state.lookup }));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    let columns = "*", single = false, value: any;
    const filters: Record<string, unknown> = {};
    const q: any = {};
    q.select = (c: string) => { columns = c; return q; };
    for (const method of ["eq", "in", "is", "neq"]) q[method] = (key: string, val: unknown) => { filters[key] = val; return q; };
    for (const method of ["limit", "order"]) q[method] = () => q;
    for (const method of ["update", "insert", "upsert"]) q[method] = (v: any) => { value = v; return q; };
    const result = () => {
      if (value) { state.writes.push({ table, value }); return { data: null, error: null }; }
      state.reads.push({ table, columns, filters });
      const request = { id: "request", order_id: "order", shipment_id: "shipment", store_id: "store", status: "accepted", scheduled_for: "2026-10-01" };
      const data = table === "logistics_providers" ? (filters.status && !state.providerActive ? null : { id: "gf", cash_warning_amount: 1000, cash_limit_amount: 2000, rider_pickup_mode: "exigir" })
        : table === "riders" ? { id: "rider", full_name: "Roy", courier: "propio" }
        : table === "order_master" ? (single ? { order_name: "#KP123", order_total: 50, store_id: "store" } : [{ order_id: "order", macro_stage: "por_despachar" }])
        : table === "dispatch_manifest_items" ? (single ? null : [])
        : table === "dispatch_manifests" ? (single ? { state: "draft" } : [])
        : table === "logistics_requests" ? (single ? request : [request])
        : table === "shipments" ? [{ id: "shipment", courier: "propio", custody_state: state.custody }]
        : table === "orders" ? [{ id: "order", total_price: 50, financial_status: "pending" }]
        : table === "gf_dispatch_programs" ? (state.programmed ? [{ order_id: "order", store_id: "store", scheduled_for: "2026-10-03" }] : []) : [];
      return { data, error: null };
    };
    q.maybeSingle = q.single = async () => { single = true; return result(); };
    q.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
    return q;
  };
  return { createAdminSupabase: () => ({ from, rpc: async (name: string) => {
    if (name !== "gf_dispatch_load_open") throw new Error(`Unexpected RPC: ${name}`);
    return { data: "box", error: null };
  } }), createServerSupabase: async () => ({ from }) };
});

import { scanAssignToRider } from "@/app/dashboard/courier/actions";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T15:00:00Z"));
  Object.assign(state, { allowed: true, member: true, providerActive: true, custody: "empresa", programmed: false, reads: [], writes: [] });
  state.lookup.mockReset().mockResolvedValue({ shipment: { id: "shipment", order_id: "order" } });
});
const scan = () => scanAssignToRider("org", "rider", "PED-001", { scheduledFor: "2026-10-01" });

describe("asignación sin lecturas repetidas del proveedor", () => {
  it("asigna, audita y conserva el cotejo pendiente con dos consultas de proveedor en vez de tres", async () => {
    expect(await scan()).toMatchObject({ status: "asignado", manifestId: "box" });
    const providers = state.reads.filter((q) => q.table === "logistics_providers");
    expect(providers).toHaveLength(2);
    expect(providers[0]!.filters).toMatchObject({ org_id: "org", code: "grupo-gf-courier" });
    expect(providers[1]!.filters.status).toBe("active");
    const saved = state.writes.find((w) => w.table === "dispatch_manifest_items")!.value;
    expect(saved).toMatchObject({ manifest_id: "box", shipment_id: "shipment", added_by: "actor" });
    expect(saved.office_checked_at).toBeUndefined();
    expect(state.writes.some((w) => w.table === "order_events" && w.value.kind === "dispatch_route_assigned")).toBe(true);
  });
  it.each(["allowed", "member"] as const)("no lee datos operativos ni escribe sin %s", async (field) => {
    state[field] = false;
    expect((await scan()).status).toBe("no_elegible");
    expect(state.reads).toEqual([]);
    expect(state.lookup).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
  it("vuelve a validar que el proveedor esté activo antes de asignar", async () => {
    state.providerActive = false;
    expect(await scan()).toMatchObject({ status: "no_elegible", message: "Grupo GF Courier no está activo." });
    expect(state.writes).toEqual([]);
  });
  it("conserva la comprobación de custodia antes de escribir", async () => {
    state.custody = "courier";
    expect((await scan()).message).toContain("custodia");
    expect(state.writes).toEqual([]);
  });
  it("no toma ni asigna un pedido programado para otro día", async () => {
    state.programmed = true;
    expect((await scan()).status).toBe("programado_otro_dia");
    expect(state.writes).toEqual([]);
  });
  it("consulta motorizado y proveedor mientras la búsqueda del QR sigue pendiente", async () => {
    let resolve!: (value: unknown) => void;
    state.lookup.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const result = scan();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(state.reads.map((q) => q.table)).toEqual(["riders", "logistics_providers"]);
    expect(state.writes).toEqual([]);
    resolve({ shipment: { id: "shipment", order_id: "order" } });
    expect((await result).status).toBe("asignado");
  });
});
