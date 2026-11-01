import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENCY_SHIPPING_MAX, agencyShippingPaid } from "@/lib/agency-shipping";
import { DISCOUNT_EXCEPTION_MAX } from "@/lib/pickup-key";

const pagos = (diferencia: number, estadoDiferencia = "validado") => [
  { kind: "adelanto", validation_status: "validado", amount: 30 },
  { kind: "diferencia", validation_status: estadoDiferencia, amount: diferencia },
];
// #KP136735: S/ 149, 30 + 111 validados, recogido en Shalom: faltan S/ 8.
const base = { operation: "agencia", pickedUp: true, orderTotal: 149 };

describe("envío pagado en la agencia (owner, 01-11-2026, MOM §6.5)", () => {
  it("con el paquete recogido, lo que falta hasta S/ 15 es el envío", () => {
    expect(agencyShippingPaid({ ...base, payments: pagos(111) })).toBe(8);
    expect(agencyShippingPaid({ ...base, payments: pagos(104) })).toBe(15);
  });

  it("el tope es el de la excepción por descuento de la clave", () => {
    expect(AGENCY_SHIPPING_MAX).toBe(DISCOUNT_EXCEPTION_MAX);
    expect(AGENCY_SHIPPING_MAX).toBe(15);
    expect(agencyShippingPaid({ ...base, payments: pagos(103.99) })).toBeNull();
  });

  it("no aplica antes del recojo ni fuera de Agencia", () => {
    expect(agencyShippingPaid({ ...base, pickedUp: false, payments: pagos(111) })).toBeNull();
    expect(agencyShippingPaid({ ...base, operation: "provincia_cod", payments: pagos(111) })).toBeNull();
  });

  it("pide dos pagos validados con el adelanto, y ninguno en revisión", () => {
    expect(agencyShippingPaid({ ...base, payments: [{ kind: "adelanto", validation_status: "validado", amount: 141 }] })).toBeNull();
    expect(agencyShippingPaid({ ...base, payments: pagos(111, "pendiente") })).toBeNull();
    expect(
      agencyShippingPaid({
        ...base,
        payments: [
          { kind: "diferencia", validation_status: "validado", amount: 30 },
          { kind: "diferencia", validation_status: "validado", amount: 111 },
        ],
      }),
    ).toBeNull();
    // Un pago rechazado no cuenta ni bloquea.
    expect(
      agencyShippingPaid({ ...base, payments: [...pagos(111), { kind: "diferencia", validation_status: "rechazado", amount: 8 }] }),
    ).toBe(8);
  });

  it("menos de S/ 1 es redondeo, no envío; y lo cubierto no tiene envío", () => {
    expect(agencyShippingPaid({ ...base, orderTotal: 134.1, payments: pagos(104) })).toBeNull();
    expect(agencyShippingPaid({ ...base, payments: pagos(119) })).toBeNull();
  });
});

describe("donde se usa", () => {
  it("el Master resuelve pago completo y vuelve a resolver la macroetapa", () => {
    const src = readFileSync("lib/order-master.ts", "utf8");
    expect(src).toContain("agencyShippingPaid({");
    expect(src).toContain("macro = resolveMacroStage({ ...macroInput, paymentState: resolvedPaymentState });");
  });

  it("la ficha lo muestra como envío, no como saldo", () => {
    const panel = readFileSync("components/pickup-key-panel.tsx", "utf8");
    expect(panel).toContain('label: "Envío pagado en agencia"');
  });

  it("0296: el turno de la boleta hace la misma cuenta, y el resto es la 0293", () => {
    const sql = readFileSync("db/migrations/0296_invoices_claim_agency_shipping.sql", "utf8");
    const s0293 = readFileSync("db/migrations/0293_invoices_claim_rounding.sql", "utf8");
    expect(sql).toContain("and p_total - v_validated <= 15");
    expect(sql).toContain("om.macro_operation = 'agencia'");
    expect(sql).toContain("La 0296 va después de la 0293");
    const sinCondicion = (s: string) =>
      s
        .slice(s.indexOf("create or replace function invoice_claim("))
        .replace(/ {4}-- Lo validado cubre el total[\s\S]*?return jsonb_build_object\('reason', 'sin_pago_completo'\);\n {4}end if;\n/, "")
        .trim();
    expect(sinCondicion(sql)).toBe(sinCondicion(s0293));
  });
});
