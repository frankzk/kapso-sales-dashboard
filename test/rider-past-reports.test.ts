import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteRow } from "@/lib/routes-access";
import type { RiderLoad } from "@/lib/gf-rider-loads";

const mock = vi.hoisted(() => ({
  routes: [] as RouteRow[],
  loads: [] as RiderLoad[],
  mode: "exigir" as "exigir" | "confirmar" | "ninguno",
  detail: vi.fn(), screen: vi.fn(), receive: vi.fn(), decline: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "roy", email: "roy@example.test" }) }));
vi.mock("@/lib/routes-access", () => ({
  getMyRider: async () => ({ id: "roy", full_name: "Roy" }),
  getRoutes: async () => mock.routes,
  getRouteDetail: mock.detail,
}));
vi.mock("@/lib/gf-rider-loads", () => ({ getMyGfLoads: async () => mock.loads, getMyPickupMode: async () => mock.mode }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => false }) }));
vi.mock("@/lib/sheets/rider-access", () => ({ getRiderSheet: async () => null, loadRiderVocabulary: vi.fn() }));
vi.mock("@/app/reparto/coordinacion", () => ({ CoordinatorReport: () => null }));
vi.mock("@/components/rider-route", () => ({ RiderRouteScreen: mock.screen }));
vi.mock("@/components/scan-action", () => ({ ScanAction: () => null }));
vi.mock("@/app/reparto/receive", () => ({ receiveMyGfPackage: mock.receive, declineMyGfPackage: mock.decline }));

import RepartoPage from "@/app/reparto/page";

function route(id: string, date: string, status = "en_curso"): RouteRow {
  return { id, rider_id: "roy", store_id: "store", route_date: date, status,
    settlement_id: null, note: null, started_at: null, closed_at: null };
}
async function render(ruta?: string) {
  return renderToStaticMarkup(await RepartoPage({ searchParams: Promise.resolve({ ruta }) }));
}

describe("reportes anteriores mientras la caja de hoy sigue pendiente", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T15:24:00Z"));
    mock.mode = "exigir";
    mock.routes = [route("today", "2026-10-01"), route("yesterday", "2026-09-30"), route("closed", "2026-09-29", "cerrada")];
    mock.loads = [{ id: "box", route_date: "2026-10-01", load_number: 1, state: "pickup_check",
      total: 16, received: 10, declined: 0, awaitingOffice: 0, items: [] }];
    mock.detail.mockImplementation(async (id: string) => ({ route: mock.routes.find((r) => r.id === id), stops: [] }));
    mock.screen.mockImplementation(({ route }: { route: RouteRow }) => createElement("p", null, `Reporte ${route.id}`));
  });
  afterEach(() => vi.useRealTimers());

  it("offers previous days before scanning, including closed routes for consultation", async () => {
    const html = await render();
    expect(html).toContain("Recibir mi caja");
    expect(html).toContain("Completar reportes anteriores");
    expect(html).toContain('value="yesterday"');
    expect(html).toContain("2026-09-29 · Cerrada");
    expect(html).not.toContain('value="today"');
    expect(mock.screen).not.toHaveBeenCalled();
    expect(mock.receive).not.toHaveBeenCalled();
    expect(mock.decline).not.toHaveBeenCalled();
  });
  it.each(["office_check", "ready_for_pickup", "pickup_check"])("opens yesterday despite today's %s load", async (state) => {
    mock.loads[0]!.state = state;
    expect(await render("yesterday")).toContain("Reporte yesterday");
    expect(mock.screen.mock.calls[0]![0]).toMatchObject({ receptionPending: true, route: { id: "yesterday", status: "en_curso" } });
    expect(mock.receive).not.toHaveBeenCalled();
    expect(mock.decline).not.toHaveBeenCalled();
  });
  it("preserves closed status so past closed routes remain read-only", async () => {
    await render("closed");
    expect(mock.screen.mock.calls[0]![0].route.status).toBe("cerrada");
  });
  it.each([undefined, "today", "unknown", "another-riders-route"])("keeps reception for %s", async (id) => {
    expect(await render(id)).toContain("Recibir mi caja");
    expect(mock.screen).not.toHaveBeenCalled();
    if (id && id !== "today") expect(mock.detail).not.toHaveBeenCalledWith(id);
  });
  it("does not unlock a future date", async () => {
    mock.routes.push(route("future", "2026-10-02"));
    const html = await render("future");
    expect(html).toContain("Recibir mi caja");
    expect(html).not.toContain('value="future"');
  });
  it("requires a readable route detail even when it was in the list", async () => {
    mock.detail.mockResolvedValue(null);
    expect(await render("yesterday")).toContain("Recibir mi caja");
    expect(mock.screen).not.toHaveBeenCalled();
  });
  it("still opens reception by default if today's route does not exist yet", async () => {
    mock.routes = mock.routes.filter((r) => r.id !== "today");
    expect(await render()).toContain("Recibir mi caja");
    expect(await render("yesterday")).toContain("Reporte yesterday");
  });
  it("uses Lima's day around UTC midnight", async () => {
    vi.setSystemTime(new Date("2026-10-01T03:00:00Z"));
    expect(await render("yesterday")).toContain("Recibir mi caja");
    expect(await render("closed")).toContain("Reporte closed");
  });
  it("opens today's route after reception finishes", async () => {
    mock.loads = [];
    expect(await render("today")).toContain("Reporte today");
    expect(mock.screen.mock.calls[0]![0].receptionPending).toBe(false);
  });
  it.each(["confirmar", "ninguno"] as const)("preserves %s mode", async (mode) => {
    mock.mode = mode;
    expect(await render("today")).toContain("Reporte today");
  });
  it("does not offer an empty historical selector to a new rider", async () => {
    mock.routes = [];
    const html = await render();
    expect(html).toContain("Recibir mi caja");
    expect(html).not.toContain("Completar reportes anteriores");
  });
});
