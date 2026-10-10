// Asignar por escaneo con el rótulo viejo de la caja que volvió (§29.4,
// 09-10-2026). El pedido ya se tomó «Desde la lista» —nació su S02 y quedó en
// la caja del motorizado— antes de que alguien imprimiera el rótulo nuevo, así
// que la caja todavía lleva el de Tanders (S01). Escanear ese rótulo no puede
// responder «ya está asignado a una ruta» ni dejarlo sin aviso: la caja va
// como la S02, que es la de su solicitud de Grupo GF.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  boxRider: "rider" as string,
  reads: [] as { table: string; filters: Record<string, unknown> }[],
  writes: [] as { table: string; value: any }[],
  scanned: { id: "s01", order_id: "order", courier: "tanders", output_code: "AUR177756-S01" } as Record<string, unknown>,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("login"); } }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "actor" }), getAdminOrgs: async () => [{ org_id: "org" }], getAccessibleStores: async () => [] }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn() }));
vi.mock("@/app/dashboard/pedidos/despacho/actions", () => ({ lookupDispatchShipment: async () => ({ shipment: state.scanned }) }));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let value: any;
    const q: any = {};
    q.select = () => q;
    for (const method of ["eq", "in", "is", "neq"]) q[method] = (key: string, val: unknown) => { filters[key] = val; return q; };
    for (const method of ["limit", "order", "or"]) q[method] = () => q;
    for (const method of ["update", "insert", "upsert"]) q[method] = (v: any) => { value = v; return q; };
    const result = () => {
      if (value) { state.writes.push({ table, value }); return { data: null, error: null }; }
      state.reads.push({ table, filters: { ...filters } });
      const data = table === "riders" ? { id: "rider", full_name: "Alexis", courier: "propio" }
        : table === "logistics_providers" ? { id: "gf" }
        : table === "logistics_requests" ? { shipment_id: "s02" }
        : table === "shipments" ? { output_code: "AUR177756-S02" }
        : table === "order_master" ? { order_name: "#AUR177756", order_total: 89, store_id: "store" }
        // La S02 ya está en la caja de hoy (Desde la lista); la S01 en ninguna.
        : table === "dispatch_manifest_items" && filters.shipment_id === "s02"
          ? { id: "item", manifest_id: "box", office_checked_at: null, dispatch_manifests: { id: "box", rider_id: state.boxRider, driver_name: state.boxRider === "rider" ? "Alexis" : "Roy", route_date: "2026-10-09", state: "draft" } }
        : null;
      return { data, error: null };
    };
    q.maybeSingle = q.single = async () => result();
    q.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
    return q;
  };
  return { createAdminSupabase: () => ({ from, rpc: async () => ({ data: null, error: null }) }), createServerSupabase: async () => ({ from }) };
});

import { scanAssignToRider } from "@/app/dashboard/courier/actions";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T15:00:00Z"));
  state.boxRider = "rider";
  state.reads = [];
  state.writes = [];
  state.scanned = { id: "s01", order_id: "order", courier: "tanders", output_code: "AUR177756-S01" };
});

const scan = () => scanAssignToRider("org", "rider", "AUR177756-S01", { scheduledFor: "2026-10-09" });

describe("el rótulo viejo de un pedido ya tomado «Desde la lista»", () => {
  it("con la S02 en la caja de este motorizado: «ya estaba», y pide pegar su rótulo", async () => {
    const line = await scan();
    expect(line.status).toBe("ya_en_caja");
    expect(line.shipmentId).toBe("s02");
    expect(line.relabel).toEqual({ outputCode: "AUR177756-S02", labelUrl: "/api/pedidos/rotulos?ids=s02" });
    expect(line.message).toContain("Leíste el rótulo de AUR177756-S01 (Tanders): la caja va como AUR177756-S02. Imprime su rótulo y pégalo encima.");
    // Se buscó en las cajas por la S02, no por la S01.
    expect(state.reads.some((r) => r.table === "dispatch_manifest_items" && r.filters.shipment_id === "s02")).toBe(true);
    expect(state.writes).toEqual([]);
  });

  it("con la S02 en la caja de otro motorizado: dice cuál y deja moverla (la línea apunta a la S02)", async () => {
    state.boxRider = "otro";
    const line = await scan();
    expect(line.status).toBe("en_otra_caja");
    expect(line.shipmentId).toBe("s02");
    expect(line.relabel?.outputCode).toBe("AUR177756-S02");
  });

  it("un rótulo de Grupo GF no paga la lectura de la solicitud", async () => {
    state.scanned = { id: "s02", order_id: "order", courier: "propio", output_code: "AUR177756-S02" };
    const line = await scan();
    expect(line.status).toBe("ya_en_caja");
    expect(line.relabel ?? null).toBeNull();
    expect(state.reads.some((r) => r.table === "logistics_requests")).toBe(false);
  });
});
