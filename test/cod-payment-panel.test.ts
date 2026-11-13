// La tarjeta de Cobro en un pedido contra entrega (owner, 13-11-2026: «cómo
// marco pagado un pedido de Lima, para que salga con el rótulo de Pagado»).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codPaymentPanel } from "@/lib/order-payment-panel";
import { expectedCollectAmount, orderFullyPaid } from "@/lib/order-paid";

const hidden = { show: false, mode: "optional" as const };

describe("Cobro opcional en contra entrega", () => {
  it("Lima o Provincia COD abiertos la llevan, opcional", () => {
    // Lima, plegada (owner, 13-11-2026); Provincia COD, abierta.
    expect(codPaymentPanel(hidden, { macro_operation: "lima", general_status: "en_proceso" })).toEqual({ show: true, mode: "optional", collapsed: true });
    expect(codPaymentPanel(hidden, { macro_operation: "provincia_cod", general_status: "en_proceso" })).toEqual({ show: true, mode: "optional" });
  });

  it("cerrados, Agencia sin motivo o lo que ya se dibujaba no cambian", () => {
    expect(codPaymentPanel(hidden, { macro_operation: "lima", general_status: "entregado" })).toEqual(hidden);
    expect(codPaymentPanel(hidden, { macro_operation: "lima", general_status: "anulado" })).toEqual(hidden);
    expect(codPaymentPanel(hidden, { macro_operation: "agencia", general_status: "en_proceso" })).toEqual(hidden);
    const required = { show: true, mode: "required" as const };
    expect(codPaymentPanel(required, { macro_operation: "lima", general_status: "en_proceso" })).toBe(required);
    expect(codPaymentPanel(hidden, null)).toEqual(hidden);
  });

  it("con el total validado, el rótulo dice PAGADO y no se cobra en la puerta", () => {
    expect(orderFullyPaid({ paymentState: "pago_completo" })).toBe(true);
    expect(expectedCollectAmount({ paymentState: "pago_completo" }, 149)).toBe(0);
    expect(readFileSync("lib/labels/rotulo-pdf.ts", "utf8")).toContain('"PAGADO - NO COBRAR"');
  });

  it("solo la ficha: Leads sigue con orderPaymentPanelFor", () => {
    const drawer = readFileSync("components/order-drawer.tsx", "utf8");
    expect(drawer).toContain("codPaymentPanel(paymentSetup.presentation, detail?.row ?? null)");
    expect(drawer).toContain("{paymentPanel.collapsed ? (");
    expect(drawer).toContain('<span className="block text-sm font-semibold text-ink-900">Cobro anticipado</span>');
    expect(readFileSync("docs/mom/master-pedidos-v1.md", "utf8")).toContain("**Contra entrega pagado por adelantado: la tarjeta de Cobro en la ficha");
  });
});
