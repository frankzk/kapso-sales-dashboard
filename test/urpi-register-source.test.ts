import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const db = vi.hoisted(() => ({ tables: {} as Record<string, Record<string, any>[]>, inserts: [] as any[] }));
const access = vi.hoisted(() => ({ denied: new Set<string>() }));

vi.mock("@/lib/urpi-programming-access", () => ({
  requireUrpiStore: async (storeId: string) => {
    const store = db.tables.stores!.find((row) => row.id === storeId);
    if (!store || access.denied.has(storeId)) throw new Error("No tienes permiso para registrar archivos mensuales.");
    return { user: { id: "actor" }, store };
  },
}));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = [];
    let insert: any[] | null = null;
    const q: any = {
      select: () => q,
      eq: (key: string, val: any) => { filters.push((r) => r[key] === val); return q; },
      in: (key: string, values: any[]) => { filters.push((r) => values.includes(r[key])); return q; },
      insert: (rows: any) => { insert = Array.isArray(rows) ? rows : [rows]; return q; },
      then: (resolve: any, reject: any) => {
        if (insert) {
          const rows = insert.map((row, i) => ({ id: `source-${(db.tables[table]?.length ?? 0) + i + 1}`, ...row }));
          db.inserts.push(...rows);
          (db.tables[table] ??= []).push(...rows);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  return { createAdminSupabase: () => ({ from }), createServerSupabase: async () => ({ from }) };
});

import { registerUrpiSource } from "@/app/dashboard/urpi/actions";

const url = "https://docs.google.com/spreadsheets/d/13v6LVlETx17NWAN1jgWJzCHxR-7GoWOHk3llf2RzAgc/edit?usp=drive_open";
const spreadsheetId = "13v6LVlETx17NWAN1jgWJzCHxR-7GoWOHk3llf2RzAgc";

beforeEach(() => {
  access.denied.clear();
  db.inserts = [];
  db.tables = {
    stores: [{ id: "kenku", name: "Kenku Peru", order_prefix: "KP" }, { id: "aurela", name: "Aurela", order_prefix: "#aur" }],
    urpi_programming_sources: [],
  };
});

describe("registro de un libro Urpi compartido", () => {
  it("registra ambas tiendas con el prefijo de cada tienda", async () => {
    const result = await registerUrpiSource({ storeIds: ["kenku", "aurela"], month: "2026-10", url });
    expect(result).toMatchObject({ ok: true, sourceId: "source-1" });
    expect(result.message).toContain("Kenku Peru (KP) y Aurela (AUR)");
    expect(db.inserts.map((row) => [row.store_id, row.order_prefix, row.spreadsheet_id, row.month])).toEqual([
      ["kenku", "KP", spreadsheetId, "2026-10"], ["aurela", "AUR", spreadsheetId, "2026-10"],
    ]);
  });
  it("completa solo la tienda que faltaba", async () => {
    db.tables.urpi_programming_sources!.push({ id: "old", store_id: "kenku", spreadsheet_id: spreadsheetId, month: "2026-10", order_prefix: "KP" });
    const result = await registerUrpiSource({ storeIds: ["kenku", "aurela"], month: "2026-10", url });
    expect(result).toMatchObject({ ok: true, sourceId: "old" });
    expect(db.inserts.map((row) => row.store_id)).toEqual(["aurela"]);
  });
  it("no registra nada si una tienda no tiene prefijo", async () => {
    db.tables.stores![1]!.order_prefix = null;
    const result = await registerUrpiSource({ storeIds: ["kenku", "aurela"], month: "2026-10", url });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("Aurela no tiene prefijo") });
    expect(db.inserts).toEqual([]);
  });
  it("no registra nada si falta permiso en una de las tiendas", async () => {
    access.denied.add("aurela");
    const result = await registerUrpiSource({ storeIds: ["kenku", "aurela"], month: "2026-10", url });
    expect(result.ok).toBe(false);
    expect(db.inserts).toEqual([]);
  });
  it("rechaza prefijos que mezclarían pedidos", async () => {
    db.tables.stores![0]!.order_prefix = "A";
    const result = await registerUrpiSource({ storeIds: ["kenku", "aurela"], month: "2026-10", url });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("se solapan") });
    expect(db.inserts).toEqual([]);
  });
  it("no reescribe una fuente registrada con otro prefijo", async () => {
    db.tables.urpi_programming_sources!.push({ id: "old", store_id: "aurela", spreadsheet_id: spreadsheetId, month: "2026-10", order_prefix: "AU" });
    const result = await registerUrpiSource({ storeIds: ["kenku", "aurela"], month: "2026-10", url });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("Aurela con otro prefijo") });
    expect(db.inserts).toEqual([]);
  });
});
