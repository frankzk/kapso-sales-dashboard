import { describe, expect, it } from "vitest";
import { cancelUrpiSalidas, fillUrpiSalidas, planUrpiCancel, planUrpiSalida, urpiSalidaCancelRow, urpiSalidaCloseRow, urpiSalidaPending, urpiSalidaRow, type UrpiSalidaCandidate } from "@/lib/urpi-salida";

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
  it("si la programación ya la dejó como salida de Urpi en ruta, se cierra esa, aunque haya otra viva (03-11-2026)", () => {
    const enRuta = tbd({ id: "u1", courier: "urpi", created_via: "urpi_programacion", delivery_status: "en_ruta" });
    expect(planUrpiSalida([enRuta])).toMatchObject({ kind: "cerrar", salida: { id: "u1" } });
    expect(planUrpiSalida([enRuta, tbd({ id: "g1", courier: "propio", created_via: "grupo_gf_courier", custody_state: "courier" })])).toMatchObject({ kind: "cerrar", salida: { id: "u1" } });
    expect(urpiSalidaPending(planUrpiSalida([enRuta]))).toBe(true);
    expect(urpiSalidaPending(planUrpiSalida([tbd({ courier: "urpi", delivery_status: "entregado" })]))).toBe(false);
    expect(urpiSalidaCloseRow("2026-11-02")).toEqual({ delivery_status: "entregado", status_category: "delivered", delivered_source: "urpi_report", closed_at: "2026-11-02T17:00:00.000Z" });
    expect(urpiSalidaCloseRow(null)).not.toHaveProperty("closed_at");
  });
  it("Urpi la canceló y después la entregó: se cierra la misma salida, salvo que otra caja viva deje la duda", () => {
    const failed = tbd({ id: "u1", courier: "urpi", created_via: "urpi_programacion", delivery_status: "anulado", dispatched_at: "2026-10-29T17:00:00.000Z" });
    expect(planUrpiSalida([failed])).toMatchObject({ kind: "cerrar", salida: { id: "u1" } });
    expect(planUrpiSalida([failed, tbd({ id: "g1", courier: "propio", created_via: "grupo_gf_courier", custody_state: "courier" })]).kind).toBe("otra_salida_viva");
    // Anulada sin haber salido no es un intento de Urpi.
    expect(planUrpiSalida([tbd({ id: "u2", courier: "urpi", delivery_status: "anulado" })]).kind).toBe("sin_salida");
  });
  it("la fila: courier Urpi, entregada, con su origen, el día del primer intento y el de la entrega", () => {
    expect(urpiSalidaRow("#KP136785", "5f7bd799-0000-4000-8000-000000000000", "2026-09-26", "2026-09-29")).toEqual({
      courier: "urpi", created_via: "urpi_report", guide_code: "MOM-KP136785-URPI-5F7BD799", delivery_status: "entregado",
      status_category: "delivered", delivered_source: "urpi_report", dispatched_at: "2026-09-26T17:00:00.000Z",
      closed_at: "2026-09-29T17:00:00.000Z",
    });
    const sinFechas = urpiSalidaRow(null, "5f7bd799-0000-4000-8000-000000000000", null, null);
    expect(sinFechas).not.toHaveProperty("dispatched_at");
    expect(sinFechas).not.toHaveProperty("closed_at");
  });
  it("closed_at es el día de la entrega, a la misma hora que el evento del Master; sin ese día no se escribe", () => {
    // Antes no se escribía y el Master tomaba el día del relleno (MOM §30.11).
    expect(urpiSalidaRow("#KP1", "aaaaaaaa-0000-4000-8000-000000000001", "2026-08-10", "2026-08-10")).toMatchObject({
      dispatched_at: "2026-08-10T17:00:00.000Z", closed_at: "2026-08-10T17:00:00.000Z",
    });
    const sinEntrega = urpiSalidaRow("#KP1", "aaaaaaaa-0000-4000-8000-000000000001", "2026-08-10", null);
    expect(sinEntrega).toMatchObject({ dispatched_at: "2026-08-10T17:00:00.000Z", delivery_status: "entregado" });
    expect(sinEntrega).not.toHaveProperty("closed_at");
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
      { orderId: "o1", orderName: "#KP1", dispatchedOn: "2026-10-01", deliveredOn: "2026-10-03" },
      { orderId: "o2", orderName: "#KP2", dispatchedOn: "2026-10-01", deliveredOn: "2026-10-01" },
      { orderId: "o3", orderName: "#KP3", dispatchedOn: "2026-10-01", deliveredOn: "2026-10-01" },
    ]);
    expect(result).toEqual({ filled: ["o1"], closed: [], sinSalida: ["o3"], otraSalidaViva: ["o2"], errors: [] });
    expect(shipments[0]).toMatchObject({
      courier: "urpi", created_via: "urpi_report", delivery_status: "entregado", delivered_source: "urpi_report", output_code: "KP1-S01", custody_state: "empresa", output_number: 1,
      dispatched_at: "2026-10-01T17:00:00.000Z", closed_at: "2026-10-03T17:00:00.000Z",
    });
    expect(shipments[1]).toMatchObject({ courier: "tanders", delivery_status: "en_ruta" });
    expect(events).toEqual([expect.objectContaining({ kind: "route_output_filled", order_id: "o1", courier: "urpi", shipment_id: "aaaaaaaa-0000-4000-8000-000000000001" })]);
  });
  it("cierra la salida de Urpi en ruta sin tocar courier, guía ni despacho, y deja su estado en el historial", async () => {
    const shipments = [{ ...tbd({ id: "cccccccc-0000-4000-8000-000000000003", courier: "urpi", created_via: "urpi_programacion", delivery_status: "en_ruta" }),
      order_id: "o1", store_id: "kenku", guide_code: "MOM-KP1-URPI-CCCCCCCC", dispatched_at: "2026-11-02T17:00:00.000Z" }];
    const { admin, events } = fakeAdmin(shipments);
    const result = await fillUrpiSalidas(admin, [{ orderId: "o1", orderName: "#KP1", dispatchedOn: "2026-11-02", deliveredOn: "2026-11-03" }]);
    expect(result).toEqual({ filled: [], closed: ["o1"], sinSalida: [], otraSalidaViva: [], errors: [] });
    expect(shipments[0]).toMatchObject({ courier: "urpi", created_via: "urpi_programacion", guide_code: "MOM-KP1-URPI-CCCCCCCC", delivery_status: "entregado",
      delivered_source: "urpi_report", dispatched_at: "2026-11-02T17:00:00.000Z", closed_at: "2026-11-03T17:00:00.000Z" });
    expect(events).toEqual([expect.objectContaining({ kind: "courier_status", order_id: "o1", courier: "urpi", shipment_id: "cccccccc-0000-4000-8000-000000000003",
      previous_status: "en_ruta", new_status: "entregado", occurred_at: "2026-11-03T17:00:00.000Z" })]);
  });
  it("si entre la lectura y la escritura la caja cambió, no crea otra", async () => {
    const shipments = [{ ...tbd({ id: "aaaaaaaa-0000-4000-8000-000000000001" }), order_id: "o1", store_id: "kenku" }];
    const { admin } = fakeAdmin(shipments);
    // Simula la carrera: el UPDATE ya no encuentra la fila «por definir».
    const original = admin.from;
    let reads = 0;
    admin.from = (table: string) => { const q = original(table); if (table === "shipments" && ++reads === 2) shipments[0]!.courier = "tanders"; return q; };
    const result = await fillUrpiSalidas(admin, [{ orderId: "o1", orderName: "#KP1", dispatchedOn: null, deliveredOn: null }]);
    expect(result.filled).toEqual([]);
    expect(result.errors).toEqual(["o1"]);
    expect(shipments).toHaveLength(1);
  });
});

describe("el cancelado de Urpi anula su salida en ruta (03-11-2026, MOM §30.11 y §9 v1.23)", () => {
  const enRuta = (over: Partial<UrpiSalidaCandidate> = {}) => tbd({ id: "u1", courier: "urpi", created_via: "urpi_programacion", delivery_status: "en_ruta", dispatched_at: "2026-11-02T17:00:00.000Z", ...over });
  it("la salida de Urpi en ruta que salió a más tardar ese día; una despachada después es otro intento", () => {
    expect(planUrpiCancel([enRuta()], "2026-11-02")).toMatchObject({ kind: "anular", salida: { id: "u1" } });
    expect(planUrpiCancel([enRuta()], "2026-11-03").kind).toBe("anular");
    expect(planUrpiCancel([enRuta()], "2026-11-01").kind).toBe("posterior");
    expect(planUrpiCancel([tbd()], "2026-11-02").kind).toBe("sin_salida_urpi");
    expect(planUrpiCancel([enRuta({ delivery_status: "entregado" })], "2026-11-02").kind).toBe("sin_salida_urpi");
  });
  it("la fila: anulada, cerrada el día del reporte a mediodía de Lima", () => {
    expect(urpiSalidaCancelRow("2026-11-02")).toEqual({ delivery_status: "anulado", status_category: "closed", closed_at: "2026-11-02T17:00:00.000Z" });
  });
  it("en la base: anula, conserva courier, guía y despacho, y deja el motivo de Urpi en el historial", async () => {
    const shipments = [{ ...enRuta({ id: "dddddddd-0000-4000-8000-000000000004" }), order_id: "o1", store_id: "kenku", guide_code: "MOM-KP1-URPI-DDDDDDDD" },
      { ...tbd({ id: "eeeeeeee-0000-4000-8000-000000000005" }), order_id: "o2", store_id: "kenku" }];
    const { admin, events } = fakeAdmin(shipments);
    const result = await cancelUrpiSalidas(admin, [{ orderId: "o1", cancelledOn: "2026-11-02", reason: "No contesta" }, { orderId: "o2", cancelledOn: "2026-11-02", reason: null }]);
    expect(result).toEqual({ cancelled: ["o1"], errors: [] });
    expect(shipments[0]).toMatchObject({ courier: "urpi", guide_code: "MOM-KP1-URPI-DDDDDDDD", delivery_status: "anulado", status_category: "closed",
      dispatched_at: "2026-11-02T17:00:00.000Z", closed_at: "2026-11-02T17:00:00.000Z" });
    expect(shipments[1]).toMatchObject({ courier: "por_definir", delivery_status: "pendiente" });
    expect(events).toEqual([expect.objectContaining({ kind: "courier_status", order_id: "o1", courier: "urpi", previous_status: "en_ruta", new_status: "anulado",
      reason: "No contesta", occurred_at: "2026-11-02T17:00:00.000Z" })]);
  });
});
