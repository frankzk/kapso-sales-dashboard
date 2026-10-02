import { describe, expect, it } from "vitest";
import { extractYapeVoucher } from "@/lib/vision";
import { yapeRecipientReading, yapeRecipientReadingFromVision, type CollectionAccount } from "@/lib/yape-recipient";
import { voucherReading } from "@/lib/voucher-inspect";

// «Te yapearon» es la pantalla de la cuenta que RECIBIÓ el Yape. La captura sale
// de nuestra propia sesión, así que el receptor somos nosotros; el nombre y el
// celular que muestra son de quien pagó. Antes se leían como receptor y el
// cobro se acusaba de desvío (#KP138399, 02-10-2026: S/ 30 de «Guadalupe Del*»,
// celular ***717, operación 15926914).

const OPTS = { apiKey: "k", model: "m" };
function reply(payload: unknown) {
  return async () =>
    ({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] }),
    }) as unknown as Response;
}

const ACCOUNTS: CollectionAccount[] = [{ name: "Grupo GF S.A.C.", phoneLastDigits: "309" }];

describe("lectura de una captura «Te yapearon»", () => {
  it("el nombre y el celular que muestra son del pagador; el receptor queda vacío", async () => {
    const out = await extractYapeVoucher("AAAA", "image/jpeg", {
      ...OPTS,
      fetchImpl: reply({
        operation_number: "15926914",
        operation_label: "Código de operación",
        amount: 30,
        payer_name: "Guadalupe Del*",
        recipient_name: null,
        recipient_phone_last_digits: null,
        received_view: true,
        yape_empresa_marker: true,
      }),
    });
    expect(out).toMatchObject({
      operationNumber: "15926914",
      amount: 30,
      payerName: "Guadalupe Del*",
      recipientName: null,
      recipientPhoneLastDigits: null,
      receivedView: true,
      yapeEmpresaMarker: true,
    });
  });

  it("si el modelo igual puso al pagador como receptor, se mueve al pagador", async () => {
    const out = await extractYapeVoucher("AAAA", "image/jpeg", {
      ...OPTS,
      fetchImpl: reply({
        operation_number: "15926914",
        operation_label: "Código de operación",
        amount: 30,
        payer_name: null,
        recipient_name: "Guadalupe Del*",
        recipient_phone_last_digits: "717",
        received_view: true,
      }),
    });
    expect(out.payerName).toBe("Guadalupe Del*");
    expect(out.recipientName).toBeNull();
    expect(out.recipientPhoneLastDigits).toBeNull();
  });

  it("un comprobante de quien pagó sigue leyéndose como siempre", async () => {
    const out = await extractYapeVoucher("AAAA", "image/jpeg", {
      ...OPTS,
      fetchImpl: reply({ operation_number: "99887766", recipient_name: "Grupo GF SAC", recipient_phone_last_digits: "309" }),
    });
    expect(out.receivedView).toBe(false);
    expect(out.recipientName).toBe("Grupo GF SAC");
  });
});

describe("cuenta receptora de una captura «Te yapearon»", () => {
  it("con el aviso de Yape Empresa cuenta como cobro a nuestra cuenta, sin contrastar al pagador", () => {
    const reading = yapeRecipientReading(
      { recipientName: null, recipientPhoneLastDigits: null, payerName: "Guadalupe Del*", receivedView: true, yapeEmpresaMarker: true },
      ACCOUNTS,
    );
    expect(reading).toMatchObject({ status: "verified", receivedView: true, yapeEmpresa: true, account: null, name: null });
  });

  it("sin el aviso de Yape Empresa queda parcial: puede ser la cuenta personal de cualquiera", () => {
    const reading = yapeRecipientReading(
      { recipientName: null, recipientPhoneLastDigits: null, payerName: "Guadalupe Del*", receivedView: true },
      ACCOUNTS,
    );
    // Ni verificada ni acusada de desvío: alguien la confirma en nuestro Yape.
    expect(reading).toMatchObject({ status: "partial", receivedView: true, yapeEmpresa: false });
  });

  it("antes de la regla, ese mismo pago se acusaba de desvío", () => {
    // Lo que el lector viejo dejaba: el pagador como receptor.
    const reading = yapeRecipientReading(
      { recipientName: "Guadalupe Del*", recipientPhoneLastDigits: "717", payerName: null },
      ACCOUNTS,
    );
    expect(reading.status).toBe("mismatch");
    expect(reading.receivedView).toBe(false);
  });

  it("la auditoría guarda received_view y la relectura de cada pantalla lo respeta", () => {
    const inspection = voucherReading(
      { ok: true, isVoucher: true, indicators: {}, model: "m" } as never,
      {
        operationNumber: "15926914", operationLabel: "Código de operación", amount: 30, paidAt: null,
        payerName: "Guadalupe Del*", recipientName: null, recipientPhoneLastDigits: null,
        receivedView: true, yapeEmpresaMarker: true, ok: true, model: "m",
      },
      ACCOUNTS,
    );
    expect(inspection.fields.recipientCheck).toBe("verified");
    expect(inspection.fields.recipientReceivedView).toBe(true);
    const extracted = (inspection.payload as { extracted: Record<string, unknown> }).extracted;
    expect(extracted.received_view).toBe(true);
    expect(extracted.yape_empresa_marker).toBe(true);
    expect(yapeRecipientReadingFromVision(inspection.payload, ACCOUNTS).status).toBe("verified");
  });
});
