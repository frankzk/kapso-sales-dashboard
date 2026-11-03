import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { paidCoversTotal, remainingCents } from "@/lib/payment-rounding";
import { paymentProgress, paymentState, type PaymentSnapshot } from "@/lib/pickup-key";
import { pendingBalance } from "@/lib/shalom/transit-notify";

// #KP200188 y #KP142802: total S/ 134,10, adelanto S/ 30 + diferencia S/ 104.
const pagos = (diferencia: number, estado = "validado"): PaymentSnapshot[] => [
  { id: "a", order_id: "o", kind: "adelanto", amount: 30, validation_status: "validado" },
  { id: "d", order_id: "o", kind: "diferencia", amount: diferencia, validation_status: estado },
];

describe("redondeo de la clienta: faltar menos de S/ 1 está pagado (MOM §6.5)", () => {
  it("cubre si faltan 99 céntimos o menos, y no si falta S/ 1", () => {
    expect(paidCoversTotal(13400, 13410)).toBe(true);
    expect(paidCoversTotal(13311, 13410)).toBe(true);
    expect(paidCoversTotal(13310, 13410)).toBe(false);
    expect(paidCoversTotal(13500, 13410)).toBe(true);
  });

  it("sin pago o sin total no cubre nada", () => {
    expect(paidCoversTotal(0, 50)).toBe(false);
    expect(paidCoversTotal(100, null)).toBe(false);
    expect(paidCoversTotal(100, 0)).toBe(false);
  });

  it("el saldo perdona el redondeo, no lo demás", () => {
    expect(remainingCents(13400, 13410)).toBe(0);
    expect(remainingCents(13000, 13410)).toBe(410);
  });

  it("S/ 30 + S/ 104 sobre S/ 134,10 es pago completo y sin saldo", () => {
    const progress = paymentProgress(pagos(104), 134.1);
    expect(progress.completeValidated).toBe(true);
    expect(progress.validatedRemaining).toBe(0);
    expect(paymentState(pagos(104), 134.1)).toBe("pago_completo");
    expect(pendingBalance(134.1, 134)).toBe(0);
  });

  it("faltar S/ 4,10 sigue siendo diferencia pendiente", () => {
    expect(paymentState(pagos(100), 134.1)).toBe("adelanto_validado");
    expect(paymentProgress(pagos(100), 134.1).validatedRemaining).toBe(4.1);
    expect(pendingBalance(134.1, 130)).toBe(4.1);
  });

  it("lo cargado sin validar no cuenta como cobrado", () => {
    expect(paymentState(pagos(104, "pendiente"), 134.1)).toBe("diferencia_cargada");
    expect(paymentProgress(pagos(104, "pendiente"), 134.1).completeValidated).toBe(false);
  });
});

describe("0293: el turno de la base hace la misma cuenta", () => {
  const sql = readFileSync("db/migrations/0293_invoices_claim_rounding.sql", "utf8");
  const s0269 = readFileSync("db/migrations/0269_invoices_backfill.sql", "utf8");
  const body = (s: string) => s.slice(s.indexOf("create or replace function invoice_claim("), s.indexOf("$$;\nrevoke all"));

  it("rechaza solo si falta S/ 1 o más", () => {
    expect(sql).toContain("if v_live = 0 or v_validated <= p_total - 1 then");
    expect(sql).not.toContain("v_validated < p_total then");
  });

  it("el resto del turno es el de la 0269, letra por letra", () => {
    const sinCondicion = (s: string) =>
      body(s)
        .replace(/ {4}-- Lo validado cubre el total[\s\S]*?\n {4}if v_live = 0 or v_validated [^\n]*\n/, "")
        .trim();
    expect(sinCondicion(sql)).toBe(sinCondicion(s0269));
  });

  it("se detiene sin la 0269 y mantiene el turno solo para service_role", () => {
    expect(sql).toContain("La 0293 va después de la 0269");
    expect(sql).toContain("revoke all on function invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid, boolean)");
    expect(sql).toMatch(/grant execute on function invoice_claim\([^)]*boolean\)\s+to service_role;/);
  });
});
