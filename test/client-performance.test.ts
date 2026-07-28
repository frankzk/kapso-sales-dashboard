import { describe, expect, it } from "vitest";
import { panelPrefetchOrder, sanitizeDashboardPath } from "@/lib/client-performance";
import {
  DASHBOARD_SECTIONS,
  parseClientPerformanceMetric,
} from "@/lib/performance-metrics";

describe("panel prefetch", () => {
  it("prioritizes the likely next operational panels without refetching the current one", () => {
    expect(panelPrefetchOrder("/dashboard/leads?store=secret", false)).toEqual([
      "/dashboard/pedidos",
      "/dashboard/envios",
      "/dashboard/productividad",
    ]);
    // Una vendedora no tiene Consolidado ni Productividad global: solo se
    // precalientan los paneles que sí puede abrir.
    expect(panelPrefetchOrder("/dashboard/envios", true)).toEqual([
      "/dashboard/pedidos",
      "/dashboard/leads",
    ]);
  });

  it("removes query strings and dynamic ids from reported routes", () => {
    expect(sanitizeDashboardPath("/dashboard/leads?store=private-id")).toBe("/dashboard/leads");
    expect(sanitizeDashboardPath("/dashboard/pedidos?view=devuelto")).toBe("/dashboard/pedidos");
    expect(sanitizeDashboardPath("/dashboard/4c6522f9-c775/settings")).toBe("/dashboard/other");
  });

  // La regresión que esto cierra: el cliente reducía a `/dashboard/pedidos` y el
  // servidor no lo tenía en su lista, así que descartaba la medición con un 400.
  // El panel más pesado era el único sin datos, y nada falló para avisarlo.
  it("every route the browser can emit is accepted by the endpoint", () => {
    const emitted = ["/dashboard", "/dashboard/other", ...DASHBOARD_SECTIONS.map((s) => `/dashboard/${s}`)];
    for (const route of emitted) {
      expect(sanitizeDashboardPath(route), `${route} no sobrevive al saneado`).toBe(route);
      expect(
        parseClientPerformanceMetric({ name: "dashboard:navigation", durationMs: 10, from: "/dashboard", to: route }),
        `el endpoint rechaza ${route}`,
      ).not.toBeNull();
    }
  });

  it("still refuses a section that is not in the list", () => {
    expect(
      parseClientPerformanceMetric({
        name: "dashboard:navigation",
        durationMs: 10,
        to: "/dashboard/4c6522f9-c775-4be3-95b0-160a3c16d27a",
      }),
    ).toBeNull();
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
