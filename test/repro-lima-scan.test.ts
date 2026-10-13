// «Por QR» con la caja de un cliente que ya no la quiere (Repro Lima, MOM §9.3
// fila 1, §29.13). Escanear la caja de un día anterior la recibe en oficina; si
// el último caso del episodio se cerró con «Desarmar y cerrar», la línea dice
// que se desarma y el escaneo termina ahí: ni programa, ni toma, ni asigna.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  reads: [] as { table: string; filters: Record<string, unknown> }[],
  writes: [] as { table: string; value: any }[],
  rpcs: [] as string[],
  hook: vi.fn(),
  recompute: vi.fn(),
  program: null as null | { order_id: string; store_id: string; scheduled_for: string; reason: string; set_at: string },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("login"); } }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "actor" }), getAdminOrgs: async () => [{ org_id: "org" }], getAccessibleStores: async () => [] }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: (...args: unknown[]) => state.recompute(...args) }));
vi.mock("@/app/dashboard/pedidos/despacho/actions", () => ({
  lookupDispatchShipment: async () => ({ shipment: { id: "s01", order_id: "order", courier: "propio", output_code: "KP1-S01", custody_state: "courier" } }),
}));
vi.mock("@/lib/repro-lima-program", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repro-lima-program")>()),
  materializeWaitingAgreementsSafe: (...args: unknown[]) => state.hook(...args),
}));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let value: any;
    const q: any = {};
    q.select = () => q;
    for (const method of ["eq", "in", "is", "neq", "gt", "lt", "gte", "lte"]) q[method] = (key: string, val: unknown) => { filters[key] = val; return q; };
    for (const method of ["limit", "order", "or"]) q[method] = () => q;
    for (const method of ["update", "insert", "upsert", "delete"]) q[method] = (v: any) => { value = v ?? true; return q; };
    const result = (single: boolean) => {
      if (value) { state.writes.push({ table, value }); return { data: null, error: null }; }
      state.reads.push({ table, filters: { ...filters } });
      const data = table === "riders" ? { id: "rider", full_name: "Roy", courier: "propio" }
        : table === "logistics_providers" ? { id: "gf" }
        : table === "orders" ? (single ? { name: "#KP1", cancelled_at: null, cancel_reason: null } : [])
        : table === "order_master" ? (single ? { order_name: "#KP1", order_total: 89, store_id: "store", general_status: "en_curso" } : [])
        // La S01 sigue en la caja de Johnny del lunes 12/10.
        : table === "dispatch_manifest_items" && single
          ? { id: "item", manifest_id: "box-12", office_checked_at: null, dispatch_manifests: { id: "box-12", rider_id: "johnny", driver_name: "Johnny", route_date: "2026-10-12", state: "en_ruta", load_number: 1 } }
        : table === "delivery_stops" ? { status: "no_entregado", outcome_reason: "reprogramado" }
        : table === "shipments" ? (single ? { custody_state: "empresa", output_code: "KP1-S01" } : [])
        : table === "gf_dispatch_programs" ? (state.program ? [state.program] : [])
        : single ? null : [];
      return { data, error: null };
    };
    q.maybeSingle = q.single = async () => result(true);
    q.then = (resolve: any, reject: any) => Promise.resolve(result(false)).then(resolve, reject);
    return q;
  };
  return {
    createAdminSupabase: () => ({
      from,
      rpc: async (name: string) => { state.rpcs.push(name); return { data: null, error: null }; },
    }),
    createServerSupabase: async () => ({ from }),
  };
});

import { scanAssignToRider } from "@/app/dashboard/courier/actions";
import { emptyReproReception, REPRO_NO_LO_QUIERE_NOTICE } from "@/lib/repro-lima-program";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T15:00:00Z"));
  state.reads = [];
  state.writes = [];
  state.rpcs = [];
  state.program = null;
  state.recompute.mockReset();
  state.hook.mockReset().mockResolvedValue(emptyReproReception());
});

const scan = () => scanAssignToRider("org", "rider", "KP1-S01", { scheduledFor: "2026-10-13" });

describe("la caja de un cliente que ya no la quiere, escaneada en «Por QR»", () => {
  it("se recibe en oficina y se desarma: no se programa, ni se toma, ni se asigna", async () => {
    state.hook.mockResolvedValue({ ...emptyReproReception(), noLoQuiere: [{ orderId: "order", orderName: "#KP1" }] });
    const line = await scan();
    expect(line.status).toBe("recibido_a_stock");
    expect(line.receivedFrom).toBe("Johnny del 12/10");
    expect(line.manifestId).toBe("box-12");
    expect(line.message).toBe(`Recibido en oficina (salió de la caja de Johnny del 12/10). ${REPRO_NO_LO_QUIERE_NOTICE} No se asigna.`);
    // Recibida con el mismo RPC que «Devoluciones», y nada más.
    expect(state.rpcs).toEqual(["gf_return_to_office"]);
    expect(state.hook).toHaveBeenCalledWith(expect.anything(), ["order"], "actor", { via: "escaneo" });
    // El Master al día (la caja salió de la ruta del lunes).
    expect(state.recompute).toHaveBeenCalledWith(expect.anything(), ["order"]);
    // Ni el programa, ni la toma, ni la caja de hoy.
    expect(state.reads.some((r) => r.table === "gf_dispatch_programs")).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it("sin «no lo quiere», el mismo escaneo sigue hacia el programa (aquí, de otro día)", async () => {
    state.program = { order_id: "order", store_id: "store", scheduled_for: "2026-10-15", reason: "Repro Lima: confirmado con el cliente (ana, lun 12/10)", set_at: "2026-10-12T20:00:00Z" };
    const line = await scan();
    expect(line.status).toBe("programado_otro_dia");
    expect(line.receivedFrom).toBe("Johnny del 12/10");
    expect(line.message.startsWith("Recibido en oficina (salió de la caja de Johnny del 12/10). ")).toBe(true);
    expect(state.reads.some((r) => r.table === "gf_dispatch_programs")).toBe(true);
  });

  it("el «no lo quiere» de otro pedido no detiene este", async () => {
    state.hook.mockResolvedValue({ ...emptyReproReception(), noLoQuiere: [{ orderId: "otro", orderName: "#KP2" }] });
    state.program = { order_id: "order", store_id: "store", scheduled_for: "2026-10-15", reason: "Programado", set_at: "2026-10-12T20:00:00Z" };
    expect((await scan()).status).toBe("programado_otro_dia");
  });
});
