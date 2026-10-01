import { beforeEach, describe, expect, it, vi } from "vitest";
import { courierCodePattern, courierSearchCode, findCourierRouteMatches } from "@/lib/courier-route-search";
import { getCourierRouteLedger, ledgerIsOpen } from "@/lib/courier-route-ledger";
import { searchCourierRoutes } from "@/app/dashboard/courier/route-search-actions";

const db = vi.hoisted(() => ({ tables: {} as Record<string, Record<string, any>[]>, calls: [] as string[], allowed: true, user: true, failure: "" }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => db.user ? { id: "user" } : null, getAccessibleStores: async () => [{ id: "store" }] }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => db.allowed }) }));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => { throw new Error("search must use RLS"); },
  createServerSupabase: async () => ({ from: (table: string) => {
    db.calls.push(table);
    let rows = [...(db.tables[table] ?? [])];
    const query: any = {
      select: () => query,
      eq: (key: string, value: unknown) => { rows = rows.filter((r) => r[key] === value); return query; },
      neq: (key: string, value: unknown) => { rows = rows.filter((r) => r[key] !== value); return query; },
      in: (key: string, values: unknown[]) => { rows = rows.filter((r) => values.includes(r[key])); return query; },
      is: (key: string, value: unknown) => { rows = rows.filter((r) => (r[key] ?? null) === value); return query; },
      ilike: (key: string, value: string) => {
        const pattern = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
        rows = rows.filter((r) => new RegExp(`^${pattern}$`, "i").test(r[key] ?? "")); return query;
      },
      order: () => query,
      limit: (n: number) => { rows = rows.slice(0, n); return query; },
      range: (from: number, to: number) => { rows = rows.slice(from, to + 1); return query; },
      then: (resolve: (value: unknown) => void) => resolve({ data: rows, error: db.failure === table ? { message: "database unavailable" } : null }),
    };
    return query;
  } }),
}));

beforeEach(() => {
  db.tables = {
    order_master: [{ order_id: "o1", order_name: "#KP123456", order_total: 100 }],
    shipments: [{ id: "s1", order_id: "o1", order_name: "#KP123456", guide_code: "GF001", output_code: "KP123456-S1", qr_token: "d692eb02-0d6b-4612-819d-a618841f07f9" }],
    delivery_stops: [{ id: "stop1", route_id: "old", order_id: "o1", status: "pendiente" }],
    dispatch_manifest_items: [{ id: "item1", manifest_id: "m1", shipment_id: "s1", removed_at: null, pickup_declined_at: null }],
    dispatch_manifests: [{ id: "m1", delivery_route_id: "new", courier: "propio", state: "draft" }],
  };
  db.calls = []; db.allowed = true; db.user = true; db.failure = "";
});

describe("buscar el pedido en todas sus rutas con RLS", () => {
  it.each(["#kp123456", "123456", "GF001", "KP123456-S1", "https://kapta.test/p?qr=d692eb02-0d6b-4612-819d-a618841f07f9"])("encuentra por %s tanto paradas históricas como cajas aún sin paradas", async (code) => {
    expect(await findCourierRouteMatches(code)).toEqual({ ordersByRoute: { old: ["#KP123456"], new: ["#KP123456"] }, limited: false });
  });
  it("no duplica un pedido que coincide en parada y caja", async () => {
    db.tables.dispatch_manifests![0]!.delivery_route_id = "old";
    expect((await findCourierRouteMatches("KP123456")).ordersByRoute).toEqual({ old: ["#KP123456"] });
  });
  it.each(["removed_at", "pickup_declined_at"])("excluye la caja cuando el ítem tiene %s", async (field) => {
    db.tables.dispatch_manifest_items![0]![field] = "2026-10-01";
    expect((await findCourierRouteMatches("KP123456")).ordersByRoute).toEqual({ old: ["#KP123456"] });
  });
  it("excluye cajas canceladas y no inventa una ruta para un pedido sin asignar", async () => {
    db.tables.delivery_stops = [];
    db.tables.dispatch_manifests![0]!.state = "cancelled";
    expect((await findCourierRouteMatches("KP123456")).ordersByRoute).toEqual({});
  });
  it("recupera coincidencias después de una página completa de paradas", async () => {
    db.tables.delivery_stops = Array.from({ length: 501 }, (_, i) => ({ id: `stop${i}`, route_id: `r${i}`, order_id: "o1" }));
    expect((await findCourierRouteMatches("KP123456")).ordersByRoute.r500).toEqual(["#KP123456"]);
  });
  it("pide precisar un fragmento demasiado amplio sin mostrar una muestra incompleta", async () => {
    db.tables.order_master = Array.from({ length: 31 }, (_, i) => ({ order_id: `o${i}`, order_name: `KP123${i}` }));
    expect(await findCourierRouteMatches("KP123")).toEqual({ ordersByRoute: {}, limited: true });
    expect(db.calls).not.toContain("delivery_stops");
  });
  it("no convierte un error de lectura en ningún resultado", async () => {
    db.failure = "delivery_stops";
    await expect(findCourierRouteMatches("KP123456")).rejects.toThrow("database unavailable");
  });
  it("normaliza QR y protege comodines sin interpolar un filtro OR", () => {
    expect(courierSearchCode("  #KP123456  ")).toBe("KP123456");
    expect(courierCodePattern("%_\\")).toBe("\\%\\_\\\\");
  });
  it("rechaza búsquedas vacías o excesivas antes de consultar", async () => {
    await expect(findCourierRouteMatches("a")).rejects.toThrow("3 y 200");
    await expect(findCourierRouteMatches("a".repeat(201))).rejects.toThrow("3 y 200");
    expect(db.calls).toEqual([]);
  });
  it("no consulta datos sin sesión ni permiso", async () => {
    db.allowed = false;
    expect(await searchCourierRoutes({ code: "KP123456" })).toHaveProperty("error");
    db.allowed = true; db.user = false;
    expect(await searchCourierRoutes({ openOnly: true })).toHaveProperty("error");
    expect(db.calls).toEqual([]);
  });
});

describe("Solo abiertas", () => {
  it.each([
    ["planificada", null, true], ["en_curso", null, true], ["en_curso", "borrador", true],
    ["cerrada", null, false], ["cerrada", "borrador", false], ["en_curso", "pagada", false],
  ])("estado %s y liquidación %s → abierta %s", (routeStatus, settlementStatus, expected) => {
    expect(ledgerIsOpen({ routeStatus: routeStatus as string, settlementStatus: settlementStatus as string | null, manifestState: null })).toBe(expected);
  });
  it("incluye una ruta abierta anterior a las últimas 150 y a la página de 500", async () => {
    db.tables.delivery_routes = Array.from({ length: 501 }, (_, i) => ({ id: `r${i}`, rider_id: "roy", route_date: "2026-08-01", status: "en_curso", settlement_id: null }));
    db.tables.delivery_stops = db.tables.delivery_routes.map((r, i) => ({ id: `stop${i}`, route_id: r.id, order_id: "o1", status: "pendiente" }));
    expect(await getCourierRouteLedger({ openOnly: true })).toHaveLength(501);
  });
  it("elimina liquidadas aunque la ruta siga en curso", async () => {
    db.tables.delivery_routes = [{ id: "old", rider_id: "roy", route_date: "2026-08-01", status: "en_curso", settlement_id: "paid" }];
    db.tables.rider_settlements = [{ id: "paid", status: "pagada" }];
    expect(await getCourierRouteLedger({ openOnly: true })).toEqual([]);
  });
});
