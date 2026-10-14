// Constancia de Flow subida a mano (MOM §12, 14-10-2026). La pantalla
// «¡Tu pago se ha concretado exitosamente!» no trae «Pagado a» ni un nº de
// operación de banco: el lector no encontraba nada seguro y la daba por «no
// parece un Yape» (#KP141432, orden de Flow 184932654). Ahora se lee su «Nº de
// orden» y se le pregunta a Flow: si Flow la confirma pagada en nuestra
// cuenta, entra validada por la pasarela, como un pago por link de Kapta.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FlowClient } from "@/lib/flow/client";
import { FlowApiError, FlowTimeoutError, type FlowPaymentStatus } from "@/lib/flow/types";
import { signFlowParams } from "@/lib/flow/sign";
import {
  checkFlowReceipt,
  describeFlowReceipt,
  flowDateToIso,
  flowReceiptFromStatus,
  flowRegistrationStatus,
  type FlowReceiptCheck,
} from "@/lib/flow/verify";
import { extractYapeVoucher } from "@/lib/vision";
import { FLOW_RECIPIENT_NAME, voucherReading } from "@/lib/voucher-inspect";
import { yapeRecipientReadingFromVision } from "@/lib/yape-recipient";

const PAGADA: FlowPaymentStatus = {
  flowOrder: 184932654,
  commerceOrder: "shop-1042",
  requestDate: "2026-10-14 14:10:02",
  status: 2,
  subject: "Pedido",
  currency: "PEN",
  amount: 116,
  payer: "cliente@correo.pe",
  paymentData: { date: "2026-10-14 14:18:43", media: "TC", amount: 116 },
};

describe("Flow por nº de orden", () => {
  it("consulta payment/getStatusByFlowOrder con todo firmado", async () => {
    let url = "";
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      url = String(u);
      return new Response(JSON.stringify(PAGADA), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await new FlowClient({ apiKey: "K", secretKey: "S", fetchImpl }).getStatusByFlowOrder("184932654");
    expect(res.status).toBe(2);
    const q = new URL(url);
    expect(q.pathname).toBe("/api/payment/getStatusByFlowOrder");
    const { s, ...firmados } = Object.fromEntries(q.searchParams.entries());
    expect(firmados).toEqual({ apiKey: "K", flowOrder: "184932654" });
    expect(s).toBe(signFlowParams(firmados, "S"));
  });

  it("un nº de orden que no son dígitos no sale", async () => {
    await expect(new FlowClient({ apiKey: "K", secretKey: "S" }).getStatusByFlowOrder("abc")).rejects.toThrow();
  });

  it("la fecha de Flow viene sin zona y es hora de Lima", () => {
    expect(flowDateToIso("2026-10-14 14:18:43")).toBe("2026-10-14T19:18:43.000Z");
    expect(flowDateToIso("basura")).toBeNull();
  });

  it("pagada: lo que entró, el medio y cuándo", () => {
    expect(flowReceiptFromStatus("184932654", PAGADA)).toEqual({
      state: "pagado",
      flowOrder: "184932654",
      amount: 116,
      paidAt: "2026-10-14T19:18:43.000Z",
      media: "TC",
      payer: "cliente@correo.pe",
      commerceOrder: "shop-1042",
    });
    expect(flowReceiptFromStatus("1", { ...PAGADA, status: 1 })).toEqual({ state: "no_pagado", flowOrder: "1", status: 1 });
  });

  it("una orden que no es de nuestra cuenta no es un fallo de Flow", async () => {
    const otraCuenta = { getStatusByFlowOrder: vi.fn().mockRejectedValue(new FlowApiError("Transaction not found", 400, 105)) };
    expect(await checkFlowReceipt(otraCuenta, "9")).toMatchObject({ state: "no_encontrado" });
    const caida = { getStatusByFlowOrder: vi.fn().mockRejectedValue(new FlowTimeoutError("sin respuesta")) };
    expect(await checkFlowReceipt(caida, "9")).toMatchObject({ state: "error" });
    const llaveMala = { getStatusByFlowOrder: vi.fn().mockRejectedValue(new FlowApiError("apiKey not found", 401)) };
    expect(await checkFlowReceipt(llaveMala, "9")).toMatchObject({ state: "error" });
  });
});

describe("con qué estado entra", () => {
  const pagado = flowReceiptFromStatus("184932654", PAGADA);
  const base = { operation: "184932654", amount: 116, identityDiscrepancy: false, tooEarly: false };

  it("Flow la confirma pagada: entra validada", () => {
    expect(flowRegistrationStatus(pagado, base)).toBe("validado");
    // Registrar menos de lo que entró también (un adelanto parcial).
    expect(flowRegistrationStatus(pagado, { ...base, amount: 100 })).toBe("validado");
  });

  it("nada que no cuadre entra validado", () => {
    expect(flowRegistrationStatus(pagado, { ...base, amount: 116.1 })).toBeNull();
    expect(flowRegistrationStatus(pagado, { ...base, operation: "999" })).toBeNull();
    expect(flowRegistrationStatus(pagado, { ...base, identityDiscrepancy: true })).toBeNull();
    expect(flowRegistrationStatus(pagado, { ...base, tooEarly: true })).toBeNull();
    expect(flowRegistrationStatus(pagado, { ...base, amount: null })).toBeNull();
  });

  it("una constancia de «pago exitoso» que Flow tiene sin pagar va a revisión administrativa", () => {
    expect(flowRegistrationStatus({ state: "no_pagado", flowOrder: "1", status: 1 }, base)).toBe("revision_admin");
  });

  it("sin respuesta de Flow, el camino de siempre", () => {
    for (const c of [
      { state: "no_encontrado", flowOrder: "1", message: "x" },
      { state: "sin_flow", flowOrder: "1" },
      { state: "error", flowOrder: "1", message: "x" },
    ] as FlowReceiptCheck[]) {
      expect(flowRegistrationStatus(c, base)).toBeNull();
    }
    expect(flowRegistrationStatus(null, base)).toBeNull();
  });

  it("lo que se le dice a quien registra", () => {
    expect(describeFlowReceipt(pagado)).toBe(
      "Pago verificado con Flow (orden 184932654): S/ 116.00 con TC el 14/10, 14:18. Al registrarlo entra validado por la pasarela.",
    );
    expect(describeFlowReceipt({ state: "no_pagado", flowOrder: "7", status: 1 })).toContain("SIN PAGAR");
    expect(describeFlowReceipt({ state: "no_encontrado", flowOrder: "7", message: "x" })).toContain("no reconoce la orden 7");
  });
});

describe("el lector reconoce la constancia de Flow", () => {
  function reply(payload: unknown) {
    return (async () =>
      ({
        ok: true,
        json: async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] }),
      }) as unknown as Response) as unknown as typeof fetch;
  }

  it("el «Nº de orden» sale como orden de Flow y como nº de operación", async () => {
    const r = await extractYapeVoucher("AAAA", "image/jpeg", {
      apiKey: "k",
      model: "m",
      fetchImpl: reply({
        operation_number: null,
        operation_label: null,
        amount: "116.00",
        date: "14-10-2026",
        time: "14:18",
        flow_order: "184932654",
        recipient_name: null,
      }),
    });
    expect(r.flowOrder).toBe("184932654");
    expect(r.operationNumber).toBe("184932654");
    expect(r.operationLabel).toBe("Nº de orden (Flow)");
    expect(r.amount).toBe(116);
    expect(r.paidAt).toBe("2026-10-14T19:18:00.000Z");
  });

  it("el prompt describe la pantalla de Flow", async () => {
    let sent = "";
    await extractYapeVoucher("AAAA", "image/jpeg", {
      apiKey: "k",
      model: "m",
      fetchImpl: (async (_u: unknown, req: RequestInit) => {
        sent = JSON.stringify(JSON.parse(String(req.body)).messages[0].content);
        return { ok: true, json: async () => ({ content: [] }) } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    expect(sent).toContain("¡Tu pago se ha concretado exitosamente!");
    expect(sent).toContain("flow_order");
  });
});

describe("Flow manda sobre la foto", () => {
  const verdictNoYape = { isVoucher: false, indicators: {}, model: "m", ok: true };
  const leido = {
    operationNumber: "184932654",
    operationLabel: "Nº de orden (Flow)",
    flowOrder: "184932654",
    amount: 116,
    paidAt: "2026-10-14T19:18:00.000Z",
    payerName: null,
    recipientName: null,
    recipientPhoneLastDigits: null,
    ok: true,
    model: "m",
  };

  it("confirmada: es un comprobante, el receptor es nuestra cuenta Flow y el monto es el de Flow", () => {
    const flow = flowReceiptFromStatus("184932654", { ...PAGADA, paymentData: { ...PAGADA.paymentData, amount: 115.5 } });
    const r = voucherReading(verdictNoYape, leido, [], "Gandia Aranibar", flow);
    expect(r.isVoucher).toBe(true);
    expect(r.fields).toMatchObject({
      operationNumber: "184932654",
      amount: 115.5,
      paidAt: "2026-10-14T19:18:00.000Z",
      recipientCheck: "verified",
      recipientName: FLOW_RECIPIENT_NAME,
      flow: { state: "pagado" },
    });
    // La bandeja y el drawer releen la auditoría: no pueden decir «no pudo leerse».
    expect(yapeRecipientReadingFromVision(r.payload, [])).toMatchObject({ status: "verified", name: FLOW_RECIPIENT_NAME });
  });

  it("sin confirmación de Flow la foto sigue siendo solo una foto", () => {
    const r = voucherReading(verdictNoYape, leido, [], null, { state: "no_encontrado", flowOrder: "184932654", message: "x" });
    expect(r.isVoucher).toBe(false);
    expect(r.fields.recipientCheck).not.toBe("verified");
  });
});

describe("el registro", () => {
  const src = readFileSync(resolve(process.cwd(), "app/dashboard/pedidos/payment-actions.ts"), "utf8");

  it("valida por el camino de siempre, sin persona, con la fuente «flow»", () => {
    expect(src).toContain('who: { storeId: ctx.storeId, actor: null, source: "flow" }');
    expect(src).toContain('onlyIfStatus: "pendiente_revision"');
  });

  it("un pago de Flow que ya entró por un link de Kapta no se registra otra vez", () => {
    expect(src).toContain('.from("flowcl_payment_links")');
    expect(src).toContain("ya entró por el link de cobro");
    // Y los pagos por link guardan la orden como nº de operación: el índice
    // único bloquea la misma constancia subida a mano.
    expect(readFileSync(resolve(process.cwd(), "lib/flow/confirm.ts"), "utf8")).toContain(
      "operation_number: status.flowOrder ? String(status.flowOrder) : null",
    );
  });
});

describe("MOM §12", () => {
  it("documenta la constancia de Flow verificada con Flow", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("Una constancia de Flow subida a mano se verifica con Flow (14-10-2026)");
  });
});
