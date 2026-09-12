import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ access: vi.fn(), update: vi.fn(), event: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mock.revalidate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "chief", email: "chief@example.test" }) }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/route-report-access", () => ({ routeReportAccess: mock.access }));
vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => ({ from: (table: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "delivery_stops" ? { id: "stop", route_id: "route", photo_path: null, voucher_path: null } : { id: "route", status: "en_curso" } }) }) }) }) }),
  createAdminSupabase: () => ({ from: () => ({ update: mock.update, insert: mock.event }) }),
}));
import { reportStop, type ReportStopInput } from "@/app/reparto/actions";
import { ReportForm } from "@/components/rider-route";
import type { StopWithOrder } from "@/lib/routes-access";
vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
const input: ReportStopInput = { stopId: "stop", status: "entregado", paymentMethod: "efectivo", collectedAmount: 30, outcomeReason: null, note: null, photoPath: "route/stop/entrega-proof.jpg", voucherPath: null, reportReason: "Roy sin conexión" };
describe("supervisor report", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.access.mockResolvedValue({ delegated: true, userId: "chief", actorLabel: "chief@example.test", riderName: "Roy" });
    mock.update.mockReturnValue({ eq: async () => ({ error: null }) });
    mock.event.mockResolvedValue({ error: null });
  });
  it("requires the supervisor reason before writing", async () => {
    expect((await reportStop({ ...input, reportReason: " " })).ok).toBe(false);
    expect(mock.update).not.toHaveBeenCalled();
  });
  it("blocks revoked access and cross-stop evidence", async () => {
    mock.access.mockResolvedValueOnce(null);
    expect((await reportStop(input)).ok).toBe(false);
    expect((await reportStop({ ...input, photoPath: "other/stop/image.jpg" })).ok).toBe(false);
    expect(mock.update).not.toHaveBeenCalled();
  });
  it("still requires photo and Yape voucher", async () => {
    expect((await reportStop({ ...input, photoPath: null })).ok).toBe(false);
    expect((await reportStop({ ...input, paymentMethod: "yape" })).ok).toBe(false);
    expect(mock.update).not.toHaveBeenCalled();
  });
  it("stores the real actor, reason, outcome and event, without changing the rider", async () => {
    expect((await reportStop(input)).ok).toBe(true);
    expect(mock.update).toHaveBeenCalledWith(expect.objectContaining({ reported_by: "chief", status: "entregado", note: expect.stringContaining("Roy sin conexión") }));
    expect(mock.update.mock.calls[0]![0]).not.toHaveProperty("rider_id");
    expect(mock.event).toHaveBeenCalledWith(expect.objectContaining({ actor: "chief", status: "entregado", note: expect.stringContaining("chief@example.test") }));
    expect(mock.revalidate).toHaveBeenCalledWith("/dashboard/rutas");
  });
  it("records non delivery and still requires an outcome reason", async () => {
    expect((await reportStop({ ...input, status: "no_entregado", outcomeReason: null })).ok).toBe(false);
    expect((await reportStop({ ...input, status: "no_entregado", outcomeReason: "otro", collectedAmount: null, note: "Dirección incompleta" })).ok).toBe(true);
  });
  it("does not require a delegation reason for the actual rider", async () => {
    mock.access.mockResolvedValue({ delegated: false });
    expect((await reportStop({ ...input, reportReason: null })).ok).toBe(true);
  });
  it("renders the additional reason field only for coordination", () => {
    const stop = { id: "stop", status: "pendiente", order: null } as StopWithOrder;
    const render = (delegated: boolean) => renderToStaticMarkup(createElement(ReportForm, { stop, delegated, onDone: vi.fn() }));
    expect(render(true)).toContain("Motivo del reporte por el motorizado");
    expect(render(true)).toContain('required=""');
    expect(render(false)).not.toContain("Motivo del reporte por el motorizado");
  });
});
