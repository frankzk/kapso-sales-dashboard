// La lista de Compras por páginas (MOM §45.2):
//   - cada pestaña filtra en la base por sus estados, igual que `inImportTab`;
//   - «Ver más» sigue desde la última fila (keyset por `created_at` e `id`):
//     sin repetir ni saltar filas, también con dos creadas en el mismo instante;
//   - las cifras de las tarjetas, del tipo y de cada proveedor cuentan TODAS las
//     filas (consultas de conteo), no la página cargada;
//   - el cursor que vuelve del navegador se valida antes de tocar la consulta;
//   - «Ver más» vuelve a pedir el permiso en la organización.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  tables: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as { table: string; chain: [string, unknown[]][] }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "44444444-4444-4444-8444-444444444444", email: "bodega@kapta.pe" }) }));
vi.mock("@/lib/permissions-access", () => ({
  hasOrgPermission: async (org: string, perm: string) => org === ORG && h.perms.has(perm),
  orgsWithPermission: async (perm: string) => (h.perms.has(perm) ? [{ org_id: ORG, role: "admin" }] : []),
}));
vi.mock("@/lib/agent-names", () => ({ resolveAgentNames: async () => ({}) }));

/**
 * Lo justo de PostgREST para estas consultas: `eq`, `in`, `not is null`, el
 * `or` del keyset, `order` (varios), `limit`, `range` y `count` con `head`.
 */
function exec(table: string, chain: [string, unknown[]][]) {
  let rows = (h.tables[table] ?? []).map((r) => ({ ...r }));
  let countOnly = false;
  const orders: { col: string; asc: boolean }[] = [];
  let limit: number | null = null;
  let range: [number, number] | null = null;
  for (const [m, args] of chain) {
    if (m === "select") countOnly = Boolean((args[1] as { head?: boolean } | undefined)?.head);
    else if (m === "eq") rows = rows.filter((r) => String(r[args[0] as string]) === String(args[1]));
    else if (m === "in") rows = rows.filter((r) => (args[1] as unknown[]).map(String).includes(String(r[args[0] as string])));
    else if (m === "not") rows = rows.filter((r) => r[args[0] as string] != null);
    else if (m === "or") {
      const k = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]+)\)$/.exec(String(args[0]));
      if (!k) throw new Error(`or inesperado: ${String(args[0])}`);
      rows = rows.filter((r) => String(r.created_at) < k[1]! || (String(r.created_at) === k[2] && String(r.id) < k[3]!));
    } else if (m === "order") orders.push({ col: args[0] as string, asc: (args[1] as { ascending: boolean }).ascending });
    else if (m === "limit") limit = args[0] as number;
    else if (m === "range") range = [args[0] as number, args[1] as number];
  }
  rows.sort((a, b) => {
    for (const o of orders) {
      const x = String(a[o.col]);
      const y = String(b[o.col]);
      if (x !== y) return (x < y ? -1 : 1) * (o.asc ? 1 : -1);
    }
    return 0;
  });
  if (countOnly) return { data: null, error: null, count: rows.length };
  if (range) rows = rows.slice(range[0], range[1] + 1);
  if (limit != null) rows = rows.slice(0, limit);
  return { data: rows, error: null };
}

function builder(table: string) {
  const chain: [string, unknown[]][] = [];
  h.calls.push({ table, chain });
  const b: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => exec(table, chain)).then(res, rej);
        return (...args: unknown[]) => {
          chain.push([String(prop), args]);
          return b;
        };
      },
    },
  );
  return b;
}

vi.mock("@/lib/db", () => ({ createAdminSupabase: () => ({ from: (t: string) => builder(t), rpc: async () => ({ data: [], error: null }) }) }));

import { IMPORT_STATUSES, inImportTab, type ImportStatus } from "@/lib/compras";
import { IMPORT_LIST_PAGE, decodeListCursor, encodeListCursor, keysetFilter, pageOf, tabStatuses, type ImportListCursor } from "@/lib/compras-list";
import { loadActiveImportList, loadImportListCounts, loadImportListPage } from "@/lib/compras-server";
import { loadMoreImports } from "@/app/dashboard/compras/actions";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const SUP_A = "66666666-6666-4666-8666-666666666666";
const SUP_B = "77777777-7777-4777-8777-777777777777";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function imp(n: number, over: Row = {}): Row {
  // Del 1 al N, cada una un minuto después; las 10 primeras recibidas, de dos en dos en el mismo instante.
  const minute = n <= 10 ? Math.ceil(n / 2) : n;
  return {
    id: uuid(n),
    org_id: ORG,
    code: `IMP-2026-${String(n).padStart(3, "0")}`,
    kind: "importacion",
    supplier_id: n % 3 === 0 ? SUP_B : SUP_A,
    status: "recibido",
    transport: "air",
    created_at: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString().replace("Z", "+00:00"),
    ...over,
  };
}

function seed() {
  const rows: Row[] = [];
  for (let n = 1; n <= 250; n++) rows.push(imp(n));
  for (let n = 251; n <= 280; n++) rows.push(imp(n, { status: n % 2 ? "en_transito" : "cotizacion" }));
  for (let n = 281; n <= 285; n++) rows.push(imp(n, { status: "cancelado", kind: "local", code: `LOC-2026-${n}` }));
  // Otra organización: nunca se cuenta ni se lista.
  rows.push(imp(900, { org_id: OTHER_ORG }));
  h.tables = { imports: rows, import_suppliers: [] };
  h.calls = [];
}

beforeEach(() => {
  seed();
  h.perms = new Set(["purchases.receive"]);
});

describe("reglas de la lista (puras)", () => {
  it("cada pestaña pide a la base los mismos estados que `inImportTab`", () => {
    for (const tab of ["activas", "recibidas", "canceladas"] as const) {
      const expected = IMPORT_STATUSES.map((s) => s.id as ImportStatus).filter((s) => inImportTab(s, tab));
      expect(tabStatuses(tab)).toEqual(expected);
    }
    expect(tabStatuses("todas")).toBeNull();
    expect(tabStatuses("activas")).toContain("recibido_parcial");
    expect(tabStatuses("activas")).toContain("cotizacion");
  });

  it("el cursor va y vuelve; uno armado a mano no entra en la consulta", () => {
    const c = { createdAt: "2026-11-14T15:00:00.123456+00:00", id: uuid(7) };
    expect(decodeListCursor(encodeListCursor(c))).toEqual(c);
    expect(decodeListCursor(`2026-11-14T15:00:00Z~${uuid(7)}`)).toEqual({ createdAt: "2026-11-14T15:00:00Z", id: uuid(7) });
    for (const bad of [null, 42, "", "~", `x~${uuid(7)}`, "2026-11-14T15:00:00Z~no-es-uuid", `2026-11-14T15:00:00Z",id.gt.0~${uuid(7)}`, `${"9".repeat(90)}~${uuid(7)}`]) {
      expect(decodeListCursor(bad)).toBeNull();
    }
  });

  it("el filtro del keyset: más viejas, o del mismo instante con un id menor", () => {
    expect(keysetFilter({ createdAt: "2026-11-14T15:00:00+00:00", id: uuid(7) })).toBe(
      `created_at.lt."2026-11-14T15:00:00+00:00",and(created_at.eq."2026-11-14T15:00:00+00:00",id.lt.${uuid(7)})`,
    );
  });

  it("una página pide una fila de más para saber si hay otra", () => {
    const rows = [1, 2, 3].map((n) => ({ id: uuid(n), created_at: `t${n}` }));
    expect(pageOf(rows, 2)).toEqual({ rows: rows.slice(0, 2), next: { createdAt: "t2", id: uuid(2) } });
    expect(pageOf(rows, 3).next).toBeNull();
  });
});

describe("la lista desde la base, por páginas", () => {
  it("«Ver más» recorre TODAS las recibidas sin repetir ni saltar, también las del mismo instante", async () => {
    const seen: string[] = [];
    let cursor: ImportListCursor | null = null;
    let pages = 0;
    do {
      const page = await loadImportListPage(ORG, false, { tab: "recibidas", cursor });
      seen.push(...page.rows.map((r) => r.imp.code));
      expect(page.rows.every((r) => r.imp.status === "recibido" && r.imp.org_id === ORG)).toBe(true);
      cursor = page.next;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    // La más reciente primero; a igual instante, el id mayor primero.
    expect(seen[0]).toBe("IMP-2026-250");
    expect(seen.slice(-2)).toEqual(["IMP-2026-002", "IMP-2026-001"]);
  });

  it("la consulta: organización, estados, proveedor y tipo en la base; orden fijo; una fila de más", async () => {
    await loadImportListPage(ORG, false, { tab: "canceladas", supplierId: SUP_A, kind: "local" });
    const q = h.calls.find((c) => c.table === "imports")!.chain;
    expect(q).toContainEqual(["eq", ["org_id", ORG]]);
    expect(q).toContainEqual(["in", ["status", ["cancelado"]]]);
    expect(q).toContainEqual(["eq", ["supplier_id", SUP_A]]);
    expect(q).toContainEqual(["eq", ["kind", "local"]]);
    expect(q.filter(([m]) => m === "order")).toEqual([
      ["order", ["created_at", { ascending: false }]],
      ["order", ["id", { ascending: false }]],
    ]);
    expect(q).toContainEqual(["limit", [IMPORT_LIST_PAGE + 1]]);
  });

  it("las activas se leen TODAS (el resumen y las alertas las cuentan todas)", async () => {
    h.tables.imports!.push(...Array.from({ length: 230 }, (_, i) => imp(1000 + i, { status: "en_aduana" })));
    const active = await loadActiveImportList(ORG, false);
    expect(active).toHaveLength(260);
    expect(new Set(active.map((r) => r.imp.id)).size).toBe(260);
  });

  it("las cifras cuentan todas las filas, con conteos en la base, no la página", async () => {
    const counts = await loadImportListCounts(ORG);
    expect(counts.tabs).toEqual({ activas: 30, recibidas: 250, canceladas: 5, todas: 285 });
    expect(counts.kinds).toEqual({ importacion: 280, local: 5 });
    expect(counts.suppliers[SUP_B]).toBe(95);
    expect(counts.suppliers[SUP_A]).toBe(190);
    const heads = h.calls.filter((c) => c.table === "imports" && c.chain.some(([m, a]) => m === "select" && (a[1] as { head?: boolean } | undefined)?.head));
    expect(heads).toHaveLength(6);
  });

  it("con proveedor y tipo, las tarjetas cuentan con esos filtros; el tipo, solo con el proveedor", async () => {
    const counts = await loadImportListCounts(ORG, { supplierId: SUP_B, kind: "importacion" });
    const b = (n: number) => n % 3 === 0;
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    expect(counts.tabs.recibidas).toBe(range(1, 250).filter(b).length);
    expect(counts.tabs.activas).toBe(range(251, 280).filter(b).length);
    expect(counts.tabs.canceladas).toBe(0);
    expect(counts.kinds.local).toBe(range(281, 285).filter(b).length);
  });
});

describe("«Ver más» (la acción)", () => {
  it("vuelve a pedir el permiso en la organización", async () => {
    h.perms = new Set();
    const res = await loadMoreImports({ orgId: ORG, tab: "recibidas", cursor: encodeListCursor({ createdAt: "2026-01-01T03:00:00+00:00", id: uuid(150) }) });
    expect(res).toEqual({ error: "Sin acceso a Compras en esa organización." });
    expect(h.calls.filter((c) => c.table === "imports")).toEqual([]);
  });

  it("un cursor o una pestaña que no son, no llegan a la base", async () => {
    for (const bad of [
      { tab: "recibidas", cursor: "2026-01-01T00:00:00Z\",id.gt.0~x" },
      { tab: "borradas", cursor: encodeListCursor({ createdAt: "2026-01-01T03:00:00+00:00", id: uuid(150) }) },
    ]) {
      expect(await loadMoreImports({ orgId: ORG, ...bad })).toEqual({ error: "No se pudo seguir la lista: vuelve a abrirla." });
    }
    expect(h.calls.filter((c) => c.table === "imports")).toEqual([]);
  });

  it("con «Recepción de compras», la página siguiente sin montos y su cursor", async () => {
    const first = await loadImportListPage(ORG, false, { tab: "recibidas" });
    const res = await loadMoreImports({ orgId: ORG, tab: "recibidas", cursor: encodeListCursor(first.next!) });
    if ("error" in res) throw new Error(res.error);
    expect(res.rows).toHaveLength(100);
    expect(res.rows[0]!.imp.code).toBe("IMP-2026-150");
    expect(res.rows.every((r) => r.money === undefined)).toBe(true);
    expect(decodeListCursor(res.next)).not.toBeNull();
    for (const c of h.calls.filter((x) => x.table === "imports")) {
      const select = c.chain.find(([m]) => m === "select")![1][0];
      expect(String(select)).not.toMatch(/fx_pen_per_usd/);
    }
  });
});

describe("la página usa los conteos y la lista por páginas", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("la página cuenta en la base y lee las activas completas", () => {
    const page = read("app/dashboard/compras/page.tsx");
    expect(page).toContain("loadImportListCounts(orgId, filter)");
    expect(page).toContain("loadActiveImportList(orgId, perms.canMoney, filter)");
    expect(page).not.toContain("IMPORT_LIST_LIMIT");
  });

  it("la vista no cuenta sobre las filas cargadas", () => {
    const view = read("components/compras/import-list.tsx");
    expect(view).toContain("counts.tabs");
    expect(view).toContain("counts.suppliers[s.id]");
    expect(view).not.toMatch(/allRows/);
  });
});
