import { describe, expect, it, vi } from "vitest";
import { agencyPaymentBucket } from "@/lib/agency-payment-state";
import { agencyUnpaidHref } from "@/lib/agency-payment-cohort";
import { buildMasterQuery, parseMasterQuery, hasQueryFilters } from "@/lib/master-query";
import { emptyFilters, hasActiveFilters } from "@/lib/order-master-filters";
import { masterCohortQuery } from "@/lib/agency-payment-cohort-access";
import { buildMomOwnerSummary } from "@/lib/mom-owner-summary";

describe("Master payment state and historical reconciliation", () => {
  it.each([
    [{ paymentState: "pago_completo", platform: "shopify", financialStatus: "paid" }, "complete"],
    [{ paymentState: null, platform: "shopify", financialStatus: "paid" }, "historical"],
    [{ paymentState: "adelanto_validado", platform: "shopify", financialStatus: " PAID " }, "historical"],
    [{ paymentState: null, platform: "shopify", financialStatus: "paid", totalRefunded: 1 }, "collect"],
    [{ paymentState: null, platform: "woocommerce", financialStatus: "paid" }, "collect"],
    [{ paymentState: "adelanto_validado" }, "collect"],
    [{ paymentState: null, generalStatus: "entregado" }, "collect"],
    [{ paymentState: "sin_pago" }, "collect"],
    [{ paymentState: "pago_total_cargado" }, "validate"],
    [{ paymentState: "posible_duplicado" }, "validate"],
    [{ paymentState: "adelanto_validado", generalStatus: "anulado" }, "excluded"],
    [{ paymentState: null, generalStatus: "devuelto" }, "excluded"],
    [{ paymentState: "future_state" }, "review"],
  ])("classifies evidence without treating delivered as paid: %j", (fact, expected) => {
    expect(agencyPaymentBucket(fact)).toBe(expected);
  });

  it("keeps 358 old exceptions separate: 35 complete, 225 historical, 11 cancelled, 87 collect", () => {
    const facts = [
      ...Array.from({ length: 35 }, () => ({ paymentState: "pago_completo" })),
      ...Array.from({ length: 225 }, () => ({ paymentState: null, platform: "shopify", financialStatus: "paid" })),
      ...Array.from({ length: 11 }, () => ({ paymentState: "adelanto_validado", generalStatus: "anulado" })),
      ...Array.from({ length: 87 }, () => ({ paymentState: "adelanto_validado" })),
    ].map((fact, i) => ({ orderId: `order-${i}`, createdAt: null, coverage: "agencia", orderTotal: 100, stage: null, substage: null, reasons: [], deliveredAt: null, deliveredCourier: null, lastMovementAt: null, ...fact }));
    const summary = buildMomOwnerSummary({ today: "2026-11-12", orders: facts,
      shipments: facts.map((fact, i) => ({ id: String(i), orderId: fact.orderId, courier: "shalom", createdAt: "2026-10-02T12:00:00Z", dispatchedAt: null, readyAt: null, custodyTransferredAt: null, deliveryStatus: "pendiente" })), payments: [], events: [], manifests: [] });
    const period = summary.periods.find(p => p.key === "previous_month")!;
    expect(period.agencyPayments).toEqual({ complete: 35, historical: 225, excluded: 11, collect: 87, validate: 0, review: 0 });
    expect(period.kpis.agency_full_payment).toEqual({ numerator: 35, denominator: 122, rate: 35 / 122 });
  });

  it("does not let receipt sums contradict the Master payment status", () => {
    expect(agencyPaymentBucket({ paymentState: "pago_completo" })).toBe("complete");
    expect(agencyPaymentBucket({ paymentState: "adelanto_validado" })).toBe("collect");
  });

  it.each(["all", "complete", "collect", "validate", "historical", "review"] as const)("roundtrips the exact indicator queue %s and dates", bucket => {
    const href = agencyUnpaidHref({ startIso: "2026-10-01T05:00:00Z", endIso: "2026-11-01T05:00:00Z" }, bucket);
    const parsed = parseMasterQuery(new URL(href, "https://kapta.test").searchParams);
    const again = parseMasterQuery(buildMasterQuery({ ...parsed, page: 2 }));
    expect(again.filters.agencyUnpaid).toEqual({ from: "2026-10-01", to: "2026-11-01" });
    expect(again.filters.historicalPaid).toBe(bucket === "historical");
    expect(again.filters.agencyPaymentView).toBe(bucket === "historical" ? "collect" : bucket);
  });

  it("can reconcile all dates separately and intersect Estado de pago without granting broader stores", () => {
    const parsed = parseMasterQuery(new URLSearchParams("historical_paid=1&ps=pago_parcial"));
    expect(parsed.filters.paymentStates).toEqual(new Set(["pago_parcial"]));
    expect(parsed.filters.agencyUnpaid).toBeNull();
    expect(hasActiveFilters(parsed.filters)).toBe(true);
    expect(hasQueryFilters(parsed.filters)).toBe(true);
    const select = vi.fn(); const rpc = vi.fn(() => ({ select }));
    masterCohortQuery({ rpc } as any, ["granted"], parsed.filters, "id");
    expect(rpc).toHaveBeenCalledWith("order_master_agency_payments", { p_store_ids: ["granted"], p_from: null, p_to: null, p_bucket: "historical" }, undefined);
    expect(buildMasterQuery({ ...parsed, filters: emptyFilters() }).has("historical_paid")).toBe(false);
  });
});
