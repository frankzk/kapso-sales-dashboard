import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAYMENT_BEFORE_ORDER_MAX_DAYS, paymentDateNotice, paymentDateVerdict } from "@/lib/payment-date-guard";

// Un Yape de días antes de crearse el pedido no lo paga: es de otra venta que
// alguien reutiliza. El nº de operación y la huella solo atrapan lo ya cargado;
// esto atrapa el Yape viejo que nunca se registró (02-10-2026).

const ORDER = "2026-10-02T19:11:03Z"; // #KP138399, 14:11 de Lima

describe("paymentDateVerdict", () => {
  it("el margen es de dos días", () => {
    expect(PAYMENT_BEFORE_ORDER_MAX_DAYS).toBe(2);
  });

  it("un pago posterior al pedido encaja", () => {
    expect(paymentDateVerdict("2026-10-02T17:55:00Z", "2026-10-01T10:00:00Z")).toEqual({ tooEarly: false, daysBefore: null });
  });

  it("un pago un poco anterior encaja: la clienta adelantó y el pedido se armó después", () => {
    expect(paymentDateVerdict("2026-10-01T15:00:00Z", ORDER).tooEarly).toBe(false);
    expect(paymentDateVerdict("2026-09-30T19:11:03Z", ORDER).tooEarly).toBe(false); // justo 2 días
  });

  it("más de dos días antes del pedido es un Yape de otra venta", () => {
    const v = paymentDateVerdict("2026-09-25T12:00:00Z", ORDER);
    expect(v.tooEarly).toBe(true);
    expect(v.daysBefore).toBe(7);
    expect(paymentDateNotice(v)).toContain("7 días antes de que se creara el pedido");
  });

  it("sin fecha leída o sin fecha del pedido no se juzga", () => {
    expect(paymentDateVerdict(null, ORDER).tooEarly).toBe(false);
    expect(paymentDateVerdict("no es fecha", ORDER).tooEarly).toBe(false);
    expect(paymentDateVerdict("2026-09-01T00:00:00Z", null).tooEarly).toBe(false);
  });

  it("registrar el pago lo manda a revisión administrativa y deja el motivo en la auditoría", () => {
    const src = readFileSync(join(process.cwd(), "app/dashboard/pedidos/payment-actions.ts"), "utf8");
    expect(src).toContain("const dateVerdict = paymentDateVerdict(paidAt, ctx.row.order_created_at);");
    expect(src).toContain("identityDiscrepancy || dateVerdict.tooEarly");
    expect(src).toContain("paid_too_early: dateVerdict.tooEarly");
  });
});
