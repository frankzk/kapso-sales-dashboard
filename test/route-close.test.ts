import { describe, expect, it } from "vitest";
import { loadRouteCloseContext } from "@/lib/route-close";

/**
 * `loadRouteCloseContext` alimenta a la vez el cierre (closeRoute) y el panel
 * «Para terminar la ruta». Se prueba contra un cliente falso que devuelve lo
 * que devolvería la base y apunta cada filtro pedido: qué cargas cuentan, qué
 * paquetes, y que un error de lectura NO se confunda con «no hay cargas».
 */
type Result = { data: unknown[] | null; error: { message: string } | null };

function fakeAdmin(results: Record<string, Result>) {
  const calls: string[] = [];
  const from = (table: string) => {
    const chain = {
      select: (cols: string) => { calls.push(`${table}.select(${cols})`); return chain; },
      eq: (col: string, value: unknown) => { calls.push(`${table}.eq(${col},${String(value)})`); return chain; },
      neq: (col: string, value: unknown) => { calls.push(`${table}.neq(${col},${String(value)})`); return chain; },
      in: (col: string, values: unknown[]) => { calls.push(`${table}.in(${col},${values.join("|")})`); return chain; },
      is: (col: string, value: unknown) => { calls.push(`${table}.is(${col},${String(value)})`); return chain; },
      then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve, reject),
    };
    return chain;
  };
  return { admin: { from } as unknown as Parameters<typeof loadRouteCloseContext>[0], calls };
}

describe("las cargas de Grupo GF de una ruta, para cerrarla", () => {
  it("pide solo las cargas propias y vivas de ESA ruta", async () => {
    const { admin, calls } = fakeAdmin({ dispatch_manifests: { data: [], error: null } });
    await loadRouteCloseContext(admin, "r1");
    expect(calls).toContain("dispatch_manifests.eq(delivery_route_id,r1)");
    expect(calls).toContain("dispatch_manifests.eq(courier,propio)");
    expect(calls).toContain("dispatch_manifests.neq(state,cancelled)");
  });

  it("sin cargas no es de Grupo GF y no pregunta por paquetes", async () => {
    const { admin, calls } = fakeAdmin({ dispatch_manifests: { data: [], error: null } });
    expect(await loadRouteCloseContext(admin, "r1")).toEqual({ isGf: false, openLoads: [] });
    expect(calls.some((c) => c.startsWith("dispatch_manifest_items"))).toBe(false);
  });

  it("una carga en custodia hace la ruta de Grupo GF pero no la frena", async () => {
    const { admin, calls } = fakeAdmin({ dispatch_manifests: { data: [{ id: "m1", state: "in_custody", load_number: 1 }], error: null } });
    expect(await loadRouteCloseContext(admin, "r1")).toEqual({ isGf: true, openLoads: [] });
    expect(calls.some((c) => c.startsWith("dispatch_manifest_items"))).toBe(false);
  });

  it("las abiertas salen con sus paquetes activos, en orden de carga", async () => {
    const { admin, calls } = fakeAdmin({
      dispatch_manifests: {
        data: [
          { id: "m3", state: "office_check", load_number: 3 },
          { id: "m1", state: "in_custody", load_number: 1 },
          { id: "m2", state: "ready_for_pickup", load_number: 2 },
        ],
        error: null,
      },
      dispatch_manifest_items: { data: [{ manifest_id: "m2" }, { manifest_id: "m2" }, { manifest_id: "m2" }], error: null },
    });
    expect(await loadRouteCloseContext(admin, "r1")).toEqual({
      isGf: true,
      openLoads: [
        { id: "m2", load_number: 2, state: "ready_for_pickup", items: 3 },
        { id: "m3", load_number: 3, state: "office_check", items: 0 },
      ],
    });
    // Solo los paquetes de las abiertas, y solo los que no se retiraron.
    expect(calls).toContain("dispatch_manifest_items.in(manifest_id,m3|m2)");
    expect(calls).toContain("dispatch_manifest_items.is(removed_at,null)");
  });

  it("una carga sin número cuenta como la 1", async () => {
    const { admin } = fakeAdmin({ dispatch_manifests: { data: [{ id: "m1", state: "draft", load_number: null }], error: null } });
    expect((await loadRouteCloseContext(admin, "r1"))?.openLoads).toEqual([{ id: "m1", load_number: 1, state: "draft", items: 0 }]);
  });

  it("no poder leer las cargas o sus paquetes es «no lo sé», nunca «no hay»", async () => {
    const cargas = fakeAdmin({ dispatch_manifests: { data: null, error: { message: "timeout" } } });
    expect(await loadRouteCloseContext(cargas.admin, "r1")).toBeNull();
    const paquetes = fakeAdmin({
      dispatch_manifests: { data: [{ id: "m1", state: "office_check", load_number: 1 }], error: null },
      dispatch_manifest_items: { data: null, error: { message: "timeout" } },
    });
    expect(await loadRouteCloseContext(paquetes.admin, "r1")).toBeNull();
  });
});
