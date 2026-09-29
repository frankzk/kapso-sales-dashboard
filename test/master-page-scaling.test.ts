import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({ createServerSupabaseMock: vi.fn() }));
vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: vi.fn(),
}));

import { getOrderMasterPage, getOrderMasterRowsByIds } from "@/lib/orders-master-access";
import { emptyFilters } from "@/lib/order-master-filters";
import type { MasterCursor } from "@/lib/master-pagination";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fixtures = Array.from({ length: 7 }, (_, index) => ({
  id: id(index + 1), order_id: id(index + 101), order_name: `KP${index + 1}`,
  store_id: index === 6 ? "denied" : index % 2 === 0 ? "a" : "b",
  order_created_at: index >= 4 && index < 6 ? null : `2026-09-25T00:00:00.12300${7 - index}Z`,
  macro_stage: index === 2 ? "preparacion" : "por_confirmar",
  macro_substage: index === 2 ? "por_armar" : "sin_llamar",
  region: index === 2 || index === 3 ? "Cusco" : "Lima",
}));
type Row = (typeof fixtures)[number];

it("rejects the entire selection when a later batch fails, never returns a partial export", async () => {
  let batch = 0;
  const builder: Record<string, any> = {};
  for (const method of ["select", "in", "order"]) builder[method] = () => builder;
  builder.then = (resolve: (result: unknown) => unknown) => resolve(++batch === 1
    ? { data: [fixtures[0]], error: null }
    : { data: null, error: { code: "57014", message: "timeout" } });
  createServerSupabaseMock.mockResolvedValue({ from: () => builder });
  await expect(getOrderMasterRowsByIds(["a"], Array.from({ length: 501 }, (_, i) => id(i + 1))))
    .rejects.toThrow("Master selected rows unavailable (57014)");
  expect(batch).toBe(2);
});
type Query = {
  head: boolean;
  predicates: ((row: Row) => boolean)[];
  orders: { column: string; ascending: boolean; nullsFirst: boolean }[];
  range: [number, number] | null;
  calls: [string, ...unknown[]][];
};

const value = (row: Row, column: string) => (row as unknown as Record<string, string | null>)[column];
function splitLogical(input: string): string[] {
  let depth = 0;
  let start = 0;
  const items: string[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "(") depth++;
    if (input[i] === ")") depth--;
    if (input[i] === "," && depth === 0) { items.push(input.slice(start, i)); start = i + 1; }
  }
  return [...items, input.slice(start)];
}
function matches(row: Row, expression: string): boolean {
  const logic = expression.match(/^(and|or)\((.*)\)$/);
  if (logic) {
    const terms = splitLogical(logic[2]!);
    return logic[1] === "and" ? terms.every(term => matches(row, term)) : terms.some(term => matches(row, term));
  }
  const [, column, operation, operand] = expression.match(/^([^.]+)\.(eq|gt|lt|gte|lte|is|ilike)\.(.*)$/) ?? [];
  if (!column || !operand) throw new Error(`Unexpected fixture predicate ${expression}`);
  const actual = value(row, column);
  if (operation === "is") return actual === null && operand === "null";
  if (actual == null) return false;
  if (operation === "ilike") return actual.toLowerCase().includes(operand.replaceAll("*", "").toLowerCase());
  if (operation === "eq") return actual === operand;
  if (operation === "gt") return actual > operand;
  if (operation === "gte") return actual >= operand;
  if (operation === "lt") return actual < operand;
  return actual <= operand;
}

function fakeDatabase(data = fixtures) {
  const queries: Query[] = [];
  const rpc = vi.fn(async (_name: string, args: { p_store_ids: string[] }) => {
    const groups = new Map<string, { macro_stage: string; macro_substage: string; total: number }>();
    for (const row of data.filter(row => args.p_store_ids.includes(row.store_id))) {
      const key = `${row.macro_stage}/${row.macro_substage}`;
      const current = groups.get(key) ?? { macro_stage: row.macro_stage, macro_substage: row.macro_substage, total: 0 };
      current.total++;
      groups.set(key, current);
    }
    return { data: [...groups.values()], error: null };
  });
  const from = vi.fn((table: string) => {
    expect(table).toBe("order_master");
    const query: Query = { head: false, predicates: [], orders: [], range: null, calls: [] };
    queries.push(query);
    const builder: Record<string, any> = {
      select(_columns: string, options?: { head?: boolean }) { query.head = Boolean(options?.head); return builder; },
      in(column: string, options: string[]) {
        query.calls.push(["in", column, options]);
        query.predicates.push(row => options.includes(value(row, column)!)); return builder;
      },
      eq(column: string, target: string) {
        query.calls.push(["eq", column, target]);
        query.predicates.push(row => value(row, column) === target); return builder;
      },
      is(column: string, target: null) {
        query.calls.push(["is", column, target]);
        query.predicates.push(row => value(row, column) === target); return builder;
      },
      not(column: string, operation: string, target: null) {
        expect(operation).toBe("is");
        query.calls.push(["not", column, operation, target]);
        query.predicates.push(row => value(row, column) !== target); return builder;
      },
      or(expression: string) {
        query.calls.push(["or", expression]);
        query.predicates.push(row => splitLogical(expression).some(term => matches(row, term))); return builder;
      },
      order(column: string, options: { ascending: boolean; nullsFirst?: boolean }) {
        query.orders.push({ column, ascending: options.ascending, nullsFirst: options.nullsFirst ?? false }); return builder;
      },
      range(start: number, end: number) { query.range = [start, end]; return builder; },
      then(resolve: (result: unknown) => unknown) {
        const filtered = data.filter(row => query.predicates.every(predicate => predicate(row)));
        const ordered = filtered.sort((left, right) => {
          for (const order of query.orders) {
            const a = value(left, order.column), b = value(right, order.column);
            if (a === b) continue;
            if (a === null) return order.nullsFirst ? -1 : 1;
            if (b === null) return order.nullsFirst ? 1 : -1;
            return (a! < b! ? -1 : 1) * (order.ascending ? 1 : -1);
          }
          return 0;
        });
        return resolve({ data: query.head ? null : query.range ? ordered.slice(query.range[0], query.range[1] + 1) : ordered, count: filtered.length, error: null });
      },
    };
    for (const operation of ["lt", "lte", "gt", "gte"]) {
      builder[operation] = (column: string, target: string) => {
        query.calls.push([operation, column, target]);
        query.predicates.push(row => matches(row, `${column}.${operation}.${target}`));
        return builder;
      };
    }
    return builder;
  });
  createServerSupabaseMock.mockResolvedValue({ from, rpc });
  return { queries, rpc, from };
}

const ids = (rows: { id: string }[]) => rows.map(row => row.id);

describe("Master page database integration", () => {
  beforeEach(() => createServerSupabaseMock.mockReset());

  it("uses summaries for the plain total and only bounded, zero-offset reads per authorized store", async () => {
    const db = fakeDatabase();
    const result = await getOrderMasterPage(["b", "a", "a"], { filters: emptyFilters(), sortKey: "created", page: 1, pageSize: 2 });
    expect(result.total).toBe(6);
    expect(ids(result.rows)).toEqual([id(1), id(2)]);
    expect(db.rpc).toHaveBeenCalledWith("order_master_mom_counts", { p_store_ids: ["a", "b"] });
    expect(db.queries).toHaveLength(2);
    expect(db.queries.every(query => !query.head && query.range?.[0] === 0 && query.range[1] === 2)).toBe(true);
    expect(result.hasNext).toBe(true);
  });

  it("intersects selected stores with access scope before using a stage/substage total", async () => {
    const db = fakeDatabase();
    const result = await getOrderMasterPage(["a", "b"], {
      filters: { ...emptyFilters(), stores: new Set(["a", "denied"]) }, sortKey: "created", page: 1,
      view: "preparacion", substage: "por_armar",
    });
    expect(result.total).toBe(1);
    expect(ids(result.rows)).toEqual([id(3)]);
    expect(db.rpc).toHaveBeenCalledWith("order_master_mom_counts", { p_store_ids: ["a"] });
    expect(db.queries.every(query => !query.head)).toBe(true);
  });

  it("keeps exact counts aligned with extra filters, without using unfiltered summaries", async () => {
    const db = fakeDatabase();
    const result = await getOrderMasterPage(["a", "b"], {
      filters: { ...emptyFilters(), regions: new Set(["Cusco"]) }, sortKey: "created", page: 1, pageSize: 2,
    });
    expect(result.total).toBe(2);
    expect(ids(result.rows)).toEqual([id(3), id(4)]);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.queries.filter(query => query.head)).toHaveLength(1);
    expect(db.queries.every(query => query.calls.some(call => call[0] === "in" && call[1] === "region"))).toBe(true);
  });

  it("global search ignores saved stage/store filters while preserving authorized stores", async () => {
    const db = fakeDatabase();
    const result = await getOrderMasterPage(["a", "b"], {
      filters: { ...emptyFilters(), search: "KP", stores: new Set(["denied"]), regions: new Set(["nowhere"]) },
      sortKey: "created", page: 1, view: "preparacion", substage: "por_armar",
    });
    expect(result.total).toBe(6);
    expect(ids(result.rows)).toEqual([1, 2, 3, 4, 5, 6].map(id));
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("uses a dated cursor and null partition across stores in both directions without offset", async () => {
    const db = fakeDatabase();
    const cursor: MasterCursor = { id: id(3), createdAt: fixtures[2]!.order_created_at, direction: "next" };
    const forward = await getOrderMasterPage(["a", "b"], { filters: emptyFilters(), sortKey: "created", page: 500, pageSize: 2, cursor });
    expect(ids(forward.rows)).toEqual([id(4), id(5)]);
    const backward = await getOrderMasterPage(["a", "b"], {
      filters: emptyFilters(), sortKey: "created", page: 499, pageSize: 2,
      cursor: { id: id(5), createdAt: null, direction: "previous" },
    });
    expect(ids(backward.rows)).toEqual([id(3), id(4)]);
    expect(db.queries.every(query => query.range?.[0] === 0)).toBe(true);
    expect(db.queries.some(query => query.calls.some(call => call[0] === "lte" && call[1] === "order_created_at"))).toBe(true);
    expect(db.queries.some(query => query.calls.some(call => call[0] === "is" && call[1] === "order_created_at"))).toBe(true);
  });

  it("does not read anything for a store filter outside access scope", async () => {
    const db = fakeDatabase();
    const result = await getOrderMasterPage(["a"], { filters: { ...emptyFilters(), stores: new Set(["denied"]) }, sortKey: "created", page: 1 });
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("preserves existing numeric bookmarks", async () => {
    const db = fakeDatabase();
    const result = await getOrderMasterPage(["a", "b"], { filters: emptyFilters(), sortKey: "created", page: 2, pageSize: 2 });
    expect(ids(result.rows)).toEqual([id(3), id(4)]);
    expect(db.queries[0]?.range).toEqual([2, 4]);
    expect(result.hasNext).toBe(true);
  });

  it("defaults the UI to 100 rows while allowing internal batches up to 1000", async () => {
    const db = fakeDatabase();
    const defaults = { filters: emptyFilters(), sortKey: "created" as const, page: 1 };
    const visible = await getOrderMasterPage(["a"], defaults);
    expect(visible.pageSize).toBe(100);
    expect(db.queries.at(-1)?.range).toEqual([0, 100]);
    const batch = await getOrderMasterPage(["a"], { ...defaults, pageSize: 1000 });
    expect(batch.pageSize).toBe(1000);
    expect(db.queries.at(-1)?.range).toEqual([0, 999]);
    const capped = await getOrderMasterPage(["a"], { ...defaults, pageSize: 5000 });
    expect(capped.pageSize).toBe(1000);
    expect(db.queries.at(-1)?.range).toEqual([0, 999]);
  });

  it.each([false, true])("skips every count for internal batches with includeTotal=false (filtered=%s)", async (filtered) => {
    const db = fakeDatabase();
    const result = await getOrderMasterPage(["a", "b"], {
      filters: { ...emptyFilters(), regions: filtered ? new Set(["Cusco"]) : new Set() },
      sortKey: "created", page: 1, pageSize: 1000, includeTotal: false,
    });
    expect(ids(result.rows)).toEqual((filtered ? [3, 4] : [1, 2, 3, 4, 5, 6]).map(id));
    expect(result.total).toBe(0);
    expect(result.hasNext).toBeNull();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.queries.every(query => !query.head)).toBe(true);
  });

  it("keeps the final unseen rows reachable after already-viewed orders leave the filter", async () => {
    const data = Array.from({ length: 205 }, (_, index) => ({
      ...fixtures[0]!, id: id(index + 1), order_id: id(index + 1001),
      store_id: index % 2 ? "b" : "a", order_created_at: "2026-09-25T00:00:00.123456Z",
    }));
    const db = fakeDatabase(data);
    const params = { filters: { ...emptyFilters(), regions: new Set(["Lima"]) }, sortKey: "created" as const, page: 1 };
    const first = await getOrderMasterPage(["a", "b"], params);
    expect(first.rows).toHaveLength(100);
    expect(first.hasNext).toBe(true);
    // Simulate updates that remove 95 previously seen orders from this filter.
    for (const row of data.slice(0, 95)) row.region = "Cusco";
    const second = await getOrderMasterPage(["a", "b"], {
      ...params, page: 2, cursor: { id: first.rows.at(-1)!.id, createdAt: first.rows.at(-1)!.order_created_at, direction: "next" },
    });
    expect(second.total).toBe(110);
    expect(Math.ceil(second.total / second.pageSize)).toBe(2);
    expect(second.rows).toHaveLength(100);
    expect(second.hasNext).toBe(true);
    const third = await getOrderMasterPage(["a", "b"], {
      ...params, page: 3, cursor: { id: second.rows.at(-1)!.id, createdAt: second.rows.at(-1)!.order_created_at, direction: "next" },
    });
    expect(ids([...second.rows, ...third.rows])).toEqual(Array.from({ length: 105 }, (_, index) => id(index + 101)));
    expect(third.hasNext).toBe(false);
    expect(db.queries.filter(query => !query.head).every(query => query.range?.[0] === 0 && query.range[1] <= 100)).toBe(true);
  });

  it("checks continuation after a backward page, including when the anchor leaves the filter", async () => {
    const data = fixtures.filter(row => row.store_id !== "denied").map(row => ({ ...row }));
    const db = fakeDatabase(data);
    const params = {
      filters: emptyFilters(), sortKey: "created" as const, page: 2, pageSize: 2,
      cursor: { id: id(5), createdAt: null, direction: "previous" as const },
    };
    const previous = await getOrderMasterPage(["a", "b"], params);
    expect(ids(previous.rows)).toEqual([id(3), id(4)]);
    expect(previous.hasNext).toBe(true);
    // The original next page disappears; a previous-direction cursor itself
    // is no longer evidence that a following row exists.
    data.splice(4);
    const noFollowing = await getOrderMasterPage(["a", "b"], params);
    expect(ids(noFollowing.rows)).toEqual([id(3), id(4)]);
    expect(noFollowing.hasNext).toBe(false);
    expect(db.queries.every(query => query.range?.[0] === 0 && query.range[1] <= 1)).toBe(true);
  });

  it("leaves internal export reads at exactly their requested size without a continuation probe", async () => {
    const data = Array.from({ length: 1001 }, (_, index) => ({
      ...fixtures[0]!, id: id(index + 1), order_created_at: "2026-09-25T00:00:00.123456Z",
    }));
    const db = fakeDatabase(data);
    const result = await getOrderMasterPage(["a"], {
      filters: emptyFilters(), sortKey: "created", page: 1, pageSize: 1000, includeTotal: false,
    });
    expect(result.rows).toHaveLength(1000);
    expect(result.hasNext).toBeNull();
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.range).toEqual([0, 999]);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("probes after a full 1000-row internal page instead of exceeding the database response cap", async () => {
    const data = Array.from({ length: 1001 }, (_, index) => ({
      ...fixtures[0]!, id: id(index + 1), order_created_at: "2026-09-25T00:00:00.123456Z",
    }));
    const db = fakeDatabase(data);
    const result = await getOrderMasterPage(["a"], {
      filters: emptyFilters(), sortKey: "created", page: 1, pageSize: 1000,
    });
    expect(result.rows).toHaveLength(1000);
    expect(result.hasNext).toBe(true);
    expect(db.queries.map(query => query.range)).toEqual([[0, 999], [0, 0]]);
  });
});
