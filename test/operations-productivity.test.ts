import { describe, it, expect } from "vitest";
import {
  productivitySection,
  productivityHref,
  activityMetric,
  SECTION_METRICS,
  type OperationsPerson,
} from "@/lib/operations-productivity";

describe("productivity sections and metrics", () => {
  it("defaults to the full overview and rejects forged sections", () => {
    expect(productivitySection(undefined)).toBe("resumen");
    expect(productivitySection("forged")).toBe("resumen");
    expect(productivitySection("repro_lima")).toBe("repro_lima");
  });
  it("preserves the date/store across sections without colliding with the global order drawer", () => {
    const url = new URL(
      productivityHref(
        "diferencia",
        { from: "2026-11-01", to: "2026-11-12" },
        "store",
        null,
        "meta_ad",
      ),
      "https://kapta.test",
    );
    expect(url.searchParams.get("area")).toBe("diferencia");
    expect(url.searchParams.get("store")).toBe("store");
    expect(url.searchParams.get("from")).toBe("2026-11-01");
    expect(url.searchParams.has("seccion")).toBe(false);
    expect(url.searchParams.has("src")).toBe(false);
  });
  it("retains exact month and the source only in the commercial leads view", () => {
    const url = new URL(
      productivityHref(
        "leads",
        { from: "2026-11-01", to: "2026-11-12" },
        null,
        "2026-10",
        "cod_cart",
      ),
      "https://kapta.test",
    );
    expect(url.searchParams.get("mes")).toBe("2026-10");
    expect(url.searchParams.has("from")).toBe(false);
    expect(url.searchParams.get("src")).toBe("cod_cart");
  });
  it("uses distinct orders for confirmation and money only for validated amounts", () => {
    const person = {
      counts: {
        confirmed: { count: 4, orders: 3, amount: 0 },
        payment_registered: { count: 9, orders: 5, amount: 500 },
        payment_validated: { count: 2, orders: 2, amount: 80 },
      },
    };
    expect(
      activityMetric(
        person,
        SECTION_METRICS.master.find((m) => m.key === "confirmed")!,
      ),
    ).toBe(3);
    expect(
      activityMetric(person, SECTION_METRICS.pagos.find((m) => m.amount)!),
    ).toBe(80);
    expect(activityMetric(person, SECTION_METRICS.almacen[0]!)).toBe(0);
  });
});
