import { describe, expect, it } from "vitest";
import { extractYapeVoucher, parseVoucherInstant } from "@/lib/vision";

/** Respuesta de la Messages API con el JSON que devolvería el modelo. */
function reply(payload: unknown) {
  return async () =>
    ({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] }),
    }) as unknown as Response;
}

const OPTS = { apiKey: "k", model: "m" };

describe("parseVoucherInstant", () => {
  it("combina fecha y hora en un instante, interpretando hora de Perú (UTC-5)", () => {
    expect(parseVoucherInstant("10 jul 2026", "02:35 pm")).toBe("2026-07-10T19:35:00.000Z");
  });

  it("acepta el formato numérico peruano DD/MM/YYYY", () => {
    expect(parseVoucherInstant("10/07/2026", "09:05 am")).toBe("2026-07-10T14:05:00.000Z");
  });

  it("acepta ISO y hora de 24 horas", () => {
    expect(parseVoucherInstant("2026-07-10", "14:35")).toBe("2026-07-10T19:35:00.000Z");
  });

  it("medianoche y mediodía en formato de 12 horas", () => {
    expect(parseVoucherInstant("2026-07-10", "12:00 am")).toBe("2026-07-10T05:00:00.000Z");
    expect(parseVoucherInstant("2026-07-10", "12:00 pm")).toBe("2026-07-10T17:00:00.000Z");
  });

  it("sin hora se queda a medianoche local", () => {
    expect(parseVoucherInstant("2026-07-10", null)).toBe("2026-07-10T05:00:00.000Z");
  });

  it("una fecha que no se entiende es null, no una inventada", () => {
    // La fecha y hora entran en la detección de duplicados: una aproximada es
    // peor que ninguna.
    expect(parseVoucherInstant("ayer", "02:35 pm")).toBeNull();
    expect(parseVoucherInstant(null, "02:35 pm")).toBeNull();
    expect(parseVoucherInstant("2026-07-10", "99:99")).toBeNull();
  });
});

describe("extractYapeVoucher", () => {
  it("transcribe los campos del comprobante", async () => {
    const out = await extractYapeVoucher("AAAA", "image/jpeg", {
      ...OPTS,
      fetchImpl: reply({
        operation_number: "1234 5678",
        amount: "S/ 50.00",
        date: "10 jul 2026",
        time: "02:35 pm",
        payer_name: "Ana Quispe",
        recipient_name: "Grupo GF SAC",
      }),
    });
    expect(out).toMatchObject({
      operationNumber: "12345678",
      amount: 50,
      paidAt: "2026-07-10T19:35:00.000Z",
      payerName: "Ana Quispe",
      recipientName: "Grupo GF SAC",
      ok: true,
    });
  });

  it("una captura recortada deja en null lo que no se ve", async () => {
    // Este es el caso que importa: sin nº de operación el pago no se podrá
    // validar, y el equipo tendrá que completarlo a mano.
    const out = await extractYapeVoucher("AAAA", "image/jpeg", {
      ...OPTS,
      fetchImpl: reply({
        operation_number: null,
        amount: 50,
        date: null,
        time: null,
        payer_name: "Ana Quispe",
        recipient_name: null,
      }),
    });
    expect(out.ok).toBe(true);
    expect(out.operationNumber).toBeNull();
    expect(out.paidAt).toBeNull();
    expect(out.amount).toBe(50);
  });

  it('trata el texto "null" como ausencia', async () => {
    const out = await extractYapeVoucher("AAAA", "image/jpeg", {
      ...OPTS,
      fetchImpl: reply({ operation_number: "null", payer_name: "  " }),
    });
    expect(out.operationNumber).toBeNull();
    expect(out.payerName).toBeNull();
  });

  it("sin clave configurada no llama a la API y avisa con ok:false", async () => {
    let called = false;
    const out = await extractYapeVoucher("AAAA", "image/jpeg", {
      apiKey: "",
      model: "m",
      fetchImpl: async () => {
        called = true;
        return {} as Response;
      },
    });
    expect(called).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.operationNumber).toBeNull();
  });

  it("un error de la API no lanza: devuelve todo vacío con ok:false", async () => {
    const out = await extractYapeVoucher("AAAA", "image/jpeg", {
      ...OPTS,
      fetchImpl: async () => ({ ok: false }) as unknown as Response,
    });
    expect(out.ok).toBe(false);
  });

  it("una respuesta ilegible tampoco lanza", async () => {
    const out = await extractYapeVoucher("AAAA", "image/jpeg", {
      ...OPTS,
      fetchImpl: async () =>
        ({ ok: true, json: async () => ({ content: [{ type: "text", text: "no es json" }] }) }) as unknown as Response,
    });
    expect(out.ok).toBe(false);
  });
});
