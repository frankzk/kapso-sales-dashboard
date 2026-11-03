import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams("from=2026-10-01&to=2026-10-31"),
}));

const { MomIndicators } = await import("@/components/mom-indicators");
const { buildMomOwnerSummary } = await import("@/lib/mom-owner-summary");

const ROWS = [{ key: "agency_full_payment" as const, label: "Pago completo de Agencia", detail: "Pagados por completo" }];
const MONTHS = [
  { month: "2026-09", label: "Septiembre 2026" },
  { month: "2025-01", label: "Enero 2025" },
];

describe("«Cierre y entregas»: Otro mes… (02-11-2026)", () => {
  it("con un mes traído del servidor, lo muestra elegido y sus cifras son las de ese mes", () => {
    const summary = buildMomOwnerSummary({
      today: "2026-11-02", month: "2026-09", orders: [], shipments: [], payments: [], events: [], manifests: [],
    });
    const html = renderToStaticMarkup(createElement(MomIndicators, { periods: summary.periods, rows: ROWS, otherMonths: MONTHS }));
    expect(html).toContain('<option value="2026-09" selected="">Septiembre 2026</option>');
    expect(html).toContain("Enero 2025");
    expect(html).toContain("Ver pedidos de Agencia sin pago completo: Septiembre 2026");
    expect(html).toContain("apf=2026-09-01&amp;apt=2026-10-01");
  });

  it("sin mes elegido entra en 7 días y el select dice «Otro mes…»", () => {
    const summary = buildMomOwnerSummary({ today: "2026-11-02", orders: [], shipments: [], payments: [], events: [], manifests: [] });
    const html = renderToStaticMarkup(createElement(MomIndicators, { periods: summary.periods, rows: ROWS, otherMonths: MONTHS }));
    expect(html).toContain("Otro mes…");
    expect(html).not.toContain("selected=\"\">Septiembre");
    expect(html).toContain("Ver pedidos de Agencia sin pago completo: Últimos 7 días");
  });
});
