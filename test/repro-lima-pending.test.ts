import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadLimaPending } from "@/lib/repro-lima-pending-access";
import { pendingFilters, pendingGroup, pendingKey, pendingMatches, togglePendingKeys, type LimaPendingOrder } from "@/lib/repro-lima-pending";
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
  courier: null, dispatchedAt: null, attempts: 0, ...overrides,
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
function database(source: DBRow[], fail = false) {
  const pages: number[] = [];
  const from = vi.fn((table: string) => {
    const filters: Array<(r: DBRow) => boolean> = [];
    let range: [number, number] | null = null;
    const q = {
      select: () => q,
      in: (key: string, values: unknown[]) => { filters.push((r) => values.includes(r[key])); return q; },
      eq: (key: string, value: unknown) => { filters.push((r) => r[key] === value); return q; },
      order: () => q,
      range: (a: number, b: number) => { range = [a, b]; pages.push(a); return q; },
      then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const rows = (table === "stores" ? [{ id: "a", name: "Kenku" }] : source).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: fail && table === "order_master" ? { message: "sin conexión" } : null }).then(resolve, reject);
      },
    };
    return q;
  });
  return { admin: { from } as unknown as Admin, pages, from };
}
describe("acceso a todos los pendientes", () => {
  it("carga más de 1383 filas y solo las tiendas/cobertura/etapas autorizadas", async () => {
    const db = database([...Array.from({ length: 1383 }, (_, i) => master(i)),
      master(2000, { store_id: "fuera" }), master(2001, { coverage: "provincia_cod" }),
      master(2002, { macro_stage: "por_cerrar" }), master(2003, { macro_stage: "finalizado" }),
      master(2004, { macro_stage: "en_curso", macro_substage: "en_transito", current_courier: "tanders" }),
    ]);
    const rows = await loadLimaPending(db.admin, { userId: "u", storeIds: new Set(["a"]) });
    expect(rows).toHaveLength(1384);
    expect(db.pages).toEqual([0, 500, 1000]);
    expect(rows.at(-1)?.substage).toBe("en_transito");
    expect(rows[0]?.orderTotal).toBe(149);
    expect(new Set(db.from.mock.calls.map(([table]) => table))).toEqual(new Set(["stores", "order_master"]));
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
  it("entra en Todos con filas reales aunque no haya RPC del resumen", () => {
    nav.search = "";
    const html = renderToStaticMarkup(createElement(ReproLimaBoard, { data, pending: [row()] }));
    expect(html).toContain('aria-label="Todos los pendientes de Lima"');
    expect(html).toContain("#KP1");
    expect(html).toContain("Gestionar pedido");
    expect(html).toContain("Todos activos al entrar.");
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
  it("los filtros son casillas nativas, agrupadas y todas marcadas inicialmente", () => {
    const html = renderToStaticMarkup(createElement(LimaPendingFilters, { rows: [row()], hidden: new Set<string>(), onToggle: () => {}, onReset: () => {} }));
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Subetapas de Preparación"');
  });
});
