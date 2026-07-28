import { describe, expect, it } from "vitest";
import {
  checkTandersPayment,
  isExpectedRecipient,
  normalizeRecipient,
} from "@/lib/tanders/payment-check";

/** Comprobante bueno: Yape a Grupo GF SAC por lo que dice la guía. */
function voucher(over: Partial<Parameters<typeof checkTandersPayment>[0]["voucher"]> = {}) {
  return {
    ok: true,
    isVoucher: true,
    recipientName: "Grupo GF SAC",
    amount: 89,
    operationNumber: "12345678",
    ...over,
  };
}

describe("normalizeRecipient / isExpectedRecipient", () => {
  it("ignora puntuación, acentos y mayúsculas", () => {
    expect(normalizeRecipient("GRUPO G.F. S.A.C.")).toBe("grupogfsac");
    expect(isExpectedRecipient("GRUPO G.F. S.A.C.")).toBe(true);
    expect(isExpectedRecipient("grupo gf sac")).toBe(true);
  });

  it("acepta el nombre recortado que muestra Yape", () => {
    expect(isExpectedRecipient("Grupo GF")).toBe(true);
  });

  it("rechaza otra cuenta", () => {
    expect(isExpectedRecipient("Juan Pérez")).toBe(false);
    expect(isExpectedRecipient("Grupo XY SAC")).toBe(false);
    expect(isExpectedRecipient(null)).toBe(false);
  });
});

describe("checkTandersPayment", () => {
  it("valida el caso bueno", () => {
    const v = checkTandersPayment({ voucher: voucher(), expectedAmount: 89 });
    expect(v.state).toBe("validado");
    expect(v.reasons).toEqual([]);
  });

  it("rechaza un Yape a otra cuenta y dice a quién se pagó", () => {
    const v = checkTandersPayment({
      voucher: voucher({ recipientName: "Juan Pérez" }),
      expectedAmount: 89,
    });
    expect(v.state).toBe("rechazado");
    expect(v.reasons).toContain("destinatario_distinto");
    expect(v.summary).toContain("Juan Pérez");
  });

  it("rechaza un monto que no cuadra y muestra los dos", () => {
    const v = checkTandersPayment({ voucher: voucher({ amount: 50 }), expectedAmount: 89 });
    expect(v.state).toBe("rechazado");
    expect(v.reasons).toContain("monto_distinto");
    expect(v.summary).toContain("50.00");
    expect(v.summary).toContain("89.00");
  });

  it("tolera el redondeo de céntimos, no una diferencia real", () => {
    expect(checkTandersPayment({ voucher: voucher({ amount: 89.5 }), expectedAmount: 89 }).state).toBe(
      "validado",
    );
    expect(checkTandersPayment({ voucher: voucher({ amount: 90 }), expectedAmount: 89 }).state).toBe(
      "rechazado",
    );
  });

  it("rechaza una imagen que no es comprobante sin mirar el resto", () => {
    const v = checkTandersPayment({
      voucher: voucher({ isVoucher: false, recipientName: null, amount: null }),
      expectedAmount: 89,
    });
    expect(v.state).toBe("rechazado");
    expect(v.reasons).toEqual(["no_es_comprobante"]);
  });

  it("un fallo del lector queda PENDIENTE, no rechazado", () => {
    // Distinguirlos importa: un rechazo manda a investigar un fraude, y un
    // timeout del modelo no es un fraude.
    const v = checkTandersPayment({ voucher: voucher({ ok: false }), expectedAmount: 89 });
    expect(v.state).toBe("pendiente");
    expect(v.reasons).toEqual([]);
  });

  it("junta los dos motivos cuando fallan a la vez", () => {
    const v = checkTandersPayment({
      voucher: voucher({ recipientName: "Otro", amount: 10 }),
      expectedAmount: 89,
    });
    expect(v.reasons).toEqual(["destinatario_distinto", "monto_distinto"]);
  });

  it("no valida a ciegas cuando no se pudo leer un campo", () => {
    expect(
      checkTandersPayment({ voucher: voucher({ recipientName: null }), expectedAmount: 89 }).reasons,
    ).toContain("sin_destinatario");
    expect(
      checkTandersPayment({ voucher: voucher({ amount: null }), expectedAmount: 89 }).reasons,
    ).toContain("sin_monto");
  });

  it("sin monto esperado no inventa una discrepancia", () => {
    const v = checkTandersPayment({ voucher: voucher(), expectedAmount: null });
    expect(v.state).toBe("validado");
  });
});
