import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { panelPrefetchOrder, pickLeadsEntry, sanitizeDashboardPath } from "@/lib/client-performance";
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
    expect(sanitizeDashboardPath("/dashboard/pagos?order=private-id")).toBe("/dashboard/pagos");
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

// 27-11-2026: «Por llamar» manda la cola entera al navegador (~11 MB por tienda). Antes de cambiar cómo se lee,
// se mide lo que pesa y lo que espera la asesora. Solo números.
describe("lo que pesa y tarda la cola de Leads", () => {
  it("la métrica lleva solo números acotados", () => {
    expect(parseClientPerformanceMetric({
      name: "leads:board-data", durationMs: 4210.4, rows: 6711, downloadMs: 1830.6, kb: 11264, transferKb: 1490, connection: "4g",
    })).toEqual({ name: "leads:board-data", durationMs: 4210, rows: 6711, downloadMs: 1831, kb: 11264, transferKb: 1490, connection: "4g" });
    for (const bad of [{ rows: -1 }, { rows: "6711" }, { kb: Number.NaN }, { downloadMs: 999_999 }, { transferKb: 2_000_000 }]) {
      expect(parseClientPerformanceMetric({ name: "leads:board-data", durationMs: 10, ...bad }), JSON.stringify(bad)).toBeNull();
    }
    // Las demás métricas no cambian.
    expect(parseClientPerformanceMetric({ name: "kapso:call-save", durationMs: 379 })).toEqual({ name: "kapso:call-save", durationMs: 379 });
  });

  it("cuenta la respuesta que trajo lo pintado: la más nueva, no contada, pedida antes de pintar", () => {
    const navigation = { startTime: 0, responseEnd: 900 };
    const refresh = { startTime: 300_000, responseEnd: 301_500 };
    const later = { startTime: 305_000, responseEnd: 305_800 };
    // Primera carga: la navegación.
    expect(pickLeadsEntry([navigation], 2_000, -1)).toBe(navigation);
    // Una recarga: la más nueva que no se contó.
    expect(pickLeadsEntry([refresh, navigation], 302_400, 0)).toBe(refresh);
    // Una que se pidió después de pintar no es la de lo pintado.
    expect(pickLeadsEntry([later], 302_400, 0)).toBeNull();
    // Ya contada, no se cuenta dos veces; sin terminar de bajar, tampoco.
    expect(pickLeadsEntry([refresh], 302_400, 300_000)).toBeNull();
    expect(pickLeadsEntry([{ startTime: 310_000, responseEnd: 0 }], 312_000, 0)).toBeNull();
  });

  it("el panel empieza a anotar al montar y el tablero mide cada llegada de la cola", () => {
    const shell = readFileSync("components/dashboard-shell.tsx", "utf8");
    expect(shell).toContain("watchLeadsPayloads();");
    const board = readFileSync("components/leads.tsx", "utf8");
    expect(board).toContain("reportLeadsBoardData(serverLeads.length);\n  }, [serverLeads]);");
  });
});

