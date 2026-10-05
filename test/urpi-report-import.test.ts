import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, any>[]>,
  rpcs: [] as { name: string; args: any }[],
  inserts: [] as { table: string; row: any }[],
  denied: "" as "" | "sheets.edit" | "master.edit",
  visible: ["kenku", "aurela"] as string[],
  doors: [] as any[],
}));

// Doble de Supabase que aplica filtros de verdad: un filtro mal puesto
// (otra organización, otra tienda) cambiaría el resultado de la prueba.
function fakeAdmin() {
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = [];
    let insert: any = null;
    let single = false;
    let start = 0, end = Infinity;
    const q: any = {
      select: () => q,
      eq: (k: string, v: any) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, vs: any[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      order: () => q,
      limit: (n: number) => { end = n; return q; },
      range: (a: number, b: number) => { start = a; end = b + 1; return q; },
      single: () => { single = true; return q; },
      insert: (row: any) => { insert = row; return q; },
      then: (resolve: any) => {
        if (insert) {
          const row = { id: `${table}-${(db.tables[table] ?? []).length + 1}`, ...insert };
          (db.tables[table] ??= []).push(row);
          db.inserts.push({ table, row });
          return Promise.resolve({ data: single ? row : [row], error: null }).then(resolve);
        }
        const rows = (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(start, end);
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
      },
    };
    return q;
  };
  const rpc = async (name: string, args: any) => {
    db.rpcs.push({ name, args });
    if (name === "save_urpi_report_batch") {
      let created = 0, changed = 0;
      for (const r of args.p_rows) {
        const list = (db.tables.urpi_report_rows ??= []);
        const cur = list.find((x) => x.org_id === args.p_org_id && x.urpi_row === r.urpi_row);
        if (!cur) { list.push({ ...r, org_id: args.p_org_id }); created++; continue; }
        if (cur.digest !== r.digest) { Object.assign(cur, { data: r.data, digest: r.digest, result_code: r.result_code }); changed++; }
        if (cur.link_method !== "manual") Object.assign(cur, { order_id: r.order_id, store_id: r.store_id, link_status: r.link_status, link_method: r.link_method, candidate_order_ids: r.candidate_order_ids });
      }
      return { data: { new: created, changed }, error: null };
    }
    if (name === "link_urpi_report_chain") return { data: 2, error: null };
    return { data: null, error: { message: "unknown rpc" } };
  };
  return { from, rpc };
}

vi.mock("@/lib/urpi-report-access", () => ({
  requireUrpiReportOrg: async (orgId: string, permission: string) => {
    if (orgId !== "org") throw new Error("No tienes acceso a esta organización.");
    if (db.denied === permission) throw new Error("No tienes permiso.");
    return { user: { id: "actor" }, admin: fakeAdmin(), stores: [{ id: "kenku", name: "Kenku Peru" }, { id: "aurela", name: "Aurela" }], visibleStoreIds: new Set(db.visible) };
  },
}));
vi.mock("@/lib/master-door", () => ({
  applyDeliveriesToMaster: async (_admin: unknown, items: any[]) => { db.doors.push(...items); return { applied: items.map((i) => i.orderId), rejected: [] }; },
}));

import { importUrpiReport } from "@/lib/urpi-report-import";
import { parseUrpiReport } from "@/lib/urpi-report";
import { POST as importRoute } from "@/app/api/urpi/report/import/route";
import { applyUrpiDeliveries, linkUrpiReportRow } from "@/app/dashboard/urpi/report-actions";

const HEADER = '"_RowNumber";"Destinatario";"Resultado";"Monto Cobrado";"Motivo principal (solo canc/repro)";"Número de teléfono";"Fecha envío";"Row number relacionado";"Tienda"';
const line = (row: string, result: string, phone: string, date = "3/10/2026", prev = "", amount = "") => `"${row}";"Cliente";"${result}";"${amount}";"-";"${phone}";"${date}";"${prev}";""`;
const csv = (...lines: string[]) => [HEADER, ...lines].join("\n");
const stores = [{ id: "kenku", name: "Kenku Peru" }, { id: "aurela", name: "Aurela" }];

beforeEach(() => {
  db.rpcs = []; db.inserts = []; db.doors = []; db.denied = ""; db.visible = ["kenku", "aurela"];
  db.tables = {
    urpi_report_rows: [],
    order_master: [
      { order_id: "00000000-0000-4000-8000-000000000001", store_id: "kenku", customer_phone: "51900000001", order_created_at: "2026-09-25T15:00:00Z", order_name: "#KP1001", general_status: "en_proceso", orders: { cancelled_at: null } },
      { order_id: "00000000-0000-4000-8000-000000000002", store_id: "aurela", customer_phone: "51900000002", order_created_at: "2026-09-25T15:00:00Z", order_name: "#AUR2002", general_status: "anulado", orders: { cancelled_at: "2026-10-01T00:00:00Z" } },
      { order_id: "00000000-0000-4000-8000-000000000003", store_id: "aurela", customer_phone: "51900000003", order_created_at: "2026-09-26T15:00:00Z", order_name: "#AUR2003", general_status: "en_proceso", orders: { cancelled_at: null } },
      { order_id: "00000000-0000-4000-8000-000000000004", store_id: "kenku", customer_phone: "51900000003", order_created_at: "2026-09-27T15:00:00Z", order_name: "#KP1004", general_status: "entregado", orders: { cancelled_at: null } },
      { order_id: "x", store_id: "otra", customer_phone: "51900000001", order_created_at: "2026-09-25T15:00:00Z", order_name: "#KP9", general_status: "en_proceso", orders: { cancelled_at: null } },
    ],
  };
});

describe("importación del reporte de Urpi", () => {
  const report = () => parseUrpiReport(csv(line("10", "Reprogramado", "900000001", "2/10/2026"), line("11", "Entregado", "900000001", "3/10/2026", "10", "89"), line("12", "Cancelado", "900000003")));

  it("vincula por teléfono dentro de la organización y guarda todo en un lote", async () => {
    const result = await importUrpiReport(fakeAdmin() as any, { orgId: "org", actor: "actor", filename: "r.csv", report: report(), stores });
    expect(result).toMatchObject({ rows: 3, new: 3, changed: 0, linked: 2, review: 1, notFound: 0 });
    const batch = db.rpcs.find((call) => call.name === "save_urpi_report_batch")!.args;
    expect(batch.p_rows.map((r: any) => [r.urpi_row, r.order_id, r.link_method, r.link_status])).toEqual([
      [10, "00000000-0000-4000-8000-000000000001", "telefono", "vinculado"], [11, "00000000-0000-4000-8000-000000000001", "cadena", "vinculado"], [12, null, "telefono", "varios"],
    ]);
    expect(batch.p_rows[2].candidate_order_ids).toEqual(["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"]);
  });
  it("reimportar lo mismo no envía filas; un cambio envía solo esa fila", async () => {
    await importUrpiReport(fakeAdmin() as any, { orgId: "org", actor: "actor", filename: "r.csv", report: report(), stores });
    db.rpcs = [];
    const again = await importUrpiReport(fakeAdmin() as any, { orgId: "org", actor: "actor", filename: "r.csv", report: report(), stores });
    expect(db.rpcs).toEqual([]);
    expect(again).toMatchObject({ new: 0, changed: 0 });
    expect(db.inserts.filter((i) => i.table === "urpi_report_imports")).toHaveLength(2);
    const changed = parseUrpiReport(csv(line("10", "Reprogramado", "900000001", "2/10/2026"), line("11", "Entregado", "900000001", "3/10/2026", "10", "99"), line("12", "Cancelado", "900000003")));
    const result = await importUrpiReport(fakeAdmin() as any, { orgId: "org", actor: "actor", filename: "r.csv", report: changed, stores });
    expect(db.rpcs[0]!.args.p_rows.map((r: any) => r.urpi_row)).toEqual([11]);
    expect(result).toMatchObject({ new: 0, changed: 1 });
  });
  it("no reenvía una fila vinculada a mano si su contenido no cambió", async () => {
    await importUrpiReport(fakeAdmin() as any, { orgId: "org", actor: "actor", filename: "r.csv", report: report(), stores });
    Object.assign(db.tables.urpi_report_rows!.find((r) => r.urpi_row === 12)!, { order_id: "00000000-0000-4000-8000-000000000003", store_id: "aurela", link_status: "vinculado", link_method: "manual", candidate_order_ids: [] });
    db.rpcs = [];
    await importUrpiReport(fakeAdmin() as any, { orgId: "org", actor: "actor", filename: "r.csv", report: report(), stores });
    expect(db.rpcs).toEqual([]);
  });
});

describe("ruta de carga del reporte", () => {
  const upload = (body: string, orgId = "org", name = "AppSheet.ViewData.csv") => {
    const form = new FormData();
    form.set("orgId", orgId);
    form.set("file", new File([body], name, { type: "text/csv" }));
    return importRoute(new Request("http://kapta.test/api/urpi/report/import", { method: "POST", body: form }));
  };
  it("guarda y resume la lectura", async () => {
    const res = await upload(csv(line("10", "Entregado", "900000001", "3/10/2026", "", "89"), line("11", "Pronto a entregar", "900000009")));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, rows: 2, new: 2, linked: 1, notFound: 1 });
    expect(body.message).toContain("Pronto a entregar");
  });
  it("sin permiso o sin acceso no lee el archivo", async () => {
    db.denied = "sheets.edit";
    expect((await upload(csv(line("10", "Entregado", "900000001")))).status).toBe(403);
    db.denied = "";
    expect((await upload(csv(line("10", "Entregado", "900000001")), "otra-org")).status).toBe(403);
    expect(db.rpcs).toEqual([]);
  });
  it("rechaza otro formato", async () => {
    expect((await upload("x", "org", "reporte.xlsx")).status).toBe(400);
    const res = await upload('"Pedido";"Estado"\n"KP1";"OK"');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("No se reconoce");
  });
});

describe("marcar entregados desde el reporte de Urpi", () => {
  const seed = (rows: any[]) => { db.tables.urpi_report_rows = rows.map((r) => ({ org_id: "org", last_import_id: "imp", report_date: "2026-10-03", ...r })); };
  it("solo marca si el último intento es Entregado y Kapta no lo tiene cerrado", async () => {
    seed([
      { urpi_row: 10, order_id: "00000000-0000-4000-8000-000000000001", result_code: "reprogramado" }, { urpi_row: 11, order_id: "00000000-0000-4000-8000-000000000001", result_code: "entregado" },
      { urpi_row: 20, order_id: "00000000-0000-4000-8000-000000000002", result_code: "entregado" },
      { urpi_row: 30, order_id: "00000000-0000-4000-8000-000000000004", result_code: "entregado" },
      { urpi_row: 40, order_id: "00000000-0000-4000-8000-000000000003", result_code: "entregado" }, { urpi_row: 41, order_id: "00000000-0000-4000-8000-000000000003", result_code: "cancelado" },
    ]);
    const result = await applyUrpiDeliveries("org", ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000003"]);
    expect(result.ok).toBe(true);
    expect(db.doors.map((d) => d.orderId)).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(db.doors[0]).toMatchObject({ target: "entregado", source: "liquidacion", courier: "urpi", storeId: "kenku", occurredAt: "2026-10-03T17:00:00.000Z", payload: { urpi_report: true, urpi_row: 11 } });
    expect(result.message).toBe("1 pedido(s) marcados como entregados; 1 ya estaban entregados; 1 anulados o devueltos en Kapta no se tocaron; 1 sin entrega de Urpi como último intento.");
  });
  it("no toca pedidos de una tienda que la persona no ve", async () => {
    db.visible = ["aurela"];
    seed([{ urpi_row: 11, order_id: "00000000-0000-4000-8000-000000000001", result_code: "entregado" }]);
    await applyUrpiDeliveries("org", ["00000000-0000-4000-8000-000000000001"]);
    expect(db.doors).toEqual([]);
    expect((await linkUrpiReportRow("org", 12, "KP1001")).message).toContain("No existe");
  });
  it("exige permiso para editar el Master", async () => {
    db.denied = "master.edit";
    seed([{ urpi_row: 11, order_id: "00000000-0000-4000-8000-000000000001", result_code: "entregado" }]);
    expect((await applyUrpiDeliveries("org", ["00000000-0000-4000-8000-000000000001"])).ok).toBe(false);
    expect(db.doors).toEqual([]);
  });
});

describe("vínculo manual", () => {
  it("busca el código solo en las tiendas de la organización y vincula la cadena", async () => {
    const result = await linkUrpiReportRow("org", 12, "#aur2003");
    expect(result).toEqual({ ok: true, message: "Vinculado a #AUR2003: 2 intento(s) de Urpi." });
    expect(db.rpcs.at(-1)).toEqual({ name: "link_urpi_report_chain", args: { p_org_id: "org", p_urpi_row: 12, p_order_id: "00000000-0000-4000-8000-000000000003", p_store_id: "aurela", p_actor: "actor" } });
  });
  it("no vincula a un pedido de otra organización ni un código inventado", async () => {
    expect((await linkUrpiReportRow("org", 12, "KP9")).message).toContain("No existe");
    expect((await linkUrpiReportRow("org", 12, "hola")).message).toContain("código");
    expect(db.rpcs).toEqual([]);
  });
});
