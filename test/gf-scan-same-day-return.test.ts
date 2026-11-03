// «Por QR» y «Agregar pedidos» con un paquete de una caja de HOY que volvió
// (MOM §29.13, 26-10-2026). #KP142954 salió en la caja de Yhoni del 26/10, Yhoni
// lo reportó «No entregado» y volvió a la oficina; escanearlo para la caja de
// Alexis del mismo día respondía «Está en la caja de Yhoni» y «Mover» fallaba
// («Esa parada ya fue reportada»). Ahora el escaneo lo recibe en oficina con el
// mismo RPC que «Devoluciones» y sigue hacia la asignación, igual que el de un
// día anterior. Lo entregado, lo que no tiene reporte y la segunda vuelta con
// el mismo motorizado no cambian de caja.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  reads: [] as { table: string; filters: Record<string, unknown> }[],
  writes: [] as { table: string; value: any }[],
  rpcs: [] as string[],
  hook: vi.fn(),
  recompute: vi.fn(),
  boxRider: "yhoni",
  stop: { status: "no_entregado", outcome_reason: "no_contesta" } as null | { status: string; outcome_reason: string | null },
  program: null as null | { order_id: string; store_id: string; scheduled_for: string; reason: string; set_at: string },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("login"); } }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "actor" }), getAdminOrgs: async () => [{ org_id: "org" }], getAccessibleStores: async () => [] }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: (...args: unknown[]) => state.recompute(...args) }));
vi.mock("@/app/dashboard/pedidos/despacho/actions", () => ({
  lookupDispatchShipment: async () => ({ shipment: { id: "s01", order_id: "order", courier: "propio", output_code: "KP142954-S01", custody_state: "courier" } }),
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
      const data = table === "riders" ? { id: "alexis", full_name: "Alexis", courier: "propio" }
        : table === "logistics_providers" ? { id: "gf" }
        : table === "orders" ? (single ? { name: "#KP142954", cancelled_at: null, cancel_reason: null } : [])
        : table === "order_master" ? (single ? { order_name: "#KP142954", order_total: 89, store_id: "store", general_status: "en_curso" } : [])
        // La S01 sigue en la caja de HOY (26/10), ya en la calle.
        : table === "dispatch_manifest_items" && single
          ? { id: "item", manifest_id: "box-26", office_checked_at: "2026-10-26T13:00:00Z", dispatch_manifests: { id: "box-26", rider_id: state.boxRider, driver_name: state.boxRider === "yhoni" ? "Yhoni" : "Alexis", route_date: "2026-10-26", state: "in_custody", load_number: 1 } }
        : table === "delivery_stops" ? state.stop
        : table === "shipments" ? (single ? { custody_state: "empresa", output_code: "KP142954-S01" } : [])
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
  vi.setSystemTime(new Date("2026-10-26T15:00:00Z"));
  state.reads = [];
  state.writes = [];
  state.rpcs = [];
  state.boxRider = "yhoni";
  state.stop = { status: "no_entregado", outcome_reason: "no_contesta" };
  state.program = null;
  state.recompute.mockReset();
  state.hook.mockReset().mockResolvedValue(emptyReproReception());
});

// La caja de Alexis del 26/10.
const scan = () => scanAssignToRider("org", "alexis", "KP142954-S01", { scheduledFor: "2026-10-26" });

describe("#KP142954: «No entregado» en la caja de hoy de otro motorizado", () => {
  it("se recibe en oficina con el mismo RPC y sigue hacia la asignación (aquí, programado para otro día)", async () => {
    state.program = { order_id: "order", store_id: "store", scheduled_for: "2026-10-28", reason: "Programado", set_at: "2026-10-26T14:00:00Z" };
    const line = await scan();
    expect(line.status).toBe("programado_otro_dia");
    expect(line.receivedFrom).toBe("Yhoni del 26/10");
    expect(line.message.startsWith("Recibido en oficina (salió de la caja de Yhoni del 26/10). ")).toBe(true);
    expect(state.rpcs).toEqual(["gf_return_to_office"]);
    // La parada se leyó de ESA caja; Repro Lima, como el de un día anterior.
    expect(state.reads.some((r) => r.table === "delivery_stops" && r.filters.dispatch_manifest_id === "box-26")).toBe(true);
    expect(state.hook).toHaveBeenCalledWith(expect.anything(), ["order"], "actor", { via: "escaneo" });
  });

  it("si el cliente ya no lo quiere, se recibe y no se asigna", async () => {
    state.hook.mockResolvedValue({ ...emptyReproReception(), noLoQuiere: [{ orderId: "order", orderName: "#KP142954" }] });
    const line = await scan();
    expect(line.status).toBe("recibido_a_stock");
    expect(line.message).toBe(`Recibido en oficina (salió de la caja de Yhoni del 26/10). ${REPRO_NO_LO_QUIERE_NOTICE} No se asigna.`);
    expect(state.rpcs).toEqual(["gf_return_to_office"]);
  });

  it("un rechazo también se recibe (v1.23)", async () => {
    state.stop = { status: "no_entregado", outcome_reason: "rechazado" };
    state.program = { order_id: "order", store_id: "store", scheduled_for: "2026-10-28", reason: "Programado", set_at: "2026-10-26T14:00:00Z" };
    expect((await scan()).receivedFrom).toBe("Yhoni del 26/10");
    expect(state.rpcs).toEqual(["gf_return_to_office"]);
  });
});

describe("lo de hoy que no se recibe", () => {
  it("entregado: lo dice, sin «Mover» ni recibir", async () => {
    state.stop = { status: "entregado", outcome_reason: null };
    const line = await scan();
    expect(line.status).toBe("no_elegible");
    expect(line.message).toBe("Yhoni lo reportó entregado (la caja de Yhoni del 26/10).");
    expect(state.rpcs).toEqual([]);
  });

  it("sin reporte: la regla de siempre, «En la caja de Yhoni» con «Mover» (0230)", async () => {
    state.stop = { status: "pendiente", outcome_reason: null };
    const line = await scan();
    expect(line.status).toBe("en_otra_caja");
    expect(line.manifestId).toBe("box-26");
    expect(state.rpcs).toEqual([]);
    state.stop = null;
    expect((await scan()).status).toBe("en_otra_caja");
  });

  it("segunda vuelta con el MISMO motorizado: reintento del mismo día (§9.3), no se recibe ni se asigna", async () => {
    state.boxRider = "alexis";
    const line = await scan();
    expect(line.status).toBe("no_elegible");
    expect(line.message).toContain("es el reintento del mismo día");
    expect(state.rpcs).toEqual([]);
    expect(state.writes).toEqual([]);
  });

  it("del mismo motorizado y sin reporte, sigue siendo «Ya estaba»", async () => {
    state.boxRider = "alexis";
    state.stop = { status: "pendiente", outcome_reason: null };
    expect((await scan()).status).toBe("ya_en_caja");
  });
});
