// Escanear el rótulo de una salida ANULADA (24-10-2026). AUR178551-S01 la anuló
// una compañera a las 15:28 UTC (10:28 de Lima) con «Anular salida»
// (`route_output_cancelled`). Después alguien escaneó su QR impreso para
// asignarlo a un motorizado y el escaneo respondió «La caja existente ya no
// está disponible para asignarla.»: no decía que estaba anulada, ni quién ni
// cuándo, ni qué hacer. Solo cambia el mensaje: nada se reactiva ni se asigna.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { annulledOutputScanMessage, annulledOutputScanNotice } from "@/lib/scan-annulled-output";

const state = vi.hoisted(() => ({
  outputs: [] as Array<Record<string, unknown>>,
  event: null as Record<string, unknown> | null,
  email: "rosa.perez@example.com" as string | null,
  reads: [] as { table: string; filters: Record<string, unknown> }[],
  writes: [] as { table: string; value: unknown }[],
  scanned: { id: "s01", order_id: "order", courier: "por_definir", output_code: "AUR178551-S01", custody_state: "empresa" } as Record<string, unknown>,
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
    let value: unknown;
    const q: any = {};
    q.select = () => q;
    for (const method of ["eq", "in", "is", "neq"]) q[method] = (key: string, val: unknown) => { filters[key] = val; return q; };
    for (const method of ["limit", "order", "or", "range"]) q[method] = () => q;
    for (const method of ["update", "insert", "upsert", "delete"]) q[method] = (v: unknown) => { value = v ?? true; return q; };
    const result = (single: boolean) => {
      if (value) { state.writes.push({ table, value }); return { data: null, error: null }; }
      state.reads.push({ table, filters: { ...filters } });
      if (table === "riders") return { data: { id: "rider", full_name: "Roy", courier: "propio" }, error: null };
      if (table === "logistics_providers") return { data: { id: "gf" }, error: null };
      // Ninguna solicitud de Grupo GF todavía: la toma lo intenta.
      if (table === "logistics_requests") return { data: single ? null : [], error: null };
      if (table === "orders") return { data: { name: "#AUR178551", cancelled_at: null, cancel_reason: null }, error: null };
      if (table === "order_master") {
        return { data: { order_id: "order", store_id: "store", order_name: "#AUR178551", order_total: 89, general_status: "en_proceso", macro_stage: "por_despachar", macro_substage: "listo_para_asignar", district: "Surco" }, error: null };
      }
      if (table === "shipments") return { data: single ? state.outputs[0] ?? null : state.outputs, error: null };
      if (table === "dispatch_manifest_items") return { data: single ? null : [], error: null };
      // Solo la lectura de la anulación (`.in("kind", […])`) encuentra el hecho.
      if (table === "order_events") {
        const kinds = filters.kind as string[] | undefined;
        if (kinds?.includes("legacy_shopify_sale_cancelled")) return { data: [], error: null };
        return { data: Array.isArray(kinds) ? state.event : single ? null : [], error: null };
      }
      return { data: single ? null : [], error: null };
    };
    q.maybeSingle = q.single = async () => result(true);
    q.then = (resolve: any, reject: any) => Promise.resolve(result(false)).then(resolve, reject);
    return q;
  };
  const admin = {
    from,
    rpc: async () => ({ data: null, error: null }),
    auth: { admin: { getUserById: async () => ({ data: { user: state.email ? { email: state.email } : null } }) } },
  };
  return { createAdminSupabase: () => admin, createServerSupabase: async () => ({ from }) };
});

import { scanAssignToRider } from "@/app/dashboard/courier/actions";
import { createAdminSupabase } from "@/lib/db";

const S01 = {
  id: "s01",
  order_id: "order",
  courier: "por_definir",
  created_via: "mom_manual_route",
  delivery_status: "anulado",
  status_category: "closed",
  custody_state: "empresa",
  custody_transferred_at: null,
  output_number: 1,
  output_code: "AUR178551-S01",
  guide_code: "MOM-AUR178551-POR_DEFINIR-1",
  created_at: "2026-10-24T14:00:00Z",
};
const ANNUL_EVENT = { actor: "u-rosa", occurred_at: "2026-10-24T15:28:00Z" };
const NEXT_STEP = "Crea una salida nueva desde la ficha del pedido (Operar → Crear salida) e imprime su rótulo; este rótulo ya no sirve.";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T20:00:00Z"));
  state.outputs = [{ ...S01 }];
  state.event = { ...ANNUL_EVENT };
  state.email = "rosa.perez@example.com";
  state.reads = [];
  state.writes = [];
  state.scanned = { id: "s01", order_id: "order", courier: "por_definir", output_code: "AUR178551-S01", custody_state: "empresa" };
});

describe("annulledOutputScanMessage", () => {
  it("AUR178551-S01: cuál, quién, cuándo en Lima y qué hacer", () => {
    expect(annulledOutputScanMessage({ outputCode: "AUR178551-S01", annulledAt: "2026-10-24T15:28:00Z", actorName: "rosa.perez" }))
      .toBe(`AUR178551-S01 está ANULADA (la anuló rosa.perez el 24/10 a las 10:28). ${NEXT_STEP}`);
  });

  it("sin actor dice cuándo; sin nada, solo que está anulada", () => {
    expect(annulledOutputScanMessage({ outputCode: "AUR178551-S01", annulledAt: "2026-10-24T15:28:00Z", actorName: null }))
      .toBe(`AUR178551-S01 está ANULADA (se anuló el 24/10 a las 10:28). ${NEXT_STEP}`);
    expect(annulledOutputScanMessage({ outputCode: null, annulledAt: null, actorName: null }))
      .toBe(`Esta salida está ANULADA. ${NEXT_STEP}`);
  });

  it("con otra salida viva no manda a crear otra: nombra la viva y conserva el motivo", () => {
    expect(annulledOutputScanMessage({ outputCode: "AUR178551-S01", annulledAt: "2026-10-24T15:28:00Z", actorName: "rosa.perez", liveOutputCode: "AUR178551-S02", reason: "Tarifa faltante para el distrito." }))
      .toBe("AUR178551-S01 está ANULADA (la anuló rosa.perez el 24/10 a las 10:28): este rótulo ya no sirve; el pedido sigue con AUR178551-S02. Tarifa faltante para el distrito.");
  });
});

describe("annulledOutputScanNotice", () => {
  const admin = () => createAdminSupabase() as never;

  it("lee la salida, el hecho de la anulación y el nombre corto de quien la anuló", async () => {
    expect(await annulledOutputScanNotice(admin(), { id: "s01", order_id: "order" }, "La caja existente ya no está disponible para asignarla."))
      .toBe(`AUR178551-S01 está ANULADA (la anuló rosa.perez el 24/10 a las 10:28). ${NEXT_STEP}`);
    const annulRead = state.reads.find((r) => r.table === "order_events");
    expect(annulRead?.filters).toMatchObject({ shipment_id: "s01", kind: ["route_output_cancelled", "guide_cancelled"] });
  });

  it("una salida viva no tiene aviso: el escaneo dice lo de siempre", async () => {
    state.outputs = [{ ...S01, delivery_status: "pendiente", status_category: "active" }];
    expect(await annulledOutputScanNotice(admin(), { id: "s01", order_id: "order" }, "x")).toBeNull();
    expect(state.reads.some((r) => r.table === "order_events")).toBe(false);
  });

  it("sin salida escaneada (se leyó el número de pedido) no hay nada que decir", async () => {
    expect(await annulledOutputScanNotice(admin(), null, "x")).toBeNull();
    expect(state.reads).toEqual([]);
  });

  it("el actor que no se puede resolver no inventa un nombre", async () => {
    state.email = null;
    expect(await annulledOutputScanNotice(admin(), { id: "s01", order_id: "order" }, "x"))
      .toBe(`AUR178551-S01 está ANULADA (se anuló el 24/10 a las 10:28). ${NEXT_STEP}`);
  });
});

describe("Despacho del día → Asignar por QR con el rótulo de AUR178551-S01", () => {
  const scan = () => scanAssignToRider("org", "rider", "AUR178551-S01", { scheduledFor: "2026-10-24" });

  it("dice que está anulada, quién y cuándo, y qué hacer; no toma ni asigna nada", async () => {
    const line = await scan();
    expect(line.status).toBe("no_elegible");
    expect(line.message).toBe(`AUR178551-S01 está ANULADA (la anuló rosa.perez el 24/10 a las 10:28). ${NEXT_STEP}`);
    expect(state.writes).toEqual([]);
  });

  it("con una S02 viva nombra la que sirve y deja el motivo de siempre detrás", async () => {
    state.outputs = [{ ...S01 }, { ...S01, id: "s02", courier: "propio", created_via: "grupo_gf_courier", delivery_status: "pendiente", status_category: "active", output_number: 2, output_code: "AUR178551-S02" }];
    const line = await scan();
    expect(line.status).toBe("no_elegible");
    expect(line.message).toMatch(/^AUR178551-S01 está ANULADA \(la anuló rosa.perez el 24\/10 a las 10:28\): este rótulo ya no sirve; el pedido sigue con AUR178551-S02\. \S/);
    expect(state.writes).toEqual([]);
  });

  it("un rótulo vivo que no se puede asignar responde exactamente lo de antes", async () => {
    // La misma S01, viva y ya con courier: la toma la ve asignada.
    state.outputs = [{ ...S01, courier: "tanders", created_via: "tanders", delivery_status: "pendiente", status_category: "active" }];
    const line = await scan();
    expect(line.status).toBe("no_elegible");
    expect(line.message).toBe("AUR178551-S01 es de Tanders y sigue en almacén. Para llevarlo en Grupo GF, anula la de almacén en la ficha («Salidas y guías»).");
    expect(state.reads.some((r) => r.table === "order_events" && Array.isArray(r.filters.kind) && r.filters.kind.includes("route_output_cancelled"))).toBe(false);
  });
});
