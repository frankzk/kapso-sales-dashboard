import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TandersPackageLocation } from "@/lib/gf-tanders-review";

const state = vi.hoisted(() => ({
  order: {} as Record<string, unknown>,
  outputs: [] as Record<string, unknown>[],
  writes: [] as { table: string; op: string; value: any; filters: Record<string, unknown> }[],
  canDispatch: true,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "manager" }), getAdminOrgs: async () => [{ org_id: "org" }], getAccessibleStores: async () => [] }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: (p: string) => p !== "dispatch.manage" || state.canDispatch }) }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn() }));
vi.mock("@/lib/grupo-gf-courier-route-access", () => ({
  loadGroupGfCourierRouteCheck: async () => ({ eligible: true, providerId: "gf", agreementId: "agreement", districtKey: "los olivos", tariffId: "tariff", tariffAmount: 12, currency: "PEN", sameDayCutoff: "11:30" }),
  riderPickupMode: vi.fn(),
}));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    let op = "read";
    let value: any;
    const filters: Record<string, unknown> = {};
    const q: any = {};
    for (const method of ["select", "in", "limit", "is", "order", "neq"]) q[method] = () => q;
    q.eq = (key: string, val: unknown) => { filters[key] = val; return q; };
    for (const method of ["insert", "update"]) q[method] = (val: unknown) => { op = method; value = val; return q; };
    const result = () => {
      if (op !== "read") {
        state.writes.push({ table, op, value, filters: { ...filters } });
        return { data: table === "shipments" ? { id: value.id ?? filters.id, output_code: "KP137018-S02" } : { id: value.id ?? "request" }, error: null };
      }
      const data = table === "logistics_providers" ? { id: "gf" }
        : table === "order_master" ? state.order
        : table === "shipments" ? state.outputs
        : table === "orders" ? { line_items: [] } : null;
      return { data, error: null };
    };
    q.maybeSingle = q.single = async () => result();
    q.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
    return q;
  };
  return { createAdminSupabase: () => ({ from }), createServerSupabase: async () => ({ from }) };
});

import { takeGroupGfCourierOrders } from "@/app/dashboard/courier/actions";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T15:00:00Z"));
  state.canDispatch = true;
  state.writes = [];
  state.order = { order_id: "order", order_name: "#KP137018", store_id: "store", coverage: "lima", current_courier: "tanders", macro_stage: "en_curso", macro_substage: "en_transito", operational_status: "en_ruta", district: "Los Olivos" };
  state.outputs = [{ id: "old-tanders", order_id: "order", courier: "tanders", delivery_status: "en_ruta", dispatched_at: "2026-09-28T15:20:17Z", status_category: "in_route", reported_status: "PICKED", custody_state: "courier" }];
});

const take = (packageLocation?: TandersPackageLocation) => takeGroupGfCourierOrders("org", ["order"], {
  tandersConfirmations: packageLocation ? { order: { shipmentIds: ["old-tanders"], packageLocation } } : undefined,
});

describe("admisión real de Tanders con dependencias de datos simuladas", () => {
  it("una llamada directa sin confirmación no escribe nada", async () => {
    expect((await take()).error).toContain("confirma en Desde la lista");
    expect(state.writes).toEqual([]);
  });
  it.each(["returned", "additional"] as const)("%s crea otra salida y audita la declaración sin modificar Tanders", async (location) => {
    const result = await take(location);
    expect(result.error).toBeUndefined();
    expect(result.accepted).toHaveLength(1);
    const inserted = state.writes.find((w) => w.table === "shipments" && w.op === "insert")!;
    expect(inserted.value.id).not.toBe("old-tanders");
    expect(inserted.value).toMatchObject({ courier: "propio", preparation_state: "rotulo_generado", custody_state: "empresa" });
    expect(state.writes.filter((w) => w.table === "shipments" && w.op === "update").every((w) => w.filters.id !== "old-tanders")).toBe(true);
    const event = state.writes.find((w) => w.table === "order_events" && w.value.kind === "logistics_request_accepted")!;
    expect(event.value).toMatchObject({ actor: "manager", payload: { tandersReview: { shipmentIds: ["old-tanders"], packageLocation: location } } });
    expect(state.writes.some((w) => w.value.kind === "additional_output_reason")).toBe(true);
  });
  it("una entrega posterior a abrir la lista invalida la confirmación", async () => {
    state.outputs[0]!.reported_status = "DELIVERED";
    expect((await take("additional")).accepted).toEqual([]);
    expect(state.writes).toEqual([]);
  });
  it("otra salida activa posterior a abrir la lista impide duplicarla", async () => {
    state.outputs.push({ ...state.outputs[0], id: "other", courier: "propio", delivery_status: "pendiente" });
    expect((await take("additional")).accepted).toEqual([]);
    expect(state.writes).toEqual([]);
  });
  it("respeta el permiso de despacho", async () => {
    state.canDispatch = false;
    expect((await take("returned")).error).toContain("No tienes permiso");
    expect(state.writes).toEqual([]);
  });
  it("respeta el máximo de cinco salidas", async () => {
    for (let i = 0; i < 4; i++) state.outputs.push({ ...state.outputs[0], id: `old-${i}`, delivery_status: "anulado" });
    expect((await take("additional")).error).toContain("máximo de 5");
    expect(state.writes).toEqual([]);
  });
});

describe("admisión de una guía Swayp que su bodega no despachó (#KP138099)", () => {
  beforeEach(() => {
    // Sábado 03-10-2026, 12:30 de Lima: el reparto de Swayp era el viernes.
    vi.setSystemTime(new Date("2026-10-03T17:30:00Z"));
    state.order = { order_id: "order", order_name: "#KP138099", store_id: "store", coverage: "lima", current_courier: "fenix", macro_stage: "en_curso", macro_substage: "en_reparto", operational_status: "en_reparto", district: "Lurin" };
    state.outputs = [{ id: "swayp-s01", order_id: "order", courier: "fenix", created_via: "fenix_directo", delivery_status: "en_ruta", dispatched_at: "2026-10-02T05:36:54Z", status_category: "in_route", reported_status: "Swayp · Bodega no despacho mercancía (20)", swayp_state: 6, custody_state: "courier" }];
  });
  const takeSwayp = (packageLocation?: TandersPackageLocation) => takeGroupGfCourierOrders("org", ["order"], {
    tandersConfirmations: packageLocation ? { order: { shipmentIds: ["swayp-s01"], packageLocation } } : undefined,
  });

  it("el escaneo o una llamada directa sin confirmación lo dice y no escribe nada", async () => {
    const result = await takeSwayp();
    expect(result.failed[0]?.error).toContain("la bodega de Swayp no lo despachó");
    expect(state.writes).toEqual([]);
  });
  it("confirmado, crea otra salida de Grupo GF sin tocar la guía de Swayp", async () => {
    const result = await takeSwayp("returned");
    expect(result.error).toBeUndefined();
    expect(result.accepted).toHaveLength(1);
    const inserted = state.writes.find((w) => w.table === "shipments" && w.op === "insert")!;
    expect(inserted.value).toMatchObject({ courier: "propio", custody_state: "empresa" });
    expect(state.writes.filter((w) => w.table === "shipments" && w.op === "update").every((w) => w.filters.id !== "swayp-s01")).toBe(true);
    const reason = state.writes.find((w) => w.table === "order_events" && w.value.kind === "additional_output_reason")!;
    expect(reason.value.reason).toContain("bodega no despachó");
  });
  it("si Swayp la devuelve a Reparto, ya no se ofrece", async () => {
    state.outputs[0]!.swayp_state = 5;
    expect((await takeSwayp("returned")).accepted).toEqual([]);
    expect(state.writes).toEqual([]);
  });
});
