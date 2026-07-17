import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({
  createServerSupabaseMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
}));

import { getStoreLeads } from "@/lib/leads-access";

describe("getStoreLeads pagination", () => {
  beforeEach(() => {
    createServerSupabaseMock.mockReset();
  });

  it("drains every PostgREST page for the complete call queue", async () => {
    const source = Array.from({ length: 1167 }, (_, index) => ({ id: `lead-${index}` }));
    const ranges: Array<[number, number]> = [];

    createServerSupabaseMock.mockResolvedValue({
      from: () => {
        const query: Record<string, unknown> = {};
        for (const method of ["select", "eq", "in", "neq", "order"]) {
          query[method] = vi.fn(() => query);
        }
        query.range = vi.fn(async (from: number, to: number) => {
          ranges.push([from, to]);
          return { data: source.slice(from, to + 1), error: null };
        });
        return query;
      },
    });

    const rows = await getStoreLeads("kenku-peru", "por_llamar", null);

    expect(rows).toHaveLength(1167);
    expect(rows.at(-1)).toEqual({ id: "lead-1166" });
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });
});
