import { describe, expect, it, vi } from "vitest";
import { agencyPaymentWindow, agencyPaymentWindowLabel, agencyUnpaidHref } from "@/lib/agency-payment-cohort";
import { parseMasterQuery, buildMasterQuery, hasQueryFilters } from "@/lib/master-query";
import { emptyFilters, hasActiveFilters } from "@/lib/order-master-filters";
import { masterCohortQuery } from "@/lib/agency-payment-cohort-access";
import { buildMomOwnerSummary } from "@/lib/mom-owner-summary";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MomIndicators } from "@/components/mom-indicators";

describe("Agencia: del indicador a su cohorte pendiente", () => {
  it.each([
    ["2026-10-01", "2026-10-30"], ["2026-09-01", "2026-10-01"], ["2026-10-29", "2026-10-30"],
  ])("conserva %s a %s por URL, paginación y exportación", (from, to) => {
    const href = agencyUnpaidHref({ startIso: `${from}T05:00:00.000Z`, endIso: `${to}T05:00:00.000Z` });
    const parsed = parseMasterQuery(new URL(href, "https://example.test").searchParams);
    expect(parsed.filters.agencyUnpaid).toEqual({ from, to });
    expect(parsed.filters.createdFrom).toBe("");
    expect(parsed.filters.couriers.size).toBe(0);
    expect(hasQueryFilters(parsed.filters)).toBe(true);
    expect(hasActiveFilters(parsed.filters)).toBe(true);
    const next = parseMasterQuery(buildMasterQuery({ ...parsed, page: 3 }));
    expect(next.page).toBe(3);
    expect(next.filters.agencyUnpaid).toEqual({ from, to });
    expect(buildMasterQuery({ ...parsed, filters: emptyFilters() }).has("agency_unpaid")).toBe(false);
  });

  it.each([[null, null], ["2026-02-30", "2026-03-02"], ["2026-10-30", "2026-10-01"],
    ["2026-01-01", "2026-03-01"], ["2026-10-01", "2026-10-01"], ["x", "2026-10-30"]])("descarta una ventana inválida %s / %s", (from, to) => {
    expect(agencyPaymentWindow(from, to)).toBeNull();
  });

  it("explica el último día incluido, también al cambiar de mes", () => {
    expect(agencyPaymentWindowLabel({ from: "2026-09-01", to: "2026-10-01" })).toBe("01/09/2026 al 30/09/2026");
  });

  it("lista y conteo usan la misma RPC bajo la sesión, con fechas y tiendas", () => {
    const select = vi.fn(() => "query");
    const sb = { from: vi.fn(() => ({ select })), rpc: vi.fn(() => ({ select })) };
    const filters = { ...emptyFilters(), agencyUnpaid: { from: "2026-10-01", to: "2026-10-30" } };
    masterCohortQuery(sb as any, ["allowed-store"], filters, "order_id");
    masterCohortQuery(sb as any, ["allowed-store"], filters, "id", { count: "exact", head: true });
    expect(sb.rpc.mock.calls).toEqual([
      ["order_master_agency_payments", { p_store_ids: ["allowed-store"], p_from: "2026-10-01", p_to: "2026-10-30", p_bucket: "collect" }, undefined],
      ["order_master_agency_payments", { p_store_ids: ["allowed-store"], p_from: "2026-10-01", p_to: "2026-10-30", p_bucket: "collect" }, { count: "exact", head: true }],
    ]);
    expect(sb.from).not.toHaveBeenCalled();
    masterCohortQuery(sb as any, ["allowed-store"], emptyFilters(), "id");
    expect(sb.from).toHaveBeenCalledWith("order_master");
  });

  it("el KPI usa Estado de pago, incluido checkout, sin duplicar pedidos con varias guías", () => {
    const result = buildMomOwnerSummary({ today: "2026-10-29", manifests: [], events: [],
      orders: [
        { orderId: "web", orderTotal: 100, paymentState: "pago_completo" },
        { orderId: "cents", orderTotal: 0.3, paymentState: "pago_completo" }, { orderId: "partial", orderTotal: 100 },
      ].map((o) => ({ createdAt: null, coverage: "agencia", stage: null, substage: null, reasons: [], paymentState: null,
        deliveredAt: null, deliveredCourier: null, lastMovementAt: null, ...o })),
      shipments: ["web", "web", "cents", "partial"].map((id, i) => ({ id: String(i), orderId: id, courier: "shalom",
        createdAt: "2026-10-02T15:00:00Z", dispatchedAt: null, readyAt: null, custodyTransferredAt: null, deliveryStatus: "pendiente" })),
      payments: [{ orderId: "cents", amount: 0.1, paidAt: null }, { orderId: "cents", amount: 0.2, paidAt: null },
        { orderId: "partial", amount: 20, paidAt: null }],
    });
    expect(result.periods.find((p) => p.key === "month")!.kpis.agency_full_payment).toEqual({ numerator: 2, denominator: 3, rate: 2 / 3 });
  });

  it("renderiza el acceso al Master con el periodo visible y el número pendiente", () => {
    const summary = buildMomOwnerSummary({ today: "2026-10-29", orders: [], shipments: [], payments: [], events: [], manifests: [] });
    const month = summary.periods.find((p) => p.key === "month")!;
    month.agencyPayments = { complete: 837, collect: 87, validate: 2, historical: 225, excluded: 11, review: 0 };
    month.kpis.agency_full_payment = { numerator: 837, denominator: 1338, rate: 837 / 1338 };
    const html = renderToStaticMarkup(createElement(MomIndicators, { periods: [month], rows: [
      { key: "agency_full_payment", label: "Pago completo de Agencia", detail: "Pedidos pagados por completo" },
    ] }));
    expect(html).toContain('href="/dashboard/pedidos?agency_unpaid=1&amp;apf=2026-10-01&amp;apt=2026-10-30&amp;ps=pago_parcial%2Csin_pago"');
    expect(html).toContain("Por cobrar (87)");
    expect(html).toContain("Ver Pago completo de Agencia: Mes actual");
  });
});
