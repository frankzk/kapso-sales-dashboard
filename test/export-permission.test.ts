// Las descargas del Master, de pedidos y del resumen diario exigen
// `data.export` (08-10-2026): esconder el botón no basta, la URL se puede abrir
// a mano.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ canExport: false, dbReads: 0 }));

vi.mock("@/lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/access")>()),
  getAccessibleStores: async () => [{ id: "store-1", name: "Kenku Peru" }],
}));
vi.mock("@/lib/permissions-access", () => ({
  getMasterPermissions: async () => ({ can: (p: string) => p === "data.export" && state.canExport }),
}));
vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => {
    state.dbReads += 1;
    const q: Record<string, unknown> = {};
    for (const m of ["select", "in", "gte", "lte", "order", "range", "eq"]) q[m] = () => q;
    q.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return { from: () => q };
  },
}));
vi.mock("@/lib/orders-master-access", () => ({
  getOrderMasterPage: async () => ({ rows: [], total: 0 }),
  getOrderMasterRowsByIds: async () => [],
  isMasterView: () => true,
}));

import { GET as exportCsv } from "@/app/api/export/route";
import { GET as exportMaster, POST as exportMasterSelection } from "@/app/api/export/pedidos/route";

const req = (url: string, init?: RequestInit) => {
  const r = new Request(url, init) as Request & { nextUrl: URL };
  r.nextUrl = new URL(url);
  return r as never;
};

beforeEach(() => {
  state.canExport = false;
  state.dbReads = 0;
});

describe("sin data.export no se descarga nada", () => {
  it.each([
    ["CSV de pedidos", () => exportCsv(req("https://x/api/export?kind=orders"))],
    ["CSV del resumen diario", () => exportCsv(req("https://x/api/export?kind=rollups"))],
    ["Excel del Master filtrado", () => exportMaster(req("https://x/api/export/pedidos"))],
    [
      "Excel de la selección",
      () =>
        exportMasterSelection(
          req("https://x/api/export/pedidos", { method: "POST", body: JSON.stringify({ ids: ["a"] }) }),
        ),
    ],
  ])("%s → 403 con un mensaje que se entiende, sin leer la base", async (_, call) => {
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("no tiene permiso para exportar");
    expect(state.dbReads).toBe(0);
  });

  it("con el permiso, el CSV sale", async () => {
    state.canExport = true;
    const res = await exportCsv(req("https://x/api/export?kind=rollups"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
  });
});
