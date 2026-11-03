import { describe, expect, it, vi } from "vitest";
import { applyUrpiCancellationsFor, urpiCancelMessage } from "@/lib/urpi-report-apply";

const recomputed: string[] = [];
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn(async (_admin: unknown, ids: string[]) => { recomputed.push(...ids); }) }));

// Decisión del owner (03-11-2026, MOM §30.11): lo que Urpi cancela pasa a «Por
// reprogramar Lima». Decide el ÚLTIMO intento, y solo con el pedido abierto.

function fakeAdmin(tables: Record<string, Record<string, any>[]>) {
  const events: any[] = [];
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = [];
    let patch: any = null, insert: any = null, single = false;
    const q: any = {
      select: () => q,
      eq: (k: string, v: any) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, vs: any[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      update: (p: any) => { patch = p; return q; },
      insert: (row: any) => { insert = row; return q; },
      maybeSingle: () => { single = true; return q; },
      then: (resolve: any) => {
        if (insert) { events.push(insert); return Promise.resolve({ data: null, error: null }).then(resolve); }
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (patch) rows.forEach((r) => Object.assign(r, patch));
        return Promise.resolve({ data: single ? rows[0] ?? null : rows.map((r) => ({ ...r })), error: null }).then(resolve);
      },
    };
    return q;
  };
  return { admin: { from } as any, events };
}

const salida = (orderId: string, id: string) => ({
  id, order_id: orderId, store_id: "kenku", guide_code: null, courier: "urpi", created_via: "urpi_programacion", delivery_status: "en_ruta",
  custody_state: "empresa", custody_transferred_at: null, returned_at: null, output_number: 1, dispatched_at: "2026-11-02T17:00:00.000Z", closed_at: null,
});
const order = (id: string, over: Record<string, any> = {}) => ({ order_id: id, store_id: "kenku", general_status: "en_proceso", orders: { cancelled_at: null }, ...over });
const attempt = (urpi_row: number, order_id: string, result_code: string, report_date = "2026-11-02") => ({ org_id: "org", urpi_row, order_id, result_code, report_date, reason: "No contesta" });

describe("aplicar los cancelados de Urpi", () => {
  it("solo el último intento cancelado, con el pedido abierto y de una tienda visible", async () => {
    recomputed.length = 0;
    const shipments = ["o1", "o2", "o3", "o4", "o5"].map((id, i) => salida(id, `0000000${i}-0000-4000-8000-000000000000`));
    const { admin, events } = fakeAdmin({
      urpi_report_rows: [
        attempt(1, "o1", "cancelado"),
        attempt(2, "o2", "cancelado", "2026-11-01"), attempt(3, "o2", "reprogramado"),
        attempt(4, "o3", "cancelado"),
        attempt(5, "o4", "cancelado"),
        attempt(6, "o5", "cancelado"),
      ],
      order_master: [order("o1"), order("o2"), order("o3", { orders: { cancelled_at: "2026-11-02T10:00:00Z" } }), order("o4", { general_status: "entregado" }), order("o5", { store_id: "aurela" })],
      shipments,
    });
    const result = await applyUrpiCancellationsFor(admin, { orgId: "org", visibleStoreIds: new Set(["kenku"]), orderIds: ["o1", "o2", "o3", "o4", "o5"] });
    expect(result).toEqual({ cancelled: ["o1"], errors: [] });
    expect(shipments.map((s) => s.delivery_status)).toEqual(["anulado", "en_ruta", "en_ruta", "en_ruta", "en_ruta"]);
    expect(events).toHaveLength(1);
    expect(recomputed).toEqual(["o1"]);
    expect(urpiCancelMessage(result)).toBe("Cancelados por Urpi: 1 pedido(s) pasaron a «Por reprogramar Lima».");
    expect(urpiCancelMessage({ cancelled: [], errors: [] })).toBe("");
  });
  it("sin salida de Urpi no hay nada que anular: el cancelado solo se lista", async () => {
    const { admin } = fakeAdmin({ urpi_report_rows: [attempt(1, "o1", "cancelado")], order_master: [order("o1")], shipments: [] });
    expect(await applyUrpiCancellationsFor(admin, { visibleStoreIds: null, orderIds: ["o1"] })).toEqual({ cancelled: [], errors: [] });
  });
});

describe("el MOM cita lo que hace el código (§30.11, §9)", () => {
  it("el cancelado de Urpi anula su salida en ruta y lo dice", async () => {
    const { readFileSync } = await import("node:fs");
    const mom = readFileSync("docs/mom/master-pedidos-v1.md", "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("**El cancelado de Urpi pasa a «Por reprogramar Lima» (decisión del owner, 03-11-2026).**");
    expect(mom).toContain("(`cancelUrpiSalidas`, `lib/urpi-salida.ts`; `applyUrpiCancellationsFor`, `lib/urpi-report-apply.ts`)");
    expect(mom).toContain("esa salida pasa a `anulado` (`status_category = closed`, `closed_at` el mediodía de Lima del día del reporte)");
  });
});
