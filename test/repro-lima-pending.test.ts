import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadLimaPending } from "@/lib/repro-lima-pending-access";
import { attentionCounts, attentionFilter, attentionRows, createdPresets, emptyRowFilters, limaQueueSegment, limaScheduledFor, pendingFilters, pendingGroup, pendingKey, pendingMatches, limaPlanCandidate, readRowFilters, retryApprovalTargets, rowFilterOptions, rowFiltersMatch, rowFiltersParam, togglePendingKeys, writeRowFilters, type LimaPendingOrder } from "@/lib/repro-lima-pending";
import { LimaPendingFilters, LimaPendingList } from "@/components/repro-lima-pending";
import { ReproLimaBoard } from "@/components/repro-lima-board";
import type { ReproLimaData } from "@/lib/repro-lima-access";
import { sortQueue, type QueueRow } from "@/lib/dispatch-day";

vi.mock("@/app/dashboard/pedidos/repro-lima/actions", () => ({}));
vi.mock("@/app/dashboard/pedidos/repro-lima/retry-actions", () => ({ approveAliclikRetry: vi.fn(), dismissAliclikRetry: vi.fn() }));
vi.mock("@/components/order-master-shared", () => ({ MacroStageDot: () => null }));
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/pedidos/repro-lima",
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ refresh: () => {} }),
}));

const row = (overrides: Partial<LimaPendingOrder> = {}): LimaPendingOrder => ({
  orderId: "o1", storeId: "a", storeName: "Kenku", orderName: "#KP1", customerName: "María Pérez",
  customerPhone: "51912345678", district: "Lima", orderTotal: 149, createdAt: "2026-10-27T18:00:00Z",
  macroSince: "2026-10-27T18:00:00Z", stage: "preparacion", substage: "por_armar",
  courier: null, dispatchedAt: null, attempts: 0, hasPriorDispatch: false, lastDepartureAt: null, programmedFor: null, salesChannel: "web_formulario", address: "Av. Los Olivos 123", reference: "Frente al parque", ...overrides,
});
const TODAY = "2026-10-28";

describe("lectura amplia y filtros de Repro Lima", () => {
  it("todos activos por omisión; desmarcar una subetapa no esconde sus hermanas", () => {
    const rows = [row(), row({ orderId: "o2", substage: "por_generar_rotulo" })];
    const all = new Set<string>();
    expect(rows.filter((r) => !all.has(pendingKey(r)))).toHaveLength(2);
    const hidden = togglePendingKeys(all, [pendingKey(rows[0]!)]);
    expect(rows.filter((r) => !hidden.has(pendingKey(r))).map((r) => r.orderId)).toEqual(["o2"]);
  });
  it("una macroetapa parcial se restaura completa; se puede desmarcar todo", () => {
    const keys = ["preparacion:por_armar", "preparacion:por_generar_rotulo"];
    const partial = new Set([keys[0]!]);
    expect(togglePendingKeys(partial, keys).size).toBe(0);
    const none = togglePendingKeys(new Set(), keys);
    expect(none.size).toBe(2);
    expect(togglePendingKeys(none, keys).size).toBe(0);
    expect(none.size).toBe(2); // No muta el estado anterior.
  });
  it("las subetapas nuevas están visibles y no se pierden las que no tienen código", () => {
    const rows = [row({ substage: "futura" }), row({ orderId: "o2", substage: null }), row({ orderId: "o3" })];
    expect(pendingFilters(rows)[0]!.children.map((s) => s.label)).toEqual(["Por armar", "futura", "Sin subetapa"]);
    expect(rows.filter((r) => !new Set(["preparacion:por_armar"]).has(pendingKey(r)))).toHaveLength(2);
  });
  it("separa primer despacho, antiguo y seguimiento sin inventar un fallo", () => {
    expect(pendingGroup(row(), TODAY).label).toBe("Pendiente de primer despacho");
    const tanders = row({ stage: "en_curso", substage: "en_transito", courier: "tanders", dispatchedAt: "2026-10-08T15:00:00Z", createdAt: "2026-09-01T15:00:00Z" });
    expect(pendingGroup(tanders, TODAY).label).toBe("Antiguo por revisar");
    expect(tanders.substage).toBe("en_transito");
    expect(pendingGroup(row({ stage: "en_curso", substage: "en_reparto" }), TODAY).label).toBe("Seguimiento de entrega");
    expect(pendingGroup(row({ stage: "en_curso", substage: "por_reprogramar_lima" }), TODAY).label).toBe("Entrega fallida");
  });
  it("agendado con Aliclik: programado según el recojo, con su propia gestión (owner, 07-11-2026)", () => {
    const tomorrow = row({ stage: "por_despachar", substage: "listo_para_asignar", courier: "aliclik", courierPickup: { courier: "aliclik", date: "2026-10-29" } });
    expect(limaQueueSegment(tomorrow, TODAY)).toBe("programados_manana");
    expect(pendingGroup(tomorrow, TODAY)).toEqual({
      label: "Agendado con Aliclik",
      detail: "Aliclik lo recoge el jue 29/10. No hace falta gestión salvo que el cliente cambie algo.",
    });
    // El día pasó sin recojo: sigue en Hoy como vencido, y eso sí es trabajo.
    const missed = row({ courierPickup: { courier: "aliclik", date: "2026-10-27" } });
    expect(limaQueueSegment(missed, TODAY)).toBe("programados_hoy");
    expect(pendingGroup(missed, TODAY).label).toBe("Aliclik no lo recogió");
    // Una programación de Grupo GF o una fecha acordada mandan sobre el recojo.
    const programmed = row({ programmedFor: "2026-11-02", courierPickup: { courier: "aliclik", date: "2026-10-29" } });
    expect(limaScheduledFor(programmed)).toBe("2026-11-02");
    // Sin guía esperando, todo sigue como antes.
    expect(limaQueueSegment(row(), TODAY)).toBe("nunca_salieron");
    expect(pendingGroup(row({ courierPickup: null }), TODAY).label).toBe("Pendiente de primer despacho");
  });
  it("busca código, nombre sin tildes y teléfono con espacios", () => {
    expect(pendingMatches(row(), "kp1")).toBe(true);
    expect(pendingMatches(row(), "maria perez")).toBe(true);
    expect(pendingMatches(row(), "912 345 678")).toBe(true);
    expect(pendingMatches(row(), "otro")).toBe(false);
  });
  it("Tanders sin cierre entra a revisión aunque todavía no tenga 30 días", () => {
    const tanders = row({ stage: "en_curso", substage: "en_transito", courier: "tanders", createdAt: "2026-10-02T15:00:00Z", dispatchedAt: "2026-10-08T15:00:00Z", attempts: 1 });
    expect(pendingGroup(tanders, TODAY).label).toBe("Antiguo por revisar");
    expect(pendingGroup(tanders, TODAY).detail).toContain("sin cierre");
    expect(pendingGroup({ ...tanders, dispatchedAt: "2026-10-28T15:00:00Z" }, TODAY).label).toBe("Seguimiento de entrega");
    expect(tanders.substage).toBe("en_transito");
  });
  it("agrega las cantidades en orden del MOM", () => {
    const groups = pendingFilters([row(), row({ orderId: "o2", stage: "en_curso", substage: "en_transito" }), row({ orderId: "o3", substage: "por_generar_rotulo" })]);
    expect(groups.map((g) => [g.stage, g.count])).toEqual([["preparacion", 2], ["en_curso", 1]]);
    expect(groups[0]!.children.map((g) => g.key)).toEqual(["preparacion:por_generar_rotulo", "preparacion:por_armar"]);
  });
});

type Admin = Parameters<typeof loadLimaPending>[0];
type DBRow = Record<string, unknown>;
function master(i: number, extra: DBRow = {}): DBRow {
  return { order_id: `o${i}`, store_id: "a", order_name: `#KP${i}`, customer_name: "María", customer_phone: null,
    district: "Lima", order_total: "149.00", order_created_at: "2026-10-27T15:00:00Z", macro_since: null,
    macro_stage: "preparacion", macro_substage: "por_armar", coverage: "lima", current_courier: null,
    dispatched_at: null, attempt_count: 0, ...extra };
}
function database(source: DBRow[], fail = false, opts: { programs?: DBRow[]; departures?: DBRow[]; shipments?: DBRow[]; rpcError?: string; programError?: string; shipmentError?: string; tables?: Record<string, DBRow[]>; tableErrors?: Record<string, string> } = {}) {
  const pages: number[] = [];
  const ranges: Array<{ table: string; from: number }> = [];
  const from = vi.fn((table: string) => {
    const filters: Array<(r: DBRow) => boolean> = [];
    let range: [number, number] | null = null;
    const q = {
      select: () => q,
      in: (key: string, values: unknown[]) => { filters.push((r) => values.includes(r[key])); return q; },
      eq: (key: string, value: unknown) => { filters.push((r) => r[key] === value); return q; },
      is: (key: string, value: unknown) => { filters.push((r) => (r[key] ?? null) === value); return q; },
      gte: (key: string, value: string) => { filters.push((r) => String(r[key] ?? "") >= value); return q; },
      neq: (key: string, value: unknown) => { filters.push((r) => r[key] !== value); return q; },
      not: (key: string, op: string, value: string) => {
        const banned = op === "in" ? value.replace(/[()]/g, "").split(",") : [value];
        filters.push((r) => !banned.includes(String(r[key])));
        return q;
      },
      maybeSingle: async () => ({ data: (opts.tables?.[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
      order: () => q,
      range: (a: number, b: number) => { range = [a, b]; if (table === "order_master") pages.push(a); ranges.push({ table, from: a }); return q; },
      then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const rows = (table === "stores" ? [{ id: "a", name: "Kenku", org_id: "org" }] : table === "gf_dispatch_programs" ? opts.programs ?? [] : table === "order_master" ? source
          : table === "shipments" ? [...(opts.shipments ?? []), ...(opts.tables?.shipments ?? [])] : opts.tables?.[table] ?? []).filter((r) => filters.every((f) => f(r)));
        const error = fail && table === "order_master" ? { message: "sin conexión" }
          : table === "gf_dispatch_programs" && opts.programError ? { message: opts.programError }
          : table === "shipments" && opts.shipmentError ? { message: opts.shipmentError }
          : opts.tableErrors?.[table] ? { message: opts.tableErrors[table]! } : null;
        return Promise.resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error }).then(resolve, reject);
      },
    };
    return q;
  });
  const rpc = vi.fn(async (_name: string, args: { p_order_ids: string[] }) => ({
    data: (opts.departures ?? []).filter((d) => args.p_order_ids.includes(String(d.order_id))),
    error: opts.rpcError ? { message: opts.rpcError } : null,
  }));
  return { admin: { from, rpc } as unknown as Admin, pages, ranges, from, rpc };
}
describe("acceso a todos los pendientes", () => {
  it("carga más de 1383 filas y solo las tiendas/cobertura/etapas autorizadas", async () => {
    const db = database([...Array.from({ length: 1383 }, (_, i) => master(i)),
      master(2000, { store_id: "fuera" }), master(2001, { coverage: "provincia_cod" }),
      master(2002, { macro_stage: "por_cerrar" }), master(2003, { macro_stage: "finalizado" }),
      master(2004, { macro_stage: "en_curso", macro_substage: "en_transito", current_courier: "tanders" }),
    ], false, { departures: [...Array.from({ length: 1383 }, (_, i) => ({ order_id: `o${i}`, last_departure_at: "2026-10-27T17:00:00Z" })), { order_id: "o2004", last_departure_at: "2026-10-27T17:00:00Z" }] });
    const rows = await loadLimaPending(db.admin, { userId: "u", storeIds: new Set(["a"]) });
    expect(rows).toHaveLength(1384);
    expect(rows.every((r) => r.hasPriorDispatch)).toBe(true);
    expect(db.pages).toEqual([0, 500, 1000]);
    expect(rows.at(-1)?.substage).toBe("en_transito");
    expect(rows[0]?.orderTotal).toBe(149);
    // Más lo de «Sale a reparto» (§29.16): las cajas vigentes (por lo En curso), el proveedor y las salidas de los candidatos.
    expect(new Set(db.from.mock.calls.map(([table]) => table))).toEqual(new Set(["stores", "order_master", "gf_dispatch_programs", "dispatch_manifests", "logistics_providers", "shipments"]));
    expect(db.rpc.mock.calls.map(([, args]) => args.p_order_ids.length)).toEqual([500, 500, 384]);
  });
  it("usa salidas reales aunque Master haya vuelto a dejar dispatched_at vacío", async () => {
    const db = database([master(1)], false, { departures: [{ order_id: "o1", last_departure_at: "2026-10-27T17:00:00Z" }], programs: [{ order_id: "o1", store_id: "a", scheduled_for: "2026-10-29" }] });
    const [r] = await loadLimaPending(db.admin, { userId: "u", storeIds: new Set(["a"]) });
    expect(r).toMatchObject({ dispatchedAt: null, hasPriorDispatch: true, programmedFor: "2026-10-29" });
    expect(db.rpc.mock.calls[0]?.[0]).toBe("gf_order_departures");
  });
  it("pagina también los programas y solo asocia la tienda correcta del pedido", async () => {
    const source = Array.from({ length: 1201 }, (_, i) => master(i));
    const programs = source.map((r, i) => ({ order_id: r.order_id, store_id: i === 0 ? "b" : "a", scheduled_for: "2026-10-29" }));
    const db = database(source, false, { programs });
    const rows = await loadLimaPending(db.admin, { userId: "u", storeIds: new Set(["a"]) });
    expect(db.ranges.filter((r) => r.table === "gf_dispatch_programs").map((r) => r.from)).toEqual([0, 500, 1000]);
    expect(rows[1200]?.programmedFor).toBe("2026-10-29");
    expect(rows[0]?.programmedFor).toBeNull();
  });
  it("un error de hechos no se presenta como cero salidas o cero programados", async () => {
    const scope = { userId: "u", storeIds: new Set(["a"]) };
    await expect(loadLimaPending(database([master(1)], false, { rpcError: "sin historial" }).admin, scope)).rejects.toThrow("sin historial");
    await expect(loadLimaPending(database([master(1)], false, { programError: "sin programas" }).admin, scope)).rejects.toThrow("sin programas");
  });
  it("«Sale a reparto»: la caja de Grupo GF, la solicitud y el armado de su salida; otra salida viva no es de Grupo GF", async () => {
    const source = [
      master(1, { macro_stage: "por_despachar", macro_substage: "listo_para_asignar" }),
      master(2, { macro_stage: "por_despachar", macro_substage: "listo_para_asignar" }),
      master(3, { macro_stage: "preparacion", macro_substage: "por_generar_rotulo" }),
      master(4, { macro_stage: "en_curso", macro_substage: "por_reprogramar_lima" }),
      master(5, { macro_stage: "en_curso", macro_substage: "en_transito", current_courier: "propio" }),
      // Ya lo recogió el motorizado de la caja de hoy: sigue en «Hoy».
      master(6, { macro_stage: "en_curso", macro_substage: "en_reparto", current_courier: "propio" }),
      // Programado, con su «No entregado» todavía en la caja del 04/11.
      master(7, { macro_stage: "en_curso", macro_substage: "por_reprogramar_lima" }),
      // Programado; la guía de Tanders que falló sigue `en_ruta` (vuelve).
      master(8, { macro_stage: "en_curso", macro_substage: "por_reprogramar_lima" }),
    ];
    const ship = (id: string, order: string, over: DBRow = {}) => ({ id, order_id: order, courier: "propio", preparation_state: "listo_despacho", qr_token: `q${id}`, delivery_status: "pendiente", created_at: "2026-11-06T10:00:00Z", ...over });
    const db = database(source, false, {
      programs: [{ order_id: "o7", store_id: "a", scheduled_for: "2026-11-09" }, { order_id: "o8", store_id: "a", scheduled_for: "2026-11-09" }],
      tables: {
        logistics_providers: [{ id: "gf", code: "grupo-gf-courier", org_id: "org" }, { id: "gf-otra", code: "grupo-gf-courier", org_id: "otra" }],
        shipments: [
          ship("s1", "o1"),
          ship("s1old", "o1", { courier: "tanders", qr_token: "q0", delivery_status: "anulado", created_at: "2026-11-01T10:00:00Z" }),
          ship("s2", "o2", { courier: "aliclik" }),
          ship("s6", "o6", { delivery_status: "en_ruta" }),
          ship("s7", "o7"),
          ship("s8old", "o8", { courier: "tanders", delivery_status: "en_ruta", reported_status: "RETURNING" }),
        ],
        logistics_requests: [
          { order_id: "o1", shipment_id: "s1", scheduled_for: "2026-11-07", status: "scheduled", provider_id: "gf" },
          // La solicitud de otra organización no es de estas tiendas.
          { order_id: "o3", shipment_id: null, scheduled_for: "2026-11-01", status: "accepted", provider_id: "gf-otra" },
        ],
        dispatch_manifest_items: [
          { id: "i1", shipment_id: "s1", manifest_id: "m1", office_checked_at: "2026-11-06T20:00:00Z", pickup_checked_at: null, removed_at: null },
          { id: "i6", shipment_id: "s6", manifest_id: "m1", office_checked_at: "2026-11-07T08:00:00Z", pickup_checked_at: "2026-11-07T09:00:00Z", removed_at: null },
          { id: "i7", shipment_id: "s7", manifest_id: "m0", office_checked_at: "2026-11-04T08:00:00Z", pickup_checked_at: "2026-11-04T09:00:00Z", removed_at: null },
        ],
        dispatch_manifests: [
          { id: "m1", route_date: "2026-11-07", driver_name: "Jhon", courier: "propio", kind: "reparto", state: "in_custody" },
          { id: "m0", route_date: "2026-11-04", driver_name: "Yhoni", courier: "propio", kind: "reparto", state: "in_custody" },
        ],
      },
    });
    const rows = await loadLimaPending(db.admin, { userId: "u", storeIds: new Set(["a"]) }, new Date("2026-11-07T15:00:00Z"));
    const gf = Object.fromEntries(rows.map((r) => [r.orderId, r.gf]));
    expect(gf.o1).toEqual({ box: { day: "2026-11-07", riderName: "Jhon", officeChecked: true, pickedUp: false }, requestDay: "2026-11-07", labeled: true, armed: true });
    expect(gf.o2).toBeNull(); // sale con Aliclik
    expect(gf.o3).toEqual({ box: null, requestDay: null, labeled: false, armed: false }); // sin salida todavía
    expect(gf.o4).toBeNull(); // «Por reprogramar Lima» sin acuerdo ni programa: espera a la tienda
    expect(gf.o5).toBeNull(); // ya salió, y no está en una caja vigente
    expect(gf.o6).toEqual({ box: { day: "2026-11-07", riderName: "Jhon", officeChecked: true, pickedUp: true }, requestDay: null, labeled: true, armed: true });
    // La caja del 04/11 no es su caja: sale el día de su programa y se recibe en oficina.
    expect(gf.o7).toEqual({ box: null, requestDay: null, labeled: true, armed: true, awaitingOffice: true });
    // La guía de Tanders que vuelve no lo hace «de otro courier»: entra, sin salida de Grupo GF todavía.
    expect(gf.o8).toEqual({ box: null, requestDay: null, labeled: false, armed: false });
  });
  it("«Sale a reparto»: un error al leer el proveedor o las cajas no se presenta como «sin solicitud»", async () => {
    const source = [master(1, { macro_stage: "por_despachar", macro_substage: "listo_para_asignar" })];
    const failing = database(source, false, { tableErrors: { logistics_providers: "proveedor caído" } });
    await expect(loadLimaPending(failing.admin, { userId: "u", storeIds: new Set(["a"]) })).rejects.toThrow("proveedor caído");
    const boxes = database([master(1, { macro_stage: "en_curso", macro_substage: "en_reparto" })], false, { tableErrors: { dispatch_manifests: "cajas caídas" } });
    await expect(loadLimaPending(boxes.admin, { userId: "u", storeIds: new Set(["a"]) })).rejects.toThrow("cajas caídas");
  });
  it("la guía Aliclik que espera recojo da el día; la que ya salió, volvió o se anuló, no", async () => {
    const guide = (order_id: string, extra: DBRow = {}): DBRow => ({
      order_id, courier: "aliclik", status_category: "pending", delivery_status: "pendiente",
      dispatched_at: null, out_for_delivery_at: null, returned_at: null,
      aliclik_expected_dispatch_date: "2026-11-06", aliclik_reported_dispatch_date: null, ...extra,
    });
    const db = database([master(1), master(2), master(3), master(4), master(5), master(6)], false, { shipments: [
      guide("o1"),
      guide("o2", { aliclik_reported_dispatch_date: "2026-11-08" }),
      guide("o3", { out_for_delivery_at: "2026-11-06T15:00:00Z" }),
      guide("o4", { delivery_status: "anulado" }),
      guide("o5", { courier: "tanders" }),
      guide("o6", { status_category: "closed" }),
    ] });
    const rows = await loadLimaPending(db.admin, { userId: "u", storeIds: new Set(["a"]) });
    const pickup = Object.fromEntries(rows.map((r) => [r.orderId, r.courierPickup]));
    expect(pickup).toEqual({
      o1: { courier: "aliclik", date: "2026-11-06" },
      // Lo que reportó Aliclik manda sobre su propia regla de corte.
      o2: { courier: "aliclik", date: "2026-11-08" },
      o3: null, o4: null, o5: null, o6: null,
    });
  });
  it("si no se pueden leer las guías, se dice; no se manda todo a «Nunca salieron»", async () => {
    await expect(loadLimaPending(database([master(1)], false, { shipmentError: "sin guías" }).admin, { userId: "u", storeIds: new Set(["a"]) }))
      .rejects.toThrow("sin guías");
  });
  it("sin tiendas no consulta y un error no se presenta como lista vacía", async () => {
    const db = database([], true);
    await expect(loadLimaPending(db.admin, { userId: "u", storeIds: new Set() })).resolves.toEqual([]);
    expect(db.from).not.toHaveBeenCalled();
    await expect(loadLimaPending(db.admin, { userId: "u", storeIds: new Set(["a"]) })).rejects.toThrow("sin conexión");
  });
});

describe("presentación inicial y gestión", () => {
  const data = { today: TODAY, nowIso: "2026-10-28T15:00:00Z", cutoffLabel: "12:00", stores: [{ id: "a", name: "Kenku" }], rows: [], me: "u" } as unknown as ReproLimaData;
  it("entra en Todos con Atender y una única tabla", () => {
    nav.search = "";
    const html = renderToStaticMarkup(createElement(ReproLimaBoard, { data, pending: [row()] }));
    expect(html).toContain('aria-label="Todos los pendientes de Lima"');
    expect(html).toContain("#KP1");
    expect(html).toContain(">Atender</button>");
    expect(html).not.toContain("Gestionar pedido");
    expect(html).not.toContain("Resumen y cierres pendientes");
    expect(html.match(/<table /g)).toHaveLength(1);
    expect(html).toContain("Todos activos al entrar.");
  });
  it("los tres enlaces antiguos abren Todos y mantienen Atender", () => {
    for (const legacy of ["listas", "todos", "resumen"]) {
      nav.search = `vista=${legacy}`;
      const html = renderToStaticMarkup(createElement(ReproLimaBoard, { data, pending: [row()] }));
      expect(html).toContain('aria-label="Todos los pendientes de Lima"');
      expect(html).toContain(">Atender</button>");
      expect(html.indexOf("Todos · por entregar")).toBeLessThan(html.indexOf("Reprogramados"));
    }
    nav.search = "";
  });
  it("respeta las exclusiones de la URL y una selección completamente vacía", () => {
    nav.search = "ocultar=preparacion%3Apor_armar";
    const html = renderToStaticMarkup(createElement(ReproLimaBoard, { data, pending: [row()] }));
    expect(html).not.toContain("#KP1");
    expect(html).toContain("No hay pedidos con estos filtros");
    nav.search = "";
  });
  it("abre el expediente sobre la pantalla y conserva vista, filtro y orden", () => {
    nav.search = "ocultar=en_curso%3Aen_transito";
    const html = renderToStaticMarkup(createElement(LimaPendingList, { rows: [row()], reproRows: [], today: TODAY, renderActions: () => null }));
    expect(html).toContain("ocultar=en_curso%3Aen_transito&amp;ficha=o1");
    expect(html).not.toContain("seccion=historial"); // Operar es la sección por omisión.
    expect(html).not.toContain("claimReproCase");
    nav.search = "";
  });
  it("los filtros son chips del Master, agrupados y todos activos inicialmente", () => {
    const html = renderToStaticMarkup(createElement(LimaPendingFilters, { rows: [row()], hidden: new Set<string>(), onToggle: () => {}, onReset: () => {} }));
    expect(html).not.toContain('type="checkbox"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Macroestado"');
    expect(html).toContain('aria-label="Subetapa"');
  });
});

describe("apartados operativos de la misma cola", () => {
  const rows = [
    row({ orderId: "reciente" }),
    row({ orderId: "antiguo", createdAt: "2026-09-27T05:00:00Z" }),
    row({ orderId: "treinta", createdAt: "2026-09-28T05:00:00Z" }),
    row({ orderId: "retorno", hasPriorDispatch: true, lastDepartureAt: "2026-10-20T15:00:00Z", dispatchedAt: null, attempts: 0 }),
    row({ orderId: "hoy", programmedFor: TODAY }),
    row({ orderId: "vencido", programmedFor: "2026-10-26" }),
    row({ orderId: "manana", programmedFor: "2026-10-29" }),
    row({ orderId: "despues", programmedFor: "2026-10-30" }),
    row({ orderId: "acuerdo", hasPriorDispatch: true }),
  ];
  const cases = [{ orderId: "acuerdo", list: "programados" as const, agreement: { agreedOn: "2026-10-29" } }];
  it("los seis apartados suman Todos; Reprogramados cuenta las nuevas fechas acordadas", () => {
    const counts = attentionCounts(rows, cases, TODAY);
    expect(counts).toEqual({ todos: 9, reintentos_aliclik: 0, reprogramados: 1, programados_hoy: 2, programados_manana: 2, nunca_salieron: 2, ya_salieron: 1, mas_de_30: 1, programados_despues: 1, llamar_despues: 0, cerrados: 0 });
    expect(counts.programados_hoy + counts.programados_manana + counts.nunca_salieron + counts.ya_salieron + counts.mas_de_30 + counts.programados_despues).toBe(counts.todos);
  });
  it("una salida que retornó no vuelve a Nunca salieron aunque Master haya borrado el despacho", () => {
    expect(attentionRows(rows, cases, "ya_salieron", TODAY).map((r) => r.orderId)).toEqual(["retorno"]);
    expect(attentionRows(rows, cases, "nunca_salieron", TODAY).map((r) => r.orderId)).not.toContain("retorno");
  });
  it("la fecha manda sobre la antigüedad y el historial de salidas", () => {
    const old = row({ createdAt: "2026-01-01T15:00:00Z", hasPriorDispatch: true, programmedFor: "2026-10-29" });
    expect(limaQueueSegment(old, TODAY)).toBe("programados_manana");
    expect(attentionRows(rows, cases, "programados_hoy", TODAY).map((r) => r.orderId)).toEqual(["vencido", "hoy"]);
  });
  it("la fecha acordada vigente manda sobre un programa anterior; no se inventa un acuerdo", () => {
    const r = row({ programmedFor: TODAY });
    const c = { orderId: r.orderId, list: "programados" as const, agreement: { agreedOn: "2026-10-29" } };
    expect(limaScheduledFor(r, c)).toBe("2026-10-29");
    expect(limaQueueSegment(r, TODAY, c)).toBe("programados_manana");
    expect(attentionCounts([r], [{ orderId: r.orderId, list: "programados" }], TODAY).reprogramados).toBe(0);
    expect(attentionCounts([r], [{ ...c, list: "por_decidir" }], TODAY).reprogramados).toBe(0);
  });
  it("mañana se convierte en hoy al cambiar el día de Lima, incluso al cambiar de mes", () => {
    const r = row({ programmedFor: "2026-11-01" });
    expect(limaQueueSegment(r, "2026-10-31")).toBe("programados_manana");
    expect(limaQueueSegment(r, "2026-11-01")).toBe("programados_hoy");
  });
  it("Nunca salieron va del más antiguo al más reciente, en su tarjeta y en Todos (owner, 06-11-2026)", () => {
    const pico = [
      row({ orderId: "hoy-1", createdAt: "2026-10-28T15:00:00Z" }),
      row({ orderId: "hace-5-dias", createdAt: "2026-10-23T15:00:00Z" }),
      row({ orderId: "ayer", createdAt: "2026-10-27T15:00:00Z" }),
      row({ orderId: "volvio-ayer", createdAt: "2026-10-27T15:00:00Z", hasPriorDispatch: true }),
      row({ orderId: "volvio-antes", createdAt: "2026-10-20T15:00:00Z", hasPriorDispatch: true }),
      row({ orderId: "prog", createdAt: "2026-10-01T15:00:00Z", programmedFor: TODAY }),
    ];
    expect(attentionRows(pico, [], "nunca_salieron", TODAY).map((r) => r.orderId)).toEqual(["hace-5-dias", "ayer", "hoy-1"]);
    // En Todos el orden de los apartados no cambia; solo el de adentro de Nunca salieron.
    expect(attentionRows(pico, [], "todos", TODAY).map((r) => r.orderId)).toEqual(["prog", "hace-5-dias", "ayer", "hoy-1", "volvio-ayer", "volvio-antes"]);
    // Ya salieron sigue del más reciente al más antiguo.
    expect(attentionRows(pico, [], "ya_salieron", TODAY).map((r) => r.orderId)).toEqual(["volvio-ayer", "volvio-antes"]);
  });
  it("solo Repro Lima cambia: Despacho del día sigue del más reciente al más antiguo (§29.13)", () => {
    // Solo los campos que mira el orden; el resto de la fila no participa.
    const q = (orderId: string, createdAt: string) => ({ orderId, createdAt, programmedFor: null, hasPriorDispatch: false, assignable: true }) as unknown as QueueRow;
    expect(sortQueue([q("viejo", "2026-10-23T15:00:00Z"), q("nuevo", "2026-10-28T15:00:00Z")], TODAY).map((r) => r.orderId)).toEqual(["nuevo", "viejo"]);
  });
  it("Más de 30 días es estricto y usa el día de creación en Lima", () => {
    expect(limaQueueSegment(row({ createdAt: "2026-09-28T04:59:59Z" }), TODAY)).toBe("mas_de_30");
    expect(limaQueueSegment(row({ createdAt: "2026-09-28T05:00:00Z" }), TODAY)).toBe("nunca_salieron");
    expect(limaQueueSegment(row({ createdAt: null }), TODAY)).toBe("nunca_salieron");
  });
  it("Todas las filas siguen accesibles sin duplicar pedidos por Reprogramados", () => {
    const all = attentionRows(rows, cases, "todos", TODAY);
    expect(all).toHaveLength(9);
    expect(new Set(all.map((r) => r.orderId)).size).toBe(9);
    expect(attentionRows(rows, cases, "reprogramados", TODAY).map((r) => r.orderId)).toEqual(["acuerdo"]);
    expect(rows[0]?.orderId).toBe("reciente");
  });
  it("mantiene llamadas y cierres como filtros secundarios sobre las mismas filas", () => {
    const follow = [{ orderId: "hoy", list: "cerrados" as const }, { orderId: "retorno", list: "llamar_despues" as const }];
    expect(attentionRows(rows, follow, "cerrados", TODAY).map((r) => r.orderId)).toEqual(["hoy"]);
    expect(attentionCounts(rows.slice(0, 3), follow, TODAY).cerrados).toBe(0);
  });
  it("los enlaces antiguos se normalizan y las nuevas tarjetas tienen un filtro explícito", () => {
    for (const value of [null, "listas", "resumen", "por_decidir", "todos", "desconocido"]) expect(attentionFilter(value)).toBe("todos");
    expect(attentionFilter("programados")).toBe("reprogramados");
    expect(attentionFilter("programados_manana")).toBe("programados_manana");
    expect(attentionFilter("llamar_despues")).toBe("llamar_despues");
  });
});

describe("filtros de la barra junto a Tienda: Creación, Canal, Distrito y Courier (owner, 06-11-2026)", () => {
  const f = (patch: Partial<ReturnType<typeof emptyRowFilters>> = {}) => ({ ...emptyRowFilters(), ...patch });
  it("Creación usa el día de Lima y acepta solo un extremo", () => {
    // 04:00 UTC del 28 es todavía el 27 en Lima.
    const r = row({ createdAt: "2026-10-28T04:00:00Z" });
    expect(rowFiltersMatch(r, f({ createdFrom: "2026-10-27", createdTo: "2026-10-27" }))).toBe(true);
    expect(rowFiltersMatch(r, f({ createdFrom: "2026-10-28" }))).toBe(false);
    expect(rowFiltersMatch(r, f({ createdTo: "2026-10-26" }))).toBe(false);
    // Sin fecha de creación no entra en un rango de fechas.
    expect(rowFiltersMatch(row({ createdAt: null }), f({ createdTo: TODAY }))).toBe(false);
    expect(rowFiltersMatch(row({ createdAt: null }), f())).toBe(true);
  });
  it("los atajos de Creación: hoy, ayer, la semana y lo que lleva días", () => {
    expect(createdPresets("2026-11-06")).toEqual([
      { label: "Hoy", from: "2026-11-06", to: "2026-11-06" },
      { label: "Ayer", from: "2026-11-05", to: "2026-11-05" },
      { label: "Últimos 7 días", from: "2026-10-31", to: "2026-11-06" },
      { label: "Antes de ayer o más", from: "", to: "2026-11-04" },
    ]);
    expect(createdPresets("2026-11-01")[1]).toEqual({ label: "Ayer", from: "2026-10-31", to: "2026-10-31" });
  });
  it("Canal sin calcular es «Sin marca»; Distrito une tildes y mayúsculas; Courier vacío es «Sin courier»", () => {
    expect(rowFiltersMatch(row({ salesChannel: null }), f({ channels: new Set(["otro"]) }))).toBe(true);
    expect(rowFiltersMatch(row({ salesChannel: "asesora" }), f({ channels: new Set(["web_formulario"]) }))).toBe(false);
    expect(rowFiltersMatch(row({ district: "San Martin de Porres " }), f({ districts: new Set(["san martin de porres"]) }))).toBe(true);
    expect(rowFiltersMatch(row({ district: "SAN MARTÍN DE PORRES" }), f({ districts: new Set(["san martin de porres"]) }))).toBe(true);
    expect(rowFiltersMatch(row({ courier: null }), f({ couriers: new Set(["sin_courier"]) }))).toBe(true);
    expect(rowFiltersMatch(row({ courier: "propio" }), f({ couriers: new Set(["aliclik"]) }))).toBe(false);
  });
  it("las opciones llevan su cantidad, con el nombre más escrito y el del courier", () => {
    const rows = [
      row({ orderId: "1", district: "San Martín de Porres", courier: "propio", salesChannel: "asesora" }),
      row({ orderId: "2", district: "san martin de porres", courier: "propio" }),
      row({ orderId: "3", district: "San Martín de Porres", courier: null }),
      row({ orderId: "4", district: null, courier: "aliclik", salesChannel: null }),
    ];
    const o = rowFilterOptions(rows);
    expect(o.districts).toEqual([
      { value: "san martin de porres", label: "San Martín De Porres", count: 3 },
      { value: "sin_distrito", label: "Sin distrito", count: 1 },
    ]);
    expect(o.couriers).toEqual([
      { value: "propio", label: "Grupo GF", count: 2 },
      { value: "aliclik", label: "Aliclik", count: 1 },
      { value: "sin_courier", label: "Sin courier", count: 1 },
    ]);
    // Las opciones fijas del Master, en su orden, también con cero.
    expect(o.channels.map((c) => [c.value, c.count])).toEqual([["web_formulario", 2], ["web_carrito", 0], ["asesora", 1], ["chatbot", 0], ["bot_carritos", 0], ["catalogo", 0], ["otro", 1]]);
  });
  it("viven en la URL; una fecha mal escrita se ignora y la ficha no cambia la clave", () => {
    const params = new URLSearchParams("atencion=nunca_salieron&ficha=o1");
    writeRowFilters(params, f({ createdTo: "2026-11-04", districts: new Set(["ate", "callao"]), channels: new Set(["asesora"]) }));
    expect(params.get("atencion")).toBe("nunca_salieron");
    const back = readRowFilters(params);
    expect(back.createdTo).toBe("2026-11-04");
    expect([...back.districts]).toEqual(["ate", "callao"]);
    expect(readRowFilters(new URLSearchParams("creado_desde=ayer")).createdFrom).toBe("");
    expect(rowFiltersParam(new URLSearchParams(`${params}&ficha=o2`))).toBe(rowFiltersParam(params));
  });
  it("en el tablero: las cuatro píldoras junto a Tienda y la lista recortada por la URL", () => {
    const data = { today: TODAY, nowIso: "2026-10-28T15:00:00Z", cutoffLabel: "12:00", stores: [{ id: "a", name: "Kenku" }, { id: "b", name: "Aurela" }], rows: [], me: "u" } as unknown as ReproLimaData;
    const pending = [row({ orderId: "o1", orderName: "#KP1", district: "Ate" }), row({ orderId: "o2", orderName: "#KP2", district: "Callao" })];
    nav.search = "";
    let html = renderToStaticMarkup(createElement(ReproLimaBoard, { data, pending }));
    const at = (label: string) => html.indexOf(`>${label}<`);
    expect(at("Tienda")).toBeGreaterThan(0);
    for (const label of ["Creación", "Canal", "Distrito", "Courier"]) expect(at(label)).toBeGreaterThan(at("Tienda"));
    expect(html).not.toContain("Quitar filtros");
    nav.search = "distrito=ate";
    html = renderToStaticMarkup(createElement(ReproLimaBoard, { data, pending }));
    expect(html).toContain("#KP1");
    expect(html).not.toContain("#KP2");
    expect(html).toContain("Quitar filtros");
    // Cada píldora cuenta con las demás puestas (la hoja se abre al tocarla;
    // aquí se comprueba la regla con la función que usa el tablero).
    const conDistrito = pending.filter((r) => rowFiltersMatch(r, { ...emptyRowFilters(), districts: new Set(["ate"]) }));
    expect(rowFilterOptions(conDistrito).channels.find((c) => c.value === "web_formulario")?.count).toBe(1);
    // El total de la línea sigue siendo el de la tienda.
    expect(html).toMatch(/<b[^>]*>1<\/b> de 2 pendientes de entrega/);
    nav.search = "";
  });
});

describe("la dirección completa bajo el cliente (owner, 06-11-2026)", () => {
  it("dirección, distrito y referencia enteros, en la tabla y en la lista del teléfono", () => {
    const html = renderToStaticMarkup(createElement(LimaPendingList, { rows: [row({ district: "Los Olivos" })], reproRows: [], today: TODAY, renderActions: () => null }));
    // Una vez en la tabla (desde 1280 px) y otra en la lista.
    expect(html.match(/Av\. Los Olivos 123 · Los Olivos/g)).toHaveLength(2);
    expect(html.match(/Ref\. Frente al parque/g)).toHaveLength(2);
    expect(html).not.toMatch(/class="truncate[^"]*">Av\./);
  });
  it("sin dirección lo dice y conserva el distrito; sin referencia no deja la línea", () => {
    const html = renderToStaticMarkup(createElement(LimaPendingList, { rows: [row({ address: null, reference: null, district: "Ate" })], reproRows: [], today: TODAY, renderActions: () => null }));
    expect(html).toContain("Sin dirección · Ate");
    expect(html).not.toContain("Ref.");
  });
});

describe("Reintentos Aliclik: elegir cuáles aprobar (owner, 06-11-2026)", () => {
  const listos = [row({ orderId: "a", orderName: "#KPA" }), row({ orderId: "b", orderName: "#KPB" }), row({ orderId: "c", orderName: "#KPC" })];
  it("con marcados aprueba esos; sin marcar, todos los listos; un marcado que ya no está listo no cuenta", () => {
    expect(retryApprovalTargets(listos, new Set())).toEqual({ rows: listos, picked: false });
    expect(retryApprovalTargets(listos, new Set(["c", "a"])).rows.map((r) => r.orderId)).toEqual(["a", "c"]);
    expect(retryApprovalTargets(listos, new Set(["c", "a"])).picked).toBe(true);
    expect(retryApprovalTargets(listos, new Set(["zz"]))).toEqual({ rows: listos, picked: false });
  });
  it("la lista pone casilla solo en lo que se puede aprobar, y arriba la de todos los listos", () => {
    const rows = [...listos, row({ orderId: "d", orderName: "#KPD" })];
    const selection = { selectable: (r: LimaPendingOrder) => r.orderId !== "d", selected: new Set(["b"]), onToggle: () => {}, onToggleAll: () => {} };
    const html = renderToStaticMarkup(createElement(LimaPendingList, { rows, reproRows: [], today: TODAY, renderActions: () => null, selection }));
    // Tabla y lista del teléfono: dos casillas por pedido aprobable.
    for (const name of ["#KPA", "#KPB", "#KPC"]) expect(html.match(new RegExp(`aria-label="Elegir ${name} para aprobar"`, "g"))).toHaveLength(2);
    expect(html).not.toContain("Elegir #KPD para aprobar");
    expect(html).toContain('aria-label="Elegir los 3 listos para aprobar"');
    // En el teléfono, la misma casilla de todos sobre la lista.
    expect(html).toContain("Elegir los 3 listos</label>");
    expect(html.match(/aria-label="Elegir #KPB para aprobar" checked=""/g)).toHaveLength(2);
    expect(html).not.toMatch(/aria-label="Elegir #KPA para aprobar" checked=""/);
    // Sin selección (las demás listas) no hay casillas.
    expect(renderToStaticMarkup(createElement(LimaPendingList, { rows, reproRows: [], today: TODAY, renderActions: () => null }))).not.toContain('type="checkbox"');
  });
  it("el tablero solo elige en Reintentos Aliclik y el botón dice cuántos aprueba", () => {
    const board = readFileSync(resolve(process.cwd(), "components/repro-lima-board.tsx"), "utf8");
    expect(board).toContain('const selection: LimaRowSelection | undefined = list === "reintentos_aliclik"');
    expect(board).toContain("const rows = targets.rows;");
    expect(board).toContain("`Aprobar elegidos (${targets.rows.length})`");
    expect(board).toContain("`Aprobar todos los listos (${readyToApprove.length})`");
    expect(board).toContain("setPicked(new Set());");
  });
});

describe("«Sale a reparto» en Repro Lima (owner, 07-11-2026; §29.16)", () => {
  const gf = (over: Record<string, unknown> = {}) => ({ box: null, requestDay: null, labeled: true, armed: true, ...over });
  it("el día: la caja, el acuerdo o programa, la solicitud y, sin nada, el corte", () => {
    expect(limaPlanCandidate(row({ gf: gf() }), undefined, "2026-11-07")).toMatchObject({ day: "2026-11-07", box: null });
    expect(limaPlanCandidate(row({ gf: gf(), programmedFor: "2026-11-09" }), undefined, "2026-11-07")?.day).toBe("2026-11-09");
    expect(limaPlanCandidate(row({ gf: gf({ requestDay: "2026-11-06" }) }), undefined, "2026-11-07")?.day).toBe("2026-11-06");
    const acuerdo = { orderId: "o1", list: "programados" as const, agreement: { agreedOn: "2026-11-10", courier: "propio" } };
    expect(limaPlanCandidate(row({ gf: gf(), programmedFor: "2026-11-09" }), acuerdo, "2026-11-07")?.day).toBe("2026-11-10");
    // Un acuerdo con otro courier no sale con Grupo GF; sin datos de Grupo GF, tampoco.
    expect(limaPlanCandidate(row({ gf: gf() }), { ...acuerdo, agreement: { agreedOn: "2026-11-07", courier: "aliclik" } }, "2026-11-07")).toBeNull();
    expect(limaPlanCandidate(row({ gf: null }), undefined, "2026-11-07")).toBeNull();
    // Un reintento sin acuerdo ni programa no toma el día del corte.
    expect(limaPlanCandidate(row({ stage: "en_curso", substage: "por_reprogramar_lima", gf: gf() }), undefined, "2026-11-07")?.day).toBeNull();
  });
  it("el tablero muestra la tarjeta y, en cada pedido que sale, el día y lo que le falta", () => {
    const data = { today: "2026-11-06", nowIso: "2026-11-06T23:00:00Z", cutoffLabel: "12:00", stores: [{ id: "a", name: "Kenku" }], rows: [], me: "u" } as unknown as ReproLimaData;
    const pending = [
      row({ orderId: "a", orderName: "#KPA", stage: "por_despachar", substage: "listo_para_asignar", gf: gf() }),
      row({ orderId: "b", orderName: "#KPB", gf: gf({ box: { day: "2026-11-07", riderName: "Jhon", officeChecked: false, pickedUp: false } }) }),
      row({ orderId: "c", orderName: "#KPC", gf: gf({ labeled: false, armed: false }) }),
      row({ orderId: "d", orderName: "#KPD", gf: null }),
    ];
    nav.search = "";
    const html = renderToStaticMarkup(createElement(ReproLimaBoard, { data, pending }));
    // Las 18:00 de Lima: pasó el corte, la tarjeta abre en mañana.
    expect(html).toContain("Sale a reparto");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Mañana · sáb 07\/11<\/button>/);
    expect(html).toContain("Faltan 1 sin rótulo y 1 sin caja.");
    expect(html).toContain("Sale sáb 07/11 · sin caja");
    expect(html).toContain("Sale sáb 07/11 · en caja · caja de Jhon");
    expect(html).toContain("Sale sáb 07/11 · sin rótulo");
    expect(html.match(/Sale sáb 07\/11 ·/g)?.length).toBe(6); // tres pedidos, en la tabla y en la lista del teléfono
  });
  it("sábado después del corte: lo del domingo sale el lunes sin estar atrasado; el domingo solo se ofrece el lunes", () => {
    const sat = { today: "2026-11-07", nowIso: "2026-11-07T20:00:00Z", cutoffLabel: "12:00", stores: [{ id: "a", name: "Kenku" }], rows: [], me: "u" } as unknown as ReproLimaData;
    const pending = [
      row({ orderId: "a", orderName: "#KPA", stage: "por_despachar", substage: "listo_para_asignar", gf: gf() }),
      // Su solicitud era para el viernes y no salió: sí está atrasado.
      row({ orderId: "b", orderName: "#KPB", stage: "por_despachar", substage: "listo_para_asignar", gf: gf({ requestDay: "2026-11-06" }) }),
      // Programado para el lunes, todavía con el motorizado en la caja del 04/11.
      row({ orderId: "c", orderName: "#KPC", stage: "en_curso", substage: "por_reprogramar_lima", programmedFor: "2026-11-09", gf: gf({ awaitingOffice: true }) }),
    ];
    nav.search = "";
    const html = renderToStaticMarkup(createElement(ReproLimaBoard, { data: sat, pending }));
    expect(html).toMatch(/aria-pressed="true"[^>]*>Próximo reparto · lun 09\/11<\/button>/);
    expect(html).toContain("Faltan 3 sin caja.");
    expect(html).toContain("1 debía salir antes.");
    expect(html).not.toContain("debía salir dom");
    expect(html).toContain("Sale lun 09/11 · sin caja · debía salir vie 06/11");
    expect(html).toContain("Sale lun 09/11 · sin caja · por recibir en oficina");
    const sun = renderToStaticMarkup(createElement(ReproLimaBoard, { data: { ...sat, today: "2026-11-08", nowIso: "2026-11-08T15:00:00Z" }, pending }));
    expect(sun).toMatch(/aria-pressed="true"[^>]*>Mañana · lun 09\/11<\/button>/);
    expect(sun).not.toContain(">Hoy · dom 08/11<");
  });
});
