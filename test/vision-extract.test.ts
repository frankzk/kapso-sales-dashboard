import { describe, expect, it } from "vitest";
import {
  OPERATION_NUMBER_LABELS,
  checkYapeRecipient,
  extractYapeVoucher,
  parseVoucherInstant,
} from "@/lib/vision";

/** Respuesta de la Messages API con el JSON que devolvería el modelo. */
function reply(payload: unknown) {
  return async () =>
    ({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] }),
    }) as unknown as Response;
}

/** Captura el prompt que se le manda al modelo. */
async function capturePrompt(): Promise<string> {
  let sent = "";
  await extractYapeVoucher("AAAA", "image/jpeg", {
    ...OPTS,
    fetchImpl: (async (_url: unknown, req: RequestInit) => {
      const body = JSON.parse(String(req.body));
      sent = body.messages[0].content
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("\n");
      return { ok: true, json: async () => ({ content: [] }) } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  return sent;
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
        recipient_phone_last_digits: "*** *** 309",
      }),
    });
    expect(out).toMatchObject({
      operationNumber: "12345678",
      amount: 50,
      paidAt: "2026-07-10T19:35:00.000Z",
      payerName: "Ana Quispe",
      recipientName: "Grupo GF SAC",
      recipientPhoneLastDigits: "309",
      ok: true,
    });
  });

  it("un monto ilegible queda en null, no en S/ 0.00", async () => {
    // Un cero inventado se registraría como un pago de cero soles con toda
    // confianza; null obliga a que lo escriba una persona.
    const out = await extractYapeVoucher("AAAA", "image/jpeg", {
      ...OPTS,
      fetchImpl: reply({ operation_number: "999999", amount: "ilegible" }),
    });
    expect(out.amount).toBeNull();
    expect(out.operationNumber).toBe("999999");
  });

  it("descarta el monto o el código de seguridad si el modelo los confunde con la operación", async () => {
    for (const mistakenValue of ["30", "551", "030"]) {
      const out = await extractYapeVoucher("AAAA", "image/jpeg", {
        ...OPTS,
        fetchImpl: reply({
          operation_number: mistakenValue,
          security_code: "551",
          amount: 30,
        }),
      });
      expect(out.operationNumber).toBeNull();
      expect(out.amount).toBe(30);
    }
  });

  it("el guardarraíl de los 3 dígitos sigue en pie aunque el rótulo sea de otro banco", async () => {
    // Enumerar rótulos NO puede reabrir el bug que ancló el rótulo original: el
    // "Código de seguridad" de Interbank tampoco es un nº de operación.
    const out = await extractYapeVoucher("AAAA", "image/jpeg", {
      ...OPTS,
      fetchImpl: reply({
        operation_number: "551",
        operation_label: "Código de operación",
        security_code: "551",
      }),
    });
    expect(out.operationNumber).toBeNull();
    // Sin número aceptado, el rótulo no se guarda: sería ruido en la
    // distribución por banco y no respalda ningún dato.
    expect(out.operationLabel).toBeNull();
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

  it("acepta el nº de operación bajo el rótulo de cualquiera de los bancos", async () => {
    // El motivo de este test: el prompt exigía literalmente "Nro. de operación"
    // —el rótulo de Yape— y el modelo, obedeciendo, devolvía null ante un
    // comprobante de Interbank que rotula "Código de operación". Eran 19 de los
    // 21 comprobantes observados sin nº: el número estaba en la imagen.
    for (const label of OPERATION_NUMBER_LABELS) {
      const out = await extractYapeVoucher("AAAA", "image/jpeg", {
        ...OPTS,
        fetchImpl: reply({ operation_number: "62251837", operation_label: label }),
      });
      expect(out.operationNumber, `rótulo: ${label}`).toBe("62251837");
      expect(out.operationLabel, `rótulo: ${label}`).toBe(label);
    }
  });

  it("guarda el rótulo desconocido en vez de perderlo, para que el banco nuevo se vea", async () => {
    // Un rótulo que no está en la lista no invalida un número que sí se leyó; y
    // queda registrado, así el siguiente banco aparece en los datos en lugar de
    // desaparecer en un null silencioso.
    const out = await extractYapeVoucher("AAAA", "image/jpeg", {
      ...OPTS,
      fetchImpl: reply({ operation_number: "998877665", operation_label: "N° de transacción" }),
    });
    expect(out.operationNumber).toBe("998877665");
    expect(out.operationLabel).toBe("N° de transacción");
  });

  it("el prompt enumera los rótulos desde la única definición que hay", async () => {
    // Si alguien añade un banco a OPERATION_NUMBER_LABELS, el prompt tiene que
    // enterarse solo. Una segunda lista escrita a mano dentro del prompt es la
    // forma en que estas dos cosas se separan.
    const prompt = await capturePrompt();
    for (const label of OPERATION_NUMBER_LABELS) expect(prompt).toContain(label);
    expect(prompt).toContain("operation_label");
    expect(prompt).toContain("Código de seguridad");
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

describe("checkYapeRecipient", () => {
  // La cuenta de la empresa. La lista completa y su corpus real viven en
  // test/yape-recipient.test.ts; acá solo se comprueba que el envoltorio de
  // lib/vision la reexporta y le pasa las cuentas.
  const CUENTAS = [{ name: "Grupo GF S.A.C.", phoneLastDigits: "309" }];
  it("verifica Grupo GF S.A.C. y el celular terminado en 309", () => {
    expect(checkYapeRecipient("Grupo Gf S.a.c.", "309", CUENTAS)).toBe("verified");
  });

  it("distingue una lectura parcial de un receptor incorrecto", () => {
    expect(checkYapeRecipient("Grupo GF SAC", null, CUENTAS)).toBe("partial");
    expect(checkYapeRecipient(null, "309", CUENTAS)).toBe("partial");
    expect(checkYapeRecipient("Otro comercio", "309", CUENTAS)).toBe("mismatch");
    expect(checkYapeRecipient("Grupo GF SAC", "123", CUENTAS)).toBe("mismatch");
    expect(checkYapeRecipient(null, null, CUENTAS)).toBe("missing");
  });
});
