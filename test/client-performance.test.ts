import { describe, expect, it } from "vitest";
import { panelPrefetchOrder, sanitizeDashboardPath } from "@/lib/client-performance";
import { parseClientPerformanceMetric } from "@/lib/performance-metrics";

describe("panel prefetch", () => {
  it("prioritizes the likely next operational panels without refetching the current one", () => {
    expect(panelPrefetchOrder("/dashboard/leads?store=secret", false)).toEqual([
      "/dashboard/envios",
      "/dashboard/productividad",
      "/dashboard",
    ]);
    expect(panelPrefetchOrder("/dashboard/envios", true)).toEqual(["/dashboard/leads"]);
  });

  it("removes query strings and dynamic ids from reported routes", () => {
    expect(sanitizeDashboardPath("/dashboard/leads?store=private-id")).toBe("/dashboard/leads");
    expect(sanitizeDashboardPath("/dashboard/4c6522f9-c775/settings")).toBe("/dashboard/other");
  });
});

describe("client performance payload", () => {
  it("accepts a bounded privacy-safe navigation measurement", () => {
    expect(parseClientPerformanceMetric({
      name: "dashboard:navigation",
      durationMs: 842.6,
      from: "/dashboard/leads",
      to: "/dashboard/productividad",
      prefetched: true,
      prefetchLeadMs: 1500.4,
      connection: "4g",
    })).toEqual({
      name: "dashboard:navigation",
      durationMs: 843,
      from: "/dashboard/leads",
      to: "/dashboard/productividad",
      prefetched: true,
      prefetchLeadMs: 1500,
      connection: "4g",
    });
  });

  it("rejects unknown metrics, private routes and unreasonable durations", () => {
    expect(parseClientPerformanceMetric({ name: "unknown", durationMs: 10 })).toBeNull();
    expect(parseClientPerformanceMetric({
      name: "dashboard:navigation",
      durationMs: 10,
      to: "/customers/51990000000",
    })).toBeNull();
    expect(parseClientPerformanceMetric({ name: "kapso:call-save", durationMs: 999_999 })).toBeNull();
  });
});
