import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadLimaPending } from "@/lib/repro-lima-pending-access";
import { attentionCounts, attentionFilter, attentionRows, limaQueueSegment, limaScheduledFor, pendingFilters, pendingGroup, pendingKey, pendingMatches, togglePendingKeys, type LimaPendingOrder } from "@/lib/repro-lima-pending";
import { LimaPendingFilters, LimaPendingList } from "@/components/repro-lima-pending";
import { ReproLimaBoard } from "@/components/repro-lima-board";
import type { ReproLimaData } from "@/lib/repro-lima-access";

vi.mock("@/app/dashboard/pedidos/repro-lima/actions", () => ({}));
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
  courier: null, dispatchedAt: null, attempts: 0, hasPriorDispatch: false, lastDepartureAt: null, programmedFor: null, ...overrides,
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
function database(source: DBRow[], fail = false, opts: { programs?: DBRow[]; departures?: DBRow[]; rpcError?: string; programError?: string } = {}) {
  const pages: number[] = [];
  const ranges: Array<{ table: string; from: number }> = [];
  const from = vi.fn((table: string) => {
    const filters: Array<(r: DBRow) => boolean> = [];
    let range: [number, number] | null = null;
    const q = {
      select: () => q,
      in: (key: string, values: unknown[]) => { filters.push((r) => values.includes(r[key])); return q; },
      eq: (key: string, value: unknown) => { filters.push((r) => r[key] === value); return q; },
      order: () => q,
      range: (a: number, b: number) => { range = [a, b]; if (table === "order_master") pages.push(a); ranges.push({ table, from: a }); return q; },
      then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const rows = (table === "stores" ? [{ id: "a", name: "Kenku" }] : table === "gf_dispatch_programs" ? opts.programs ?? [] : source).filter((r) => filters.every((f) => f(r)));
        const error = fail && table === "order_master" ? { message: "sin conexión" } : table === "gf_dispatch_programs" && opts.programError ? { message: opts.programError } : null;
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
    expect(new Set(db.from.mock.calls.map(([table]) => table))).toEqual(new Set(["stores", "order_master", "gf_dispatch_programs"]));
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
    expect(counts).toEqual({ todos: 9, reprogramados: 1, programados_hoy: 2, programados_manana: 2, nunca_salieron: 2, ya_salieron: 1, mas_de_30: 1, programados_despues: 1, llamar_despues: 0, cerrados: 0 });
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
