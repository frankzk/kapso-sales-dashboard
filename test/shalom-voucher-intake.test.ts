import { describe, expect, it } from "vitest";
import { matchCandidate, type VoucherCandidate } from "@/lib/shalom/voucher-intake";
import { voucherReading } from "@/lib/voucher-inspect";
import { yapeRecipientReadingFromVision, type CollectionAccount } from "@/lib/yape-recipient";

/** El pedido de Jaime, el caso real que destapó todo esto. */
const JAIME: VoucherCandidate = {
  orderId: "ord-1",
  orderName: "#KP134340",
  saldo: 237,
  total: 267,
  guideCode: "96212898",
  shalomCodigo: "JPJM",
};

const OTRO: VoucherCandidate = {
  orderId: "ord-2",
  orderName: "#KP134678",
  saldo: 109,
  total: 139,
  guideCode: "96103396",
  shalomCodigo: "P9KW",
};

describe("puerta 1: el monto", () => {
  it("coincide con el saldo pendiente y pasa", () => {
    const r = matchCandidate([JAIME], 237, null);
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.candidate.orderId, r.gate]).toEqual(["ord-1", "monto"]);
  });

  it("coincide con el TOTAL y pasa: pagó todo de golpe", () => {
    // Hay quien ignora el adelanto y manda el total del pedido.
    const r = matchCandidate([JAIME], 267, null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.gate).toBe("monto");
  });

  it("céntimos: 59.1 y 59.10 son el mismo saldo", () => {
    const c = { ...JAIME, saldo: 59.1, total: 89.1 };
    expect(matchCandidate([c], 59.1, null).ok).toBe(true);
  });

  it("un pago PARCIAL no pasa, y el motivo dice cuánto debía", () => {
    // Es el caso más frecuente de los que caen a mano, y fue una decisión
    // consciente: entre registrar de menos y no registrar, cae a una persona.
    const r = matchCandidate([JAIME], 200, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("#KP134340 debe 237.00");
  });

  it("dos pedidos con el mismo importe NO se adivinan", () => {
    // Registrar la plata en el pedido equivocado le da la clave a quien no
    // pagó y se la niega a quien sí. Mejor que lo mire alguien.
    const gemelo = { ...OTRO, saldo: 237 };
    const r = matchCandidate([JAIME, gemelo], 237, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("más de un pedido");
  });

  it("sin monto leído no se intenta nada", () => {
    const r = matchCandidate([JAIME], null, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no pudo leer el monto");
  });

  it("sin candidatos, no hay a qué colgarlo", () => {
    expect(matchCandidate([], 237, "96212898").ok).toBe(false);
  });
});

describe("puerta 2: la guía escrita", () => {
  it("escribió la guía y pasa aunque el monto no cuadre", () => {
    // Nombrar la guía es decir de qué pedido habla: pesa más que la aritmética.
    const r = matchCandidate([JAIME, OTRO], 200, "ya pagué, guía 96212898");
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.candidate.orderId, r.gate]).toEqual(["ord-1", "guia"]);
  });

  it("la guía manda sobre el monto cuando se contradicen", () => {
    // 109 es el saldo del OTRO pedido, pero escribió la guía del de Jaime.
    const r = matchCandidate([JAIME, OTRO], 109, "guia 96212898");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidate.orderId).toBe("ord-1");
  });

  it("el código de Shalom solo vale si es TODO lo que escribió", () => {
    // Son cuatro caracteres: buscarlos sueltos dentro de una frase daría
    // falsos positivos en cualquier palabra.
    expect(matchCandidate([JAIME], 200, "JPJM").ok).toBe(true);
    expect(matchCandidate([JAIME], 200, "mi codigo es JPJM y ya pagué").ok).toBe(false);
  });

  it("si el texto nombra dos guías, tampoco se adivina", () => {
    const r = matchCandidate([JAIME, OTRO], 999, "96212898 y 96103396");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("más de una guía");
  });

  it("texto sin guía cae a la puerta del monto, no rompe nada", () => {
    expect(matchCandidate([JAIME], 237, "ya le hice el yape señorita").ok).toBe(true);
  });
});

describe("la auditoría que se guarda con el comprobante", () => {
  // #KP134730 lo destapó: la ingesta escribía su propio objeto plano
  // —`{recipient_name: "Grupo Gf S.a.c.", ...}`— en vez del jsonb que el drawer
  // relee. El nombre del receptor estaba guardado y era el correcto, pero bajo
  // otra llave, así que la pantalla decía «La cuenta receptora no pudo leerse»
  // en TODOS los comprobantes que entran por WhatsApp. No es cosmético: ese
  // renglón es el único control que dice si el dinero llegó a una cuenta
  // nuestra, y estaba apagado justo donde nadie mira la imagen al recibirla.
  const CUENTAS: CollectionAccount[] = [{ name: "Grupo GF S.A.C.", phoneLastDigits: "309" }];

  const verdict = { isVoucher: true, indicators: {}, model: "claude-sonnet-5", ok: true };
  const leido = {
    operationNumber: "35514682",
    operationLabel: "Nro. de operación",
    amount: 119,
    paidAt: "2026-09-19T15:07:00.000Z",
    payerName: "Justina Rosa Carbajal",
    recipientName: "Grupo Gf S.a.c.",
    recipientPhoneLastDigits: "309",
    ok: true,
    model: "claude-sonnet-5",
  };

  it("el que escribe y el que lee hablan del mismo jsonb", () => {
    const { payload } = voucherReading(verdict, leido, CUENTAS);
    // La prueba que faltaba: no que el payload tenga tal forma, sino que el
    // LECTOR del drawer saque de él la cuenta correcta.
    expect(yapeRecipientReadingFromVision(payload, CUENTAS)).toMatchObject({
      name: "Grupo Gf S.a.c.",
      phoneLastDigits: "309",
      status: "verified",
    });
  });

  it("la procedencia del mensaje no pisa la lectura de la imagen", () => {
    // La ingesta añade de dónde vino y por qué puerta pasó. Eso va FUERA de
    // `extracted`, que es lo que el lector dijo de la imagen y nada más.
    const { payload } = voucherReading(verdict, leido, CUENTAS);
    const vision: Record<string, unknown> = {
      ...payload,
      source: "wa_cobranza_shalom",
      gate: "monto",
      phone: "51997684682",
    };
    expect(yapeRecipientReadingFromVision(vision, CUENTAS).status).toBe("verified");
    expect((vision.extracted as Record<string, unknown>).recipient_name).toBe("Grupo Gf S.a.c.");
  });

  it("una lectura invertida se sigue corrigiendo al releerla", () => {
    // El lector a veces cambia de sitio pagador y receptor. Se guarda lo que
    // dijo, sin corregir, y la corrección se recalcula al mirarlo.
    const { payload } = voucherReading(
      verdict,
      { ...leido, payerName: "Grupo Gf S.a.c.", recipientName: "Justina Rosa Carbajal" },
      CUENTAS,
    );
    const r = yapeRecipientReadingFromVision(payload, CUENTAS);
    expect(r.swapped).toBe(true);
    expect(r.status).toBe("verified");
  });
});
