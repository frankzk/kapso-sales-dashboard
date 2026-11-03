import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { dueUrpiDispatches, planUrpiDispatch, registerUrpiDispatches, urpiDispatchMessage, urpiDispatchRow, type UrpiDispatchCandidate } from "@/lib/urpi-dispatch";

vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn(async () => undefined) }));

// MOM §30.10, decisión del owner del 03-11-2026: la programación enviada a Urpi
// registra el despacho rellenando la caja «por definir» como salida de Urpi en
// ruta. Auditoría del 26/10 al 02/11: 85 de 101 pedidos programados no tenían
// salida de Urpi en Kapta.

const box = (over: Partial<UrpiDispatchCandidate> = {}): UrpiDispatchCandidate => ({
  id: "s1", courier: "por_definir", created_via: "mom_manual_route", delivery_status: "pendiente", custody_state: "empresa",
  custody_transferred_at: null, returned_at: null, output_number: 1, created_at: "2026-10-30T15:00:00Z", dispatched_at: null, closed_at: null, ...over,
});
const open = { general_status: "en_proceso", cancelled_at: null };

describe("qué caja se registra como despacho a Urpi", () => {
  it("la única caja viva «por definir», que ya existía el día programado", () => {
    expect(planUrpiDispatch(open, [box()], "2026-11-02")).toMatchObject({ kind: "rellenar", salida: { id: "s1" } });
    expect(planUrpiDispatch(open, [box({ created_at: "2026-11-02T23:00:00Z" })], "2026-11-02").kind).toBe("rellenar");
  });
  it("una caja creada después del día programado no es la que se llevó Urpi", () => {
    expect(planUrpiDispatch(open, [box({ created_at: "2026-11-03T15:00:00Z" })], "2026-11-02").kind).toBe("sin_salida");
  });
  it("con otra salida viva —un motorizado de Grupo GF, Fénix, otra «por definir»— no se toca", () => {
    const gf = box({ id: "g1", courier: "propio", created_via: "grupo_gf_courier", custody_state: "courier", custody_transferred_at: "2026-10-23T12:00:00Z" });
    expect(planUrpiDispatch(open, [box(), gf], "2026-11-02").kind).toBe("otra_salida_viva");
    expect(planUrpiDispatch(open, [gf], "2026-11-02").kind).toBe("otra_salida_viva");
    expect(planUrpiDispatch(open, [box(), box({ id: "s2", output_number: 2 })], "2026-11-02").kind).toBe("otra_salida_viva");
    expect(planUrpiDispatch(open, [box(), box({ id: "t1", courier: "tanders", created_via: "tanders_api", delivery_status: "anulado" })], "2026-11-02").kind).toBe("rellenar");
  });
  it("sin caja no se inventa una; si ya hay salida de Urpi, un reintento no la toca", () => {
    expect(planUrpiDispatch(open, [], "2026-11-02").kind).toBe("sin_salida");
    expect(planUrpiDispatch(open, [box({ courier: "urpi", created_via: "urpi_programacion", delivery_status: "en_ruta" })], "2026-11-02").kind).toBe("ya_es_urpi");
    expect(planUrpiDispatch(open, [box({ courier: "urpi", created_via: "urpi_report", delivery_status: "entregado" })], "2026-11-02").kind).toBe("ya_es_urpi");
  });
  it("si Urpi ya canceló una salida: esa programación queda como está; una posterior es un reenvío que se nombra (§9.1)", () => {
    const failed = box({ id: "u1", courier: "urpi", created_via: "urpi_programacion", delivery_status: "anulado",
      dispatched_at: "2026-10-29T17:00:00.000Z", closed_at: "2026-10-30T17:00:00.000Z" });
    expect(planUrpiDispatch(open, [failed], "2026-10-29").kind).toBe("ya_es_urpi");
    expect(planUrpiDispatch(open, [failed], "2026-10-30").kind).toBe("ya_es_urpi");
    expect(planUrpiDispatch(open, [failed], "2026-10-31").kind).toBe("reenvio_tras_cancelado");
    expect(planUrpiDispatch(open, [failed, box({ id: "s9", created_at: "2026-10-31T10:00:00Z" })], "2026-11-02").kind).toBe("reenvio_tras_cancelado");
    // Una de Urpi anulada sin haber salido no es un cancelado de Urpi.
    expect(planUrpiDispatch(open, [box({ courier: "urpi", delivery_status: "anulado", dispatched_at: null }), box({ id: "s2" })], "2026-11-02").kind).toBe("rellenar");
  });
  it("un pedido cerrado o anulado en Shopify no se toca", () => {
    for (const general_status of ["entregado", "anulado", "devuelto"]) expect(planUrpiDispatch({ general_status, cancelled_at: null }, [box()], "2026-11-02").kind).toBe("cerrado");
    expect(planUrpiDispatch({ general_status: "en_proceso", cancelled_at: "2026-11-02T14:52:00Z" }, [box()], "2026-11-02").kind).toBe("cerrado");
  });
  it("la fila: courier Urpi en ruta, despachada el día programado a mediodía de Lima, con su origen", () => {
    expect(urpiDispatchRow("#KP201646", "5f7bd799-0000-4000-8000-000000000000", "2026-11-02")).toEqual({
      courier: "urpi", created_via: "urpi_programacion", guide_code: "MOM-KP201646-URPI-5F7BD799", delivery_status: "en_ruta",
      status_category: "in_route", dispatched_at: "2026-11-02T17:00:00.000Z",
    });
  });
  it("por pedido cuenta el último día programado que ya llegó; lo futuro y lo sin pedido esperan", () => {
    const due = dueUrpiDispatches([
      { orderId: "a", date: "2026-10-28" }, { orderId: "a", date: "2026-10-29" }, { orderId: "a", date: "2026-11-04" },
      { orderId: "b", date: "2026-11-03" }, { orderId: null, date: "2026-11-02" }, { orderId: "c", date: "03/11" },
    ], "2026-11-03");
    expect([...due]).toEqual([["a", "2026-10-29"], ["b", "2026-11-03"]]);
  });
});

// Doble mínimo de Supabase: lecturas por `in`, y el UPDATE condicionado de
// writeCourierGuide sobre `shipments`.
function fakeAdmin(master: Record<string, any>[], shipments: Record<string, any>[], reportRows: Record<string, any>[] = []) {
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
        const source = table === "shipments" ? shipments : table === "order_master" ? master : table === "urpi_report_rows" ? reportRows : [];
        const rows = source.filter((r) => filters.every((f) => f(r)));
        if (patch) rows.forEach((r) => Object.assign(r, patch));
        return Promise.resolve({ data: single ? rows[0] ?? null : rows.map((r) => ({ ...r })), error: null }).then(resolve);
      },
    };
    return q;
  };
  return { admin: { from } as any, events };
}

describe("registrar los despachos de una programación cargada", () => {
  it("rellena la caja, deja el rastro y cuenta lo que queda para revisar", async () => {
    const order = (id: string, name: string, over: Record<string, any> = {}) => ({ order_id: id, order_name: name, general_status: "en_proceso", orders: { cancelled_at: null }, ...over });
    const master = [order("o1", "#KP1"), order("o2", "#KP2"), order("o3", "#KP3"), order("o4", "#KP4", { general_status: "entregado" })];
    const shipments = [
      { ...box({ id: "aaaaaaaa-0000-4000-8000-000000000001" }), order_id: "o1", store_id: "kenku", output_code: "KP1-S01" },
      { ...box({ id: "bbbbbbbb-0000-4000-8000-000000000002", courier: "propio", created_via: "grupo_gf_courier", custody_state: "courier" }), order_id: "o2", store_id: "kenku" },
    ];
    const { admin, events } = fakeAdmin(master, shipments);
    const result = await registerUrpiDispatches(admin, [
      { orderId: "o1", orderCode: "KP1", date: "2026-11-02" }, { orderId: "o2", orderCode: "KP2", date: "2026-11-02" },
      { orderId: "o3", orderCode: "KP3", date: "2026-11-02" }, { orderId: "o4", orderCode: "KP4", date: "2026-11-02" },
      { orderId: "o5", orderCode: "KP5", date: "2026-11-09" },
    ], "2026-11-03");
    expect(result).toEqual({ filled: ["#KP1"], alreadyUrpi: 0, closed: 1, sinSalida: ["#KP3"], otraSalidaViva: ["#KP2"], reenvioTrasCancelado: [], cancelled: [], errors: [] });
    expect(shipments[0]).toMatchObject({ courier: "urpi", created_via: "urpi_programacion", delivery_status: "en_ruta", dispatched_at: "2026-11-02T17:00:00.000Z",
      output_code: "KP1-S01", custody_state: "empresa", output_number: 1 });
    expect(shipments[1]).toMatchObject({ courier: "propio", delivery_status: "pendiente" });
    expect(events).toEqual([expect.objectContaining({ kind: "route_output_filled", order_id: "o1", courier: "urpi", shipment_id: "aaaaaaaa-0000-4000-8000-000000000001" })]);
    expect(urpiDispatchMessage(result)).toBe("Despachos a Urpi: 1 salida(s) «Por definir» pasaron a Urpi en ruta; 1 con otra salida viva, revísalos a mano (#KP2); 1 sin caja «Por definir» del día que pasar a Urpi (#KP3).");
  });
  it("si el reporte ya dice que Urpi canceló ese despacho, la salida pasa a intento fallido en el acto", async () => {
    const master = [{ order_id: "o1", order_name: "#KP1", store_id: "kenku", general_status: "en_proceso", orders: { cancelled_at: null } }];
    const shipments = [{ ...box({ id: "aaaaaaaa-0000-4000-8000-000000000001" }), order_id: "o1", store_id: "kenku", output_code: "KP1-S01", guide_code: null }];
    const report = [{ urpi_row: 7, order_id: "o1", result_code: "cancelado", report_date: "2026-11-02", reason: "No contesta" }];
    const { admin, events } = fakeAdmin(master, shipments, report);
    const result = await registerUrpiDispatches(admin, [{ orderId: "o1", orderCode: "KP1", date: "2026-11-02" }], "2026-11-03");
    expect(result).toMatchObject({ filled: ["#KP1"], cancelled: ["#KP1"] });
    expect(shipments[0]).toMatchObject({ courier: "urpi", delivery_status: "anulado", status_category: "closed", dispatched_at: "2026-11-02T17:00:00.000Z", closed_at: "2026-11-02T17:00:00.000Z" });
    expect(events.map((e) => e.kind)).toEqual(["route_output_filled", "courier_status"]);
    expect(events[1]).toMatchObject({ previous_status: "en_ruta", new_status: "anulado", reason: "No contesta" });
    expect(urpiDispatchMessage(result)).toBe("Despachos a Urpi: 1 salida(s) «Por definir» pasaron a Urpi en ruta; 1 ya cancelado(s) por Urpi pasaron a «Por reprogramar Lima».");
  });
  it("un cancelado de un despacho anterior no anula la salida del nuevo", async () => {
    const master = [{ order_id: "o1", order_name: "#KP1", store_id: "kenku", general_status: "en_proceso", orders: { cancelled_at: null } }];
    const shipments = [{ ...box({ id: "aaaaaaaa-0000-4000-8000-000000000001" }), order_id: "o1", store_id: "kenku", output_code: "KP1-S01", guide_code: null }];
    const report = [{ urpi_row: 7, order_id: "o1", result_code: "cancelado", report_date: "2026-10-31", reason: null }];
    const { admin } = fakeAdmin(master, shipments, report);
    const result = await registerUrpiDispatches(admin, [{ orderId: "o1", orderCode: "KP1", date: "2026-11-02" }], "2026-11-03");
    expect(result).toMatchObject({ filled: ["#KP1"], cancelled: [] });
    expect(shipments[0]).toMatchObject({ courier: "urpi", delivery_status: "en_ruta" });
  });
  it("sin nada nuevo no dice nada; las listas largas se recortan", () => {
    const empty = { filled: [], alreadyUrpi: 30, closed: 4, sinSalida: [], otraSalidaViva: [], reenvioTrasCancelado: [], cancelled: [], errors: [] };
    expect(urpiDispatchMessage(empty)).toBe("");
    const many = Array.from({ length: 12 }, (_, i) => `#KP${i}`);
    expect(urpiDispatchMessage({ ...empty, otraSalidaViva: many })).toBe("Despachos a Urpi: 12 con otra salida viva, revísalos a mano (#KP0, #KP1, #KP2, #KP3, #KP4, #KP5, #KP6, #KP7, #KP8, #KP9 y 2 más).");
  });
});

describe("el MOM cita lo que hace el código (§30.10, §30.11)", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const mom = flat(readFileSync("docs/mom/master-pedidos-v1.md", "utf8"));
  it("registro del despacho, cierre de la salida y vínculo por la programación", () => {
    expect(mom).toContain("**Registro del despacho (decisión del owner, 03-11-2026).**");
    expect(mom).toContain("courier `urpi`, `created_via = urpi_programacion`, `delivery_status = en_ruta`, `dispatched_at` el mediodía de Lima del día programado");
    expect(mom).toContain("**La salida que ya salió como de Urpi (03-11-2026).**");
    expect(mom).toContain("(`link_method = programacion`, migración 0302;");
    expect(urpiDispatchRow("#KP1", "aaaaaaaa-0000-4000-8000-000000000001", "2026-11-02")).toMatchObject({ created_via: "urpi_programacion", delivery_status: "en_ruta", dispatched_at: "2026-11-02T17:00:00.000Z" });
  });
});
