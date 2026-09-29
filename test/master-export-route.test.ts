import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { OrderMasterRow } from "@/lib/types";
import type { MasterPage } from "@/lib/orders-master-access";
import type { MasterCursor } from "@/lib/master-pagination";

const { getAccessibleStores, getOrderMasterPage, getOrderMasterRowsByIds, sheetRows } = vi.hoisted(() => ({
  getAccessibleStores: vi.fn(),
  getOrderMasterPage: vi.fn(),
  getOrderMasterRowsByIds: vi.fn(),
  sheetRows: [] as unknown[][],
}));
vi.mock("@/lib/access", () => ({ getAccessibleStores }));
vi.mock("@/lib/orders-master-access", () => ({
  getOrderMasterPage,
  getOrderMasterRowsByIds,
  isMasterView: (value: string) => ["todos", "por_confirmar", "preparacion"].includes(value),
}));
// Exercise the real route/row formatting, without compressing 20,000 XLSX rows
// to verify pagination. Column and cell formatting have their own tests.
vi.mock("exceljs", () => ({
  default: {
    Workbook: class {
      xlsx = { writeBuffer: async () => Buffer.from("test-workbook") };
      addWorksheet() {
        return {
          addRow(values: unknown[]) {
            sheetRows.push(values);
            return { eachCell() {}, getCell() { return {}; } };
          },
        };
      }
    },
  },
}));

import { GET, POST } from "@/app/api/export/pedidos/route";

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const date = "2026-09-25T12:00:00.123456+00:00";
function dataset(size: number, effectiveLimit = 100) {
  const rows = Array.from({ length: size }, (_, index) => ({
    id: id(index + 1), order_id: id(index + 100_001), order_name: `#KP${index + 1}`,
    store_id: index % 2 ? "store-a" : "store-b", order_created_at: date,
    macro_stage: "por_confirmar", macro_substage: "sin_llamar", general_status: "pendiente",
    operational_status: "sin_confirmar", coverage: "lima", order_total: 20,
    status_locked: false, courier_count: 0, attempt_count: 0, comment_count: 0,
  } as OrderMasterRow));
  getOrderMasterPage.mockImplementation(async (_stores: string[], params: {
    page: number; pageSize: number; cursor: MasterCursor | null;
  }): Promise<MasterPage> => {
    // The reader may enforce a lower effective limit than requested. The route
    // must continue using its full timestamp/id cursor in either case.
    const pageSize = Math.max(1, Math.min(params.pageSize, effectiveLimit));
    const after = params.cursor ? rows.findIndex(row => row.id === params.cursor!.id) + 1 : 0;
    if (params.cursor) {
      expect(params.cursor.createdAt).toBe(date);
      expect(params.cursor.direction).toBe("next");
    }
    return { rows: rows.slice(after, after + pageSize), total: rows.length, page: params.page, pageSize, hasNext: null };
  });
}

describe("Master Excel export pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sheetRows.length = 0;
    getAccessibleStores.mockResolvedValue([{ id: "store-a", name: "A" }, { id: "store-b", name: "B" }]);
  });

  it("exports all 205 matches when the reader caps requested batches to 100, retaining filters and scope", async () => {
    dataset(205);
    const response = await GET(new NextRequest("https://dashboard.test/api/export/pedidos?view=por_confirmar&substage=sin_llamar&r=Lima&st=store-a&pg=80&cursor=ignored"));
    expect(response.headers.get("X-Export-Rows")).toBe("205");
    expect(response.headers.get("X-Export-Truncated")).toBe("0");
    expect(sheetRows).toHaveLength(206);
    expect(sheetRows.slice(1).map(row => row[0])).toEqual(Array.from({ length: 205 }, (_, index) => `KP${index + 1}`));
    expect(getOrderMasterPage).toHaveBeenCalledTimes(3);
    for (const [stores, params] of getOrderMasterPage.mock.calls) {
      expect(stores).toEqual(["store-a", "store-b"]);
      expect(params).toMatchObject({ page: 1, view: "por_confirmar", substage: "sin_llamar", includeTotal: false });
      expect(params.filters.regions).toEqual(new Set(["Lima"]));
      expect(params.filters.stores).toEqual(new Set(["store-a"]));
    }
    expect(getOrderMasterPage.mock.calls[0]?.[1].cursor).toBeNull();
    expect(getOrderMasterPage.mock.calls[1]?.[1].cursor.id).toBe(id(100));
    expect(getOrderMasterPage.mock.calls[2]?.[1].cursor.id).toBe(id(200));
  });

  it("finishes a multiple of the effective page size without duplicates or false truncation", async () => {
    dataset(200);
    const response = await GET(new NextRequest("https://dashboard.test/api/export/pedidos"));
    expect(response.headers.get("X-Export-Rows")).toBe("200");
    expect(response.headers.get("X-Export-Truncated")).toBe("0");
    expect(getOrderMasterPage).toHaveBeenCalledTimes(3);
    expect(sheetRows).toHaveLength(201);
  });

  it("exports more than 1000 rows with full internal batches and no repeated totals", async () => {
    dataset(2105, 1000);
    const response = await GET(new NextRequest("https://dashboard.test/api/export/pedidos"));
    expect(response.headers.get("X-Export-Rows")).toBe("2105");
    expect(response.headers.get("X-Export-Truncated")).toBe("0");
    expect(sheetRows).toHaveLength(2106);
    expect(getOrderMasterPage).toHaveBeenCalledTimes(3);
    expect(getOrderMasterPage.mock.calls[1]?.[1].cursor.id).toBe(id(1000));
    expect(getOrderMasterPage.mock.calls[2]?.[1].cursor.id).toBe(id(2000));
    for (const [, params] of getOrderMasterPage.mock.calls) {
      expect(params).toMatchObject({ page: 1, pageSize: 1000, includeTotal: false });
    }
  });

  it.each([{ size: 20_000, truncated: "0" }, { size: 20_001, truncated: "1" }])(
    "preserves the 20,000-row limit and reports truncation accurately for $size matches",
    async ({ size, truncated }) => {
      dataset(size, 1000);
      const response = await GET(new NextRequest("https://dashboard.test/api/export/pedidos"));
      expect(response.headers.get("X-Export-Rows")).toBe("20000");
      expect(response.headers.get("X-Export-Truncated")).toBe(truncated);
      expect(sheetRows).toHaveLength(20_001);
      expect(getOrderMasterPage).toHaveBeenCalledTimes(21);
      expect(getOrderMasterPage.mock.calls.at(-1)?.[1]).toMatchObject({ page: 1, pageSize: 1, cursor: { id: id(20_000) } });
    },
  );

  it("keeps denying export when there are no accessible stores", async () => {
    getAccessibleStores.mockResolvedValue([]);
    expect((await GET(new NextRequest("https://dashboard.test/api/export/pedidos"))).status).toBe(403);
    expect(getOrderMasterPage).not.toHaveBeenCalled();
    expect(sheetRows).toHaveLength(0);
  });

  it("keeps selected-id exports on the scoped POST path", async () => {
    getOrderMasterRowsByIds.mockResolvedValue([]);
    const response = await POST(new NextRequest("https://dashboard.test/api/export/pedidos", {
      method: "POST", body: JSON.stringify({ ids: [id(1), id(2)] }), headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(getOrderMasterRowsByIds).toHaveBeenCalledWith(["store-a", "store-b"], [id(1), id(2)]);
    expect(getOrderMasterPage).not.toHaveBeenCalled();
  });
});
