// Auditoría del atraso de Lima (14-10-2026): la Mesa de cierre y el lote del
// Master, EJECUTADOS. test/pedidos-closure-source.test.ts comprueba que el
// código nombra las reglas; aquí se corre lo que hace con ellas, porque tres
// cambios dejaban esas pruebas en verde rompiendo la regla:
//
//   (a) decidir la conciliación con el costo GUARDADO antes que con el
//       recalculado: volvería a conciliar con el S/ 0 viejo de una tarifa
//       ausente, que es el error que se corrigió (MOM §14);
//   (b) mover el salto del lote detrás de `setOrderStatus`: marcaría entregado
//       un pedido con una observación de cuadre abierta (MOM §30.8);
//   (c) que la Mesa mire solo «Pendiente de liquidación»: dejaría de avisar de
//       la tarifa que falta en «Liquidación observada».
//
// La base es de mentira y en memoria; registra cada escritura. `setOrderStatus`
// vive en el mismo módulo que el lote, así que no se espía: se mira lo escrito.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  fail: new Set<string>(),
  writes: [] as { table: string; op: string; value: Record<string, unknown> | null }[],
}));
const om = vi.hoisted(() => ({ fresh: vi.fn(), recompute: vi.fn(async () => {}) }));
const perms = vi.hoisted(() => ({ granted: new Set<string>() }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    let op = "read";
    let value: Record<string, unknown> | null = null;
    let single = false;
    let head = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {};
    q.select = (_cols?: string, opts?: { head?: boolean }) => {
      if (opts?.head) head = true;
      return q;
    };
    q.eq = (key: string, val: unknown) => (filters.push((r) => r[key] === val), q);
    q.neq = (key: string, val: unknown) => (filters.push((r) => r[key] !== val), q);
    q.in = (key: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[key])), q);
    q.is = (key: string, val: unknown) => (filters.push((r) => (r[key] ?? null) === val), q);
    for (const m of ["not", "or", "order", "limit", "range", "gte", "lte", "lt", "gt", "contains"]) q[m] = () => q;
    q.maybeSingle = q.single = () => ((single = true), q);
    for (const m of ["insert", "update", "upsert", "delete"]) {
      q[m] = (val?: Record<string, unknown>) => ((op = m), (value = val ?? null), q);
    }
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      let result: { data: unknown; error: { message: string } | null; count?: number | null };
      if (op === "read" && db.fail.has(table)) {
        result = { data: null, error: { message: "lectura caída" }, count: null };
      } else if (op !== "read") {
        db.writes.push({ table, op, value });
        result = { data: null, error: null };
      } else {
        const rows = (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        result = { data: head ? null : single ? rows[0] ?? null : rows, error: null, count: rows.length };
      }
      return Promise.resolve(result).then(ok, ko);
    };
    return q;
  };
  const client = {
    from,
    auth: { getUser: async () => ({ data: { user: { id: "yohalis" } }, error: null }) },
    rpc: async () => ({ data: null, error: null }),
  };
  return { createServerSupabase: async () => client, createAdminSupabase: () => client };
});
vi.mock("@/lib/access", async (orig) => ({
  ...(await orig<typeof import("@/lib/access")>()),
  getCurrentUser: async () => ({ id: "yohalis" }),
}));
vi.mock("@/lib/permissions-access", async (orig) => ({
  ...(await orig<typeof import("@/lib/permissions-access")>()),
  getMasterPermissions: async () => ({
    roles: [],
    permissions: perms.granted,
    readOnly: false,
    can: (p: string) => perms.granted.has(p),
  }),
  hasOrgPermission: async (_org: string, p: string) => perms.granted.has(p),
}));
vi.mock("@/lib/order-master", async (orig) => ({
  ...(await orig<typeof import("@/lib/order-master")>()),
  freshLogisticsCost: om.fresh,
  recomputeOrderMasterSafe: om.recompute,
}));

import { applyOrderStatusBulk, registerClosureAction } from "@/app/dashboard/pedidos/actions";
import { OrderClosureDesk } from "@/components/order-closure-desk";
import { OPEN_OBSERVATION_SKIP_REASON } from "@/lib/bulk-status-guard";
import { gfRouteReportHref, liquidationCostBlock } from "@/lib/closure-blocks";
import type { LogisticsCostSnapshot } from "@/lib/order-master";
import type { MacroSubstage } from "@/lib/order-macro-stage";
import type { ShipmentRow } from "@/lib/types";

const events = () => db.writes.filter((w) => w.table === "order_events" && w.op === "insert").map((w) => w.value!);

beforeEach(() => {
  db.tables = {};
  db.fail = new Set();
  db.writes = [];
  om.fresh.mockReset();
  om.recompute.mockClear();
  perms.granted = new Set();
});

// ---------------------------------------------------------------------------
// (a) «Conciliar liquidación» decide con el costo recalculado
// ---------------------------------------------------------------------------

describe("(a) registerClosureAction(«liquidation_close») decide con el costo de ahora", () => {
  // Grupo GF entregado: la fila guarda el S/ 0 que el Master escribía con la
  // tarifa ausente. Con la guarda vieja (`logistics_cost == null`) se conciliaba.
  const ROW = {
    order_id: "o-1",
    store_id: "store",
    order_name: "#KP137000",
    general_status: "entregado",
    operational_status: "entregado",
    coverage: "lima",
    district: "Ate",
    current_courier: "propio",
    logistics_cost: 0,
    macro_stage: "por_cerrar",
    macro_reasons: ["pendiente_liquidacion"],
    last_movement_at: "2026-10-02T15:00:00Z",
    order_created_at: "2026-09-30T10:00:00Z",
  };
  const input = { action: "liquidation_close" as const, note: "Cuadró con el depósito del motorizado" };
  const missing: LogisticsCostSnapshot = {
    cost: null,
    missing: ["primer_intento"],
    courier: "propio",
    district: "Ate",
    day: "2026-10-02",
  };

  beforeEach(() => {
    db.tables = { order_master: [ROW], shipments: [], order_events: [], orders: [{ id: "o-1", cancelled_at: null }] };
    perms.granted = new Set(["closure.finance"]);
  });

  it("sin tarifa ahora, se niega aunque la fila guarde S/ 0, y no escribe nada", async () => {
    om.fresh.mockResolvedValue(missing);
    const result = await registerClosureAction("o-1", input);
    expect(om.fresh).toHaveBeenCalledWith(expect.anything(), "o-1");
    // Grupo GF (mom-v1.31): la tarifa es de su Tarifario. Sin `logistics.manage`,
    // le dice a quién pedírsela, con el día del pedido.
    expect(result.error).toBe(liquidationCostBlock({ ...missing, canManageCosts: false, canManageLogistics: false }));
    expect(result.error).toContain("Pídele a quien administra Grupo GF («Administrar Grupo GF»)");
    expect(result.error).toContain("Grupo GF Courier › Tarifario, vigente desde el 02-10-2026 o antes");
    expect(result.error).not.toContain("Costos › Costos logísticos");
    expect(events()).toEqual([]);
    expect(om.recompute).not.toHaveBeenCalled();
  });

  it("quien administra Grupo GF recibe «Cárgala» en el Tarifario; Costos no le basta", async () => {
    perms.granted.add("costs.manage");
    om.fresh.mockResolvedValue(missing);
    const costsOnly = await registerClosureAction("o-1", input);
    expect(costsOnly.error).toContain("Pídele a quien administra Grupo GF");
    perms.granted.add("logistics.manage");
    const result = await registerClosureAction("o-1", input);
    expect(result.error).toBe(liquidationCostBlock({ ...missing, canManageCosts: true, canManageLogistics: true }));
    expect(result.error).toContain("Cárgala en Grupo GF Courier › Tarifario");
  });

  it("antes de la vigencia del Tarifario lo dice con la fecha que traen los datos", async () => {
    perms.granted.add("logistics.manage");
    om.fresh.mockResolvedValue({
      ...missing,
      day: "2026-08-20",
      tarifario: { reason: "antes_de_vigencia", since: "2026-08-31" },
    } satisfies LogisticsCostSnapshot);
    const result = await registerClosureAction("o-1", input);
    expect(result.error).toContain("la de ese distrito rige desde el 31-08-2026");
    expect(result.error).toContain("del 20-08-2026");
    expect(result.error).not.toContain("Cárgala");
    expect(events()).toEqual([]);
  });

  it("otro courier sigue mandando a Costos › Costos logísticos", async () => {
    perms.granted.add("costs.manage");
    om.fresh.mockResolvedValue({ ...missing, courier: "urpi" });
    const result = await registerClosureAction("o-1", input);
    expect(result.error).toContain("Cárgala en Costos › Costos logísticos (courier «urpi»)");
  });

  it("con la tarifa ya cargada, concilia aunque la fila todavía no la tenga", async () => {
    db.tables.order_master = [{ ...ROW, logistics_cost: null }];
    om.fresh.mockResolvedValue({ ...missing, cost: 12, missing: [] });
    const result = await registerClosureAction("o-1", input);
    expect(result.error).toBeUndefined();
    expect(result.notice).toContain("Acción de cierre registrada");
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ order_id: "o-1", kind: "liquidation_closed" });
  });

  it("si no puede recalcular, lo dice y no concilia", async () => {
    om.fresh.mockRejectedValue(new Error("timeout"));
    const result = await registerClosureAction("o-1", input);
    expect(result.error).toBe("No se pudo recalcular el costo logístico (timeout). Vuelve a intentarlo.");
    expect(events()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Finalizar con la ruta de Grupo GF abierta y el pedido anulado en Shopify
// ---------------------------------------------------------------------------

describe("registerClosureAction(«finalize») con la ruta de Grupo GF abierta", () => {
  // #KP137541: anulado en Shopify el 05/10, salida propia pendiente y su parada
  // entregada en la ruta del 01/10, todavía en curso.
  const ROW = {
    order_id: "o-2",
    store_id: "store",
    order_name: "#KP137541",
    general_status: "anulado",
    operational_status: null,
    coverage: "lima",
    macro_stage: "por_cerrar",
    macro_reasons: ["validacion_cierre_pendiente"],
  };
  const tables = (cancelledAt: string | null) => ({
    order_master: [ROW],
    orders: [{ id: "o-2", cancelled_at: cancelledAt }],
    order_events: [],
    shipments: [
      { id: "s1", order_id: "o-2", courier: "propio", guide_code: "KP137541-S01", delivery_status: "pendiente", custody_state: "courier", returned_at: null },
    ],
    delivery_stops: [
      {
        id: "st-1",
        order_id: "o-2",
        route_id: "00bd7063",
        shipment_id: "s1",
        status: "entregado",
        reported_at: "2026-10-01T20:00:00Z",
        delivery_routes: { route_date: "2026-10-01", status: "en_curso" },
      },
    ],
  });
  const input = { action: "finalize" as const, note: "Revisado con el motorizado" };

  beforeEach(() => {
    perms.granted = new Set(["closure.finalize"]);
  });

  it("anulado en Shopify: no promete que cerrar la ruta lo pase a entregado", async () => {
    db.tables = tables("2026-10-05T17:45:00Z");
    const result = await registerClosureAction("o-2", input);
    expect(result.error).toContain("está anulado en Shopify");
    expect(result.error).toContain("no lo marca entregado");
    expect(result.error).not.toContain("pasa a entregado");
    expect(events()).toEqual([]);
  });

  it("sin anulación en Shopify, «Termina la ruta»: al cerrarla pasa a entregado", async () => {
    db.tables = tables(null);
    const result = await registerClosureAction("o-2", input);
    expect(result.error).toContain("Termina la ruta en Grupo GF Courier › Rutas › «Reparto y liquidación»");
    expect(result.error).toContain("pasa a entregado");
  });
});

// ---------------------------------------------------------------------------
// (b) el lote a «entregado» no toca los pedidos con observación abierta
// ---------------------------------------------------------------------------

describe("(b) applyOrderStatusBulk a entregado salta la observación de cuadre abierta", () => {
  const order = (id: string) => ({
    order_id: id,
    store_id: "store",
    order_name: `#KP${id}`,
    general_status: "en_proceso",
    operational_status: "en_ruta",
    coverage: "lima",
  });

  beforeEach(() => {
    perms.granted = new Set(["master.edit", "master.set_status"]);
    db.tables = {
      order_master: [order("a"), order("b")],
      // «Registrar estado a mano» se decide por la organización de la tienda.
      stores: [{ id: "store", org_id: "org" }],
      sheet_observations: [{ id: "obs-1", order_id: "b", status: "abierta" }],
      shipments: [],
      order_events: [],
    };
  });

  it("marca el que no tiene observación y no escribe nada del que la tiene", async () => {
    const result = await applyOrderStatusBulk(["a", "b"], { general: "entregado" });
    expect(result.applied).toEqual(["a"]);
    expect(result.skipped).toEqual(["b"]);
    expect(result.failed[0]).toEqual({ orderId: "b", error: OPEN_OBSERVATION_SKIP_REASON });
    expect(events().map((e) => e.order_id)).toEqual(["a"]);
    expect(events()[0]).toMatchObject({ kind: "status_override", new_status: "entregado" });
    expect(db.writes.some((w) => w.value && (w.value as { order_id?: string }).order_id === "b")).toBe(false);
  });

  it("si no puede leer las observaciones, no aplica nada", async () => {
    db.fail.add("sheet_observations");
    const result = await applyOrderStatusBulk(["a", "b"], { general: "entregado" });
    expect(result.applied).toEqual([]);
    expect(result.error).toContain("No se pudieron leer las observaciones de cuadre (lectura caída)");
    expect(db.writes).toEqual([]);
  });

  it("hacia otro estado no salta ninguno", async () => {
    const result = await applyOrderStatusBulk(["a", "b"], { general: "pendiente" });
    expect(result.applied).toEqual(["a", "b"]);
    expect(events().map((e) => e.order_id)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// (c) la Mesa, pintada
// ---------------------------------------------------------------------------

describe("(c) la Mesa de cierre, pintada", () => {
  const ALL = {
    canReturn: true,
    canInventory: true,
    canFinance: true,
    canFinalize: true,
    canRefund: true,
    canReopen: true,
    canManageCosts: true,
    canManageLogistics: true,
  };
  const guide = (over: Record<string, unknown> = {}) =>
    ({ id: "s1", courier: "propio", guide_code: "KP1-S01", output_code: "KP1-S01", delivery_status: "pendiente", custody_state: "courier", returned_at: null, ...over }) as unknown as ShipmentRow;
  const paint = (props: Partial<Parameters<typeof OrderClosureDesk>[0]>) =>
    renderToStaticMarkup(
      createElement(OrderClosureDesk, {
        stage: "por_cerrar",
        reasons: ["validacion_cierre_pendiente"] as MacroSubstage[],
        generalStatus: "en_proceso",
        guides: [guide()],
        permissions: ALL,
        pending: false,
        onAction: async () => true,
        ...props,
      }),
    );
  const stop = (routeStatus: string) => [{ shipmentId: "s1", stop: { status: "entregado", routeStatus, routeId: "r-1" } }];

  it("con la ruta de Grupo GF abierta no ofrece «Finalizar expediente» y enlaza su reparto", () => {
    const html = paint({ gfDeliveries: stop("en_curso") });
    expect(html).not.toContain("Finalizar expediente");
    expect(html).toContain('data-closure-block="ruta-gf-abierta"');
    expect(html).toContain(`href="${gfRouteReportHref("r-1")}"`);
    expect(html).toContain("al cerrarla, el pedido pasa a entregado");
  });

  it("con la ruta cerrada vuelve «Finalizar expediente»", () => {
    const html = paint({ gfDeliveries: stop("cerrada") });
    expect(html).toContain("Finalizar expediente");
    expect(html).not.toContain("data-closure-block");
  });

  it("anulado en Shopify: sin «Finalizar», y sin prometer que cerrar la ruta lo pase a entregado", () => {
    const html = paint({ gfDeliveries: stop("en_curso"), generalStatus: "anulado", cancelledInShopify: true });
    expect(html).not.toContain("Finalizar expediente");
    expect(html).toContain('data-closure-block="ruta-gf-anulado-shopify"');
    expect(html).not.toContain("pasa a entregado");
    expect(html).toContain("no lo marca entregado");
    expect(html).toContain(`href="${gfRouteReportHref("r-1")}"`);
  });

  const urpi = {
    logistics_cost: null,
    general_status: "entregado",
    current_courier: "urpi",
    district: "Ate",
    last_movement_at: "2026-10-03T15:00:00Z",
    order_created_at: "2026-09-28T10:00:00Z",
  };

  it("en «Liquidación observada» también avisa de la tarifa, con el día, y deja conciliar", () => {
    const html = paint({ reasons: ["liquidacion_observada"] as MacroSubstage[], generalStatus: "entregado", row: urpi });
    expect(html).toContain('data-closure-block="tarifa-faltante"');
    expect(html).toContain("vigente desde el 03-10-2026 o antes");
    expect(html).toContain("Conciliar liquidación");
    expect(html).toContain("Abrir Costos logísticos");
  });

  it("sin permiso de Costos no enseña el enlace y dice a quién pedírsela", () => {
    const html = paint({
      reasons: ["pendiente_liquidacion"] as MacroSubstage[],
      generalStatus: "entregado",
      row: urpi,
      permissions: { ...ALL, canManageCosts: false },
    });
    expect(html).toContain("Pídele a quien administra Costos");
    expect(html).not.toContain("Abrir Costos logísticos");
  });

  it("con la caja «por definir» y sin «Salió con», no manda a cargar una tarifa", () => {
    const html = paint({
      reasons: ["pendiente_liquidacion"] as MacroSubstage[],
      generalStatus: "entregado",
      row: { ...urpi, current_courier: "por_definir", dispatched_with: [] },
    });
    expect(html).toContain("la salida sigue «Por definir»");
    expect(html).not.toContain("Abrir Costos logísticos");
    expect(html).not.toContain("courier «por_definir»");
  });

  it("con la caja «por definir» y «Salió con» Grupo GF, la tarifa que falta es la de su Tarifario", () => {
    const html = paint({
      reasons: ["pendiente_liquidacion"] as MacroSubstage[],
      generalStatus: "entregado",
      row: { ...urpi, current_courier: "por_definir", dispatched_with: ["gf:Roy"] },
    });
    expect(html).toContain("Falta la tarifa de Grupo GF para Ate");
    expect(html).toContain("Grupo GF Courier › Tarifario, vigente desde el 03-10-2026 o antes");
    expect(html).toContain('href="/dashboard/courier?tab=tariffs"');
    expect(html).toContain("Abrir Tarifario");
    expect(html).not.toContain("Abrir Costos logísticos");
    expect(html).not.toContain("(courier «propio»)");
  });

  it("Grupo GF sin `logistics.manage`: dice a quién pedírsela y no enseña el Tarifario", () => {
    const html = paint({
      reasons: ["pendiente_liquidacion"] as MacroSubstage[],
      generalStatus: "entregado",
      row: { ...urpi, current_courier: "propio" },
      permissions: { ...ALL, canManageLogistics: false },
    });
    expect(html).toContain("Pídele a quien administra Grupo GF («Administrar Grupo GF»)");
    expect(html).not.toContain("Abrir Tarifario");
  });

  it("Grupo GF antes de la vigencia: la Mesa lo dice antes del clic, con la fecha, y no manda a cargarla", () => {
    const html = paint({
      reasons: ["pendiente_liquidacion"] as MacroSubstage[],
      generalStatus: "entregado",
      row: { ...urpi, current_courier: "propio", last_movement_at: "2026-08-20T15:00:00Z" },
      costTariffGap: { reason: "antes_de_vigencia", since: "2026-08-31" },
    });
    expect(html).toContain("rige desde el 31-08-2026");
    expect(html).not.toContain("Abrir Tarifario");
    expect(html).not.toContain("Cárgala");
  });

  it("Grupo GF con la tarifa ya en el Tarifario y la fila vieja: lo dice y no manda a cargar otra", () => {
    const html = paint({
      reasons: ["pendiente_liquidacion"] as MacroSubstage[],
      generalStatus: "entregado",
      row: { ...urpi, current_courier: "propio" },
      costTariffGap: { reason: "vigente", since: null },
    });
    expect(html).toContain("Grupo GF Courier › Tarifario ya tiene la tarifa de Grupo GF para Ate");
    expect(html).not.toContain("Abrir Tarifario");
    expect(html).not.toContain("Cárgala");
  });
});
