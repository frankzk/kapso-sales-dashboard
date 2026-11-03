import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { dueUrpiDispatches, gfBoxFor, planUrpiDispatch, registerUrpiDispatches, urpiDispatchMessage, urpiDispatchRow, type UrpiDispatchCandidate } from "@/lib/urpi-dispatch";

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
    expect(planUrpiDispatch(open, [box({ id: "f1", courier: "fenix", created_via: "swayp", delivery_status: "en_ruta" })], "2026-11-02").kind).toBe("otra_salida_viva");
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
  it("la caja de Grupo GF, sola, va a la base para ver si su motorizado la reportó «No entregado» (owner, 03-11-2026)", () => {
    // #KP200665: Yordani la sacó el 29/10, no la entregó, y el 31/10 salió con Urpi.
    const gf = box({ id: "g1", courier: "propio", created_via: "grupo_gf_courier", custody_state: "courier",
      custody_transferred_at: "2026-10-29T16:16:00Z", dispatched_at: "2026-10-29T16:16:00Z", created_at: "2026-10-28T20:13:49Z" });
    expect(planUrpiDispatch(open, [gf], "2026-10-31")).toMatchObject({ kind: "tomar_caja_gf", salida: { id: "g1" } });
    // Ya recibida en oficina, igual.
    expect(planUrpiDispatch(open, [{ ...gf, custody_state: "empresa", custody_transferred_at: null, dispatched_at: null }], "2026-10-31").kind).toBe("tomar_caja_gf");
    // Con un intento fallido de otro courier antes: sigue siendo la única viva.
    expect(planUrpiDispatch(open, [box({ id: "t1", courier: "tanders", delivery_status: "anulado", dispatched_at: "2026-10-20T15:00:00Z" }), gf], "2026-10-31").kind).toBe("tomar_caja_gf");
    // Creada después del día programado, devuelta, entregada o ya en ruta: no.
    expect(gfBoxFor([{ ...gf, created_at: "2026-11-01T15:00:00Z" }], "2026-10-31")).toBeNull();
    expect(gfBoxFor([{ ...gf, custody_state: "devuelto" }], "2026-10-31")).toBeNull();
    expect(gfBoxFor([{ ...gf, returned_at: "2026-10-30T15:00:00Z" }], "2026-10-31")).toBeNull();
    expect(gfBoxFor([{ ...gf, delivery_status: "en_ruta" }], "2026-10-31")).toBeNull();
    expect(gfBoxFor([gf, box({ id: "t2", courier: "tanders", delivery_status: "entregado" })], "2026-10-31")).toBeNull();
    // Un entregado por Urpi con la caja de Grupo GF: se toma para cerrarla como de Urpi.
    expect(planUrpiDispatch({ general_status: "entregado", cancelled_at: null }, [gf], "2026-10-31").kind).toBe("tomar_caja_gf");
    expect(planUrpiDispatch({ general_status: "anulado", cancelled_at: null }, [gf], "2026-10-31").kind).toBe("cerrado");
    expect(planUrpiDispatch({ general_status: "entregado", cancelled_at: "2026-10-31T10:00:00Z" }, [gf], "2026-10-31").kind).toBe("cerrado");
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
function fakeAdmin(
  master: Record<string, any>[],
  shipments: Record<string, any>[],
  reportRows: Record<string, any>[] = [],
  takeGf: (args: any) => { data: string | null; error: { code: string; message: string } | null } = () => ({ data: "sin_no_entregado", error: null }),
) {
  const events: any[] = [];
  const rpcCalls: any[] = [];
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
  const rpc = (name: string, args: any) => { rpcCalls.push({ name, args }); return Promise.resolve(takeGf(args)); };
  return { admin: { from, rpc } as any, events, rpcCalls };
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
    expect(result).toEqual({ filled: ["#KP1"], fromGf: [], alreadyUrpi: 0, closed: 1, sinSalida: ["#KP3"], otraSalidaViva: ["#KP2"], reenvioTrasCancelado: [], cancelled: [], errors: [] });
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
  it("la caja de Grupo GF que no entregó pasa a Urpi en la base y, si Urpi ya la canceló, a intento fallido (#KP200665)", async () => {
    const master = [{ order_id: "o1", order_name: "#KP200665", store_id: "kenku", general_status: "en_proceso", orders: { cancelled_at: null } }];
    const gfId = "979731c6-69dd-4e0a-b7b1-af98029fa474";
    const shipments: Record<string, any>[] = [{ ...box({ id: gfId, courier: "propio", created_via: "grupo_gf_courier", custody_state: "courier",
      custody_transferred_at: "2026-10-29T16:16:00Z", dispatched_at: "2026-10-29T16:16:00Z", created_at: "2026-10-28T20:13:49Z" }),
      order_id: "o1", store_id: "kenku", output_code: "KP200665-S01", guide_code: "MOM-KP200665-PROPIO-979731C6" }];
    const report = [
      { urpi_row: 2779, order_id: "o1", result_code: "reprogramado", report_date: "2026-10-31", reason: "Otras razones" },
      { urpi_row: 2804, order_id: "o1", result_code: "cancelado", report_date: "2026-11-02", reason: "Otras razones" },
    ];
    // La base hace lo suyo (0305): la caja queda de Urpi en ruta, despachada el día programado.
    const { admin, events, rpcCalls } = fakeAdmin(master, shipments, report, (args) => {
      Object.assign(shipments[0]!, { courier: "urpi", created_via: "urpi_programacion", guide_code: args.p_guide_code, delivery_status: "en_ruta",
        status_category: "in_route", custody_state: "empresa", custody_transferred_at: null, dispatched_at: `${args.p_programmed_on}T17:00:00.000Z` });
      return { data: "tomada", error: null };
    });
    const result = await registerUrpiDispatches(admin, [{ orderId: "o1", orderCode: "KP200665", date: "2026-10-31" }], "2026-11-03");
    expect(rpcCalls).toEqual([{ name: "urpi_take_gf_output", args: { p_shipment_id: gfId, p_programmed_on: "2026-10-31", p_guide_code: "MOM-KP200665-URPI-979731C6" } }]);
    expect(result).toMatchObject({ filled: ["#KP200665"], fromGf: ["#KP200665"], cancelled: ["#KP200665"], otraSalidaViva: [], errors: [] });
    expect(shipments[0]).toMatchObject({ courier: "urpi", delivery_status: "anulado", status_category: "closed", dispatched_at: "2026-10-31T17:00:00.000Z", output_code: "KP200665-S01" });
    expect(events.map((e) => e.kind)).toEqual(["courier_status"]);
    expect(urpiDispatchMessage(result)).toBe("Despachos a Urpi: 1 caja(s) que Grupo GF no entregó pasaron a Urpi en ruta (#KP200665); 1 ya cancelado(s) por Urpi pasaron a «Por reprogramar Lima».");
  });
  it("si la base no la toma, se nombra para revisar; sin la 0305 aplicada, igual que antes; un error real es un error", async () => {
    const make = () => [{ ...box({ id: "g1", courier: "propio", created_via: "grupo_gf_courier" }), order_id: "o1", store_id: "kenku" }];
    const master = [{ order_id: "o1", order_name: "#KP1", store_id: "kenku", general_status: "en_proceso", orders: { cancelled_at: null } }];
    const rows = [{ orderId: "o1", orderCode: "KP1", date: "2026-10-31" }];
    for (const [answer, bucket] of [
      [{ data: "gf_no_es_anterior", error: null }, "otraSalidaViva"],
      [{ data: null, error: { code: "PGRST202", message: "Could not find the function" } }, "otraSalidaViva"],
      [{ data: null, error: { code: "P0001", message: "boom" } }, "errors"],
    ] as const) {
      const shipments = make();
      const { admin } = fakeAdmin(master, shipments, [], () => answer as any);
      const result = await registerUrpiDispatches(admin, rows, "2026-11-03");
      expect(result[bucket]).toEqual(["#KP1"]);
      expect(result.filled).toEqual([]);
      expect(shipments[0]).toMatchObject({ courier: "propio", delivery_status: "pendiente" });
    }
  });
  it("sin nada nuevo no dice nada; las listas largas se recortan", () => {
    const empty = { filled: [], fromGf: [], alreadyUrpi: 30, closed: 4, sinSalida: [], otraSalidaViva: [], reenvioTrasCancelado: [], cancelled: [], errors: [] };
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
  it("la caja que Grupo GF no entregó: la decisión, la función y lo que no toma", () => {
    expect(mom).toContain("**La caja que Grupo GF no entregó (decisión del owner, 03-11-2026).**");
    expect(mom).toContain("en una sola transacción (`urpi_take_gf_output`, migración 0305; `planUrpiDispatch`, `lib/urpi-dispatch.ts`)");
    expect(mom).toContain("y la caja que Grupo GF no entregó (owner, 03-11-2026: la programación la toma, §30.10)");
    expect(mom).toContain("El intento de Grupo GF no se pierde: es su parada «No entregado»");
  });
});

describe("0305: la base toma la caja de Grupo GF en una sola transacción", () => {
  const sql = readFileSync("db/migrations/0305_urpi_take_gf_output.sql", "utf8");
  const body = sql.slice(sql.indexOf("create or replace function public.urpi_take_gf_output("));
  it("solo la caja propia viva, sin otra salida viva ni entregada, y con su «No entregado» de una ruta anterior", () => {
    expect(body).toContain("if v_ship.courier <> 'propio' or v_ship.delivery_status <> 'pendiente' then return 'no_es_caja_gf_viva'; end if;");
    expect(body).toContain("or gf_output_replaced(v_ship.id) then");
    expect(body).toContain("from woo_sale_returns where order_id = v_ship.order_id) then return 'venta_terminada';");
    expect(body).toContain("return 'otra_salida';");
    expect(body).toContain("if not found or v_stop.status <> 'no_entregado' then return 'sin_no_entregado'; end if;");
    expect(body).toContain("if v_route_date is null or v_route_date >= p_programmed_on then return 'gf_no_es_anterior'; end if;");
    expect(body).toContain("if v_stop.dispatch_manifest_id is distinct from v_item.manifest_id then return 'caja_sin_reporte'; end if;");
  });
  it("recibe con la función de siempre, cancela la solicitud de Grupo GF y deja el rastro del relleno", () => {
    expect(body).toContain("perform gf_return_to_office(v_item.id, null);");
    expect(body).toContain("set status = 'cancelled', observation = v_note");
    expect(body).toContain("values (v_request, 'taken_by_urpi', 'cancelled', null, v_note,");
    expect(body).toContain("dispatched_at = (p_programmed_on + time '12:00') at time zone 'America/Lima',");
    expect(body).toContain("'route_output_filled', null, 'manual', 'urpi'");
    expect(body).toContain("'previousCourier', 'propio'");
    expect(body).toContain("return 'tomada';");
    expect(sql).toContain("grant execute on function public.urpi_take_gf_output(uuid, date, text) to service_role;");
    expect(sql).toContain("revoke all on function public.urpi_take_gf_output(uuid, date, text) from public, anon, authenticated;");
  });
  it("el código y la base hablan de lo mismo", async () => {
    const { GF_BOX_TAKEN } = await import("@/lib/urpi-dispatch");
    expect(body).toContain(`return '${GF_BOX_TAKEN}';`);
    expect(readFileSync("lib/urpi-dispatch.ts", "utf8")).toContain('admin.rpc("urpi_take_gf_output", {');
  });
});
