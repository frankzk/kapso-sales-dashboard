import { describe, expect, it } from "vitest";
import { fillUrpiSalidas, planUrpiSalida, urpiSalidaRow, type UrpiSalidaCandidate } from "@/lib/urpi-salida";

const tbd = (over: Partial<UrpiSalidaCandidate> = {}): UrpiSalidaCandidate => ({
  id: "s1", courier: "por_definir", created_via: "mom_manual_route", delivery_status: "pendiente", custody_state: "empresa",
  custody_transferred_at: null, returned_at: null, output_number: 1, ...over,
});

describe("qué salida se lleva la entrega de Urpi", () => {
  it("la única caja viva «por definir» es la de Urpi", () => {
    expect(planUrpiSalida([tbd()])).toMatchObject({ kind: "rellenar", salida: { id: "s1" } });
  });
  it("lo ya anulado o devuelto no estorba", () => {
    expect(planUrpiSalida([tbd(), tbd({ id: "s0", courier: "fenix", delivery_status: "anulado", custody_state: "retorno" })]).kind).toBe("rellenar");
  });
  it("con otra salida viva no se sabe qué caja se llevó Urpi: no se toca", () => {
    expect(planUrpiSalida([tbd(), tbd({ id: "s2", courier: "fenix", created_via: "fenix", delivery_status: "transferido" })]).kind).toBe("rellenar");
    expect(planUrpiSalida([tbd(), tbd({ id: "s2", courier: "tanders", created_via: "tanders", delivery_status: "en_ruta" })]).kind).toBe("otra_salida_viva");
    expect(planUrpiSalida([tbd(), tbd({ id: "s2", output_number: 2 })]).kind).toBe("otra_salida_viva");
  });
  it("una «por definir» que ya cambió de custodia no se rellena", () => {
    expect(planUrpiSalida([tbd({ custody_transferred_at: "2026-10-01T10:00:00Z", custody_state: "courier" })]).kind).toBe("otra_salida_viva");
  });
  it("sin salida no se inventa una; si ya es de Urpi, nada que hacer", () => {
    expect(planUrpiSalida([]).kind).toBe("sin_salida");
    expect(planUrpiSalida([tbd({ courier: "urpi", delivery_status: "entregado" })]).kind).toBe("ya_es_urpi");
  });
  it("la fila: courier Urpi, entregada, con su origen y el día del primer intento", () => {
    expect(urpiSalidaRow("#KP136785", "5f7bd799-0000-4000-8000-000000000000", "2026-09-26")).toEqual({
      courier: "urpi", created_via: "urpi_report", guide_code: "MOM-KP136785-URPI-5F7BD799", delivery_status: "entregado",
      status_category: "delivered", delivered_source: "urpi_report", dispatched_at: "2026-09-26T17:00:00.000Z",
    });
    expect(urpiSalidaRow(null, "5f7bd799-0000-4000-8000-000000000000", null)).not.toHaveProperty("dispatched_at");
  });
});

// Doble mínimo de Supabase para el UPDATE condicionado de writeCourierGuide.
function fakeAdmin(shipments: Record<string, any>[]) {
  const events: any[] = [];
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = [];
    let patch: any = null, insert: any = null, single = false;
    const q: any = {
      select: () => q,
      eq: (k: string, v: any) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, vs: any[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      is: (k: string, v: any) => { filters.push((r) => (r[k] ?? null) === v); return q; },
      update: (p: any) => { patch = p; return q; },
      insert: (row: any) => { insert = row; return q; },
      maybeSingle: () => { single = true; return q; },
      then: (resolve: any) => {
        if (insert) { events.push(insert); return Promise.resolve({ data: null, error: null }).then(resolve); }
        const rows = (table === "shipments" ? shipments : []).filter((r) => filters.every((f) => f(r)));
        if (patch) rows.forEach((r) => Object.assign(r, patch));
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
      },
    };
    return q;
  };
  return { admin: { from } as any, events };
}

describe("rellenar la salida en la base", () => {
  it("escribe Urpi entregada sobre la caja y deja el rastro del relleno; lo demás se cuenta", async () => {
    const shipments = [
      { ...tbd({ id: "aaaaaaaa-0000-4000-8000-000000000001" }), order_id: "o1", store_id: "kenku", output_code: "KP1-S01" },
      { ...tbd({ id: "bbbbbbbb-0000-4000-8000-000000000002", courier: "tanders", created_via: "tanders", delivery_status: "en_ruta" }), order_id: "o2", store_id: "kenku" },
    ];
    const { admin, events } = fakeAdmin(shipments);
    const result = await fillUrpiSalidas(admin, [
      { orderId: "o1", orderName: "#KP1", dispatchedOn: "2026-10-01" },
      { orderId: "o2", orderName: "#KP2", dispatchedOn: "2026-10-01" },
      { orderId: "o3", orderName: "#KP3", dispatchedOn: "2026-10-01" },
    ]);
    expect(result).toEqual({ filled: ["o1"], sinSalida: ["o3"], otraSalidaViva: ["o2"], errors: [] });
    expect(shipments[0]).toMatchObject({ courier: "urpi", created_via: "urpi_report", delivery_status: "entregado", delivered_source: "urpi_report", output_code: "KP1-S01", custody_state: "empresa", output_number: 1 });
    expect(shipments[1]).toMatchObject({ courier: "tanders", delivery_status: "en_ruta" });
    expect(events).toEqual([expect.objectContaining({ kind: "route_output_filled", order_id: "o1", courier: "urpi", shipment_id: "aaaaaaaa-0000-4000-8000-000000000001" })]);
  });
  it("si entre la lectura y la escritura la caja cambió, no crea otra", async () => {
    const shipments = [{ ...tbd({ id: "aaaaaaaa-0000-4000-8000-000000000001" }), order_id: "o1", store_id: "kenku" }];
    const { admin } = fakeAdmin(shipments);
    // Simula la carrera: el UPDATE ya no encuentra la fila «por definir».
    const original = admin.from;
    let reads = 0;
    admin.from = (table: string) => { const q = original(table); if (table === "shipments" && ++reads === 2) shipments[0]!.courier = "tanders"; return q; };
    const result = await fillUrpiSalidas(admin, [{ orderId: "o1", orderName: "#KP1", dispatchedOn: null }]);
    expect(result.filled).toEqual([]);
    expect(result.errors).toEqual(["o1"]);
    expect(shipments).toHaveLength(1);
  });
});
