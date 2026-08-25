import { describe, expect, it } from "vitest";
import {
  describeDuplicate,
  findDuplicate,
  findOperationClash,
  normalizeManualOperationNumber,
  normalizeOperationNumber,
  type CandidatePayment,
  type ExistingPayment,
} from "@/lib/yape-dedup";

function existing(over: Partial<ExistingPayment> = {}): ExistingPayment {
  return {
    id: "pay-1",
    order_id: "order-1",
    order_name: "#KP114985",
    kind: "adelanto",
    amount: 50,
    operation_number: "12345678",
    paid_at: "2026-07-10T14:30:00.000Z",
    payer_name: "Ana Quispe",
    payer_phone: "51987654321",
    file_sha256: "abc123",
    validation_status: "validado",
    ...over,
  };
}

function candidate(over: Partial<CandidatePayment> = {}): CandidatePayment {
  return {
    order_id: "order-2",
    kind: "diferencia",
    amount: 50,
    operation_number: "12345678",
    paid_at: "2026-07-10T14:30:00.000Z",
    payer_name: "Ana Quispe",
    payer_phone: "51987654321",
    file_sha256: "abc123",
    ...over,
  };
}

describe("findDuplicate — identificadores fuertes", () => {
  it("el mismo nº de operación es duplicado por sí solo", () => {
    const v = findDuplicate(
      candidate({ file_sha256: "otro", amount: 99, paid_at: "2026-01-01T00:00:00.000Z", payer_name: "Otro" }),
      [existing()],
    );
    expect(v.duplicate).toBe(true);
    expect(v.signals).toContain("operation_number");
  });

  it("el nº de operación se compara normalizado", () => {
    const v = findDuplicate(candidate({ operation_number: "1234-5678 " }), [existing()]);
    expect(v.duplicate).toBe(true);
    expect(normalizeOperationNumber(" 1234-5678 ")).toBe("12345678");
  });

  it("no trata el monto ni el código de seguridad como nº de operación", () => {
    expect(normalizeOperationNumber("30")).toBeNull();
    expect(normalizeOperationNumber("551")).toBeNull();
    expect(normalizeOperationNumber("030")).toBeNull();
  });

  it("acepta una operación bancaria corta solo cuando se transcribe manualmente", () => {
    expect(normalizeOperationNumber("5782")).toBeNull();
    // Pero CON un rótulo de operación reconocido detrás sí vale: los vouchers
    // de papel de BCP (`NO.OPE.: 5782`) y BBVA (`OPER.: 4437`) traen cuatro
    // dígitos, y el rótulo es la evidencia que la longitud sustituía. Es además
    // la misma vara que `normalizeManualOperationNumber` aplica desde siempre a
    // lo que escribe una persona.
    expect(normalizeOperationNumber("5782", { labelled: true })).toBe("5782");
    expect(normalizeOperationNumber("4437", { labelled: true })).toBe("4437");
    // Tres dígitos no pasan ni con rótulo: ahí sigue viviendo el código de
    // seguridad de Yape.
    expect(normalizeOperationNumber("565", { labelled: true })).toBeNull();
    expect(normalizeManualOperationNumber(" 57-82 ")).toBe("5782");
    expect(normalizeManualOperationNumber("030")).toBeNull();
  });

  it("dos Yapes de S/30 con operaciones distintas no son duplicados", () => {
    const v = findDuplicate(
      candidate({
        amount: 30,
        operation_number: "08615551",
        paid_at: "2026-07-28T15:30:00.000Z",
        payer_name: null,
        payer_phone: null,
        file_sha256: "captura-kp124914",
      }),
      [
        existing({
          amount: 30,
          operation_number: "05510030",
          paid_at: "2026-07-28T13:41:00.000Z",
          payer_name: null,
          payer_phone: null,
          file_sha256: "captura-kp124905",
        }),
      ],
    );
    expect(v.duplicate).toBe(false);
  });

  it("ignora una operación OCR corta que ya quedó guardada por error", () => {
    const v = findDuplicate(
      candidate({
        amount: 30,
        operation_number: "30",
        paid_at: "2026-07-28T15:30:00.000Z",
        payer_name: null,
        payer_phone: null,
        file_sha256: "captura-kp124914",
      }),
      [
        existing({
          amount: 30,
          operation_number: "30",
          paid_at: "2026-07-28T13:41:00.000Z",
          payer_name: null,
          payer_phone: null,
          file_sha256: "captura-kp124905",
        }),
      ],
    );
    expect(v.duplicate).toBe(false);
  });

  it("la misma imagen renombrada se detecta por la huella", () => {
    const v = findDuplicate(
      candidate({ operation_number: null, amount: 99, paid_at: null, payer_name: null, payer_phone: null }),
      [existing()],
    );
    expect(v.duplicate).toBe(true);
    expect(v.signals).toEqual(["file_sha256"]);
  });

  it("una captura recortada del mismo comprobante choca por el nº de operación", () => {
    // El recorte cambia los píxeles (otra huella) pero conserva el número, que
    // lib/vision.ts lee de la imagen.
    const v = findDuplicate(candidate({ file_sha256: "recorte-distinto" }), [existing()]);
    expect(v.duplicate).toBe(true);
    expect(v.signals).toContain("operation_number");
  });
});

describe("findDuplicate — coincidencia difusa", () => {
  it("mismo monto, instante y pagador es duplicado aunque no haya nº ni huella", () => {
    const v = findDuplicate(
      candidate({ operation_number: null, file_sha256: null }),
      [existing({ operation_number: null, file_sha256: null })],
    );
    expect(v.duplicate).toBe(true);
    expect(v.signals).toEqual(["amount", "paid_at", "payer"]);
  });

  it("tolera unos minutos de diferencia entre relojes", () => {
    const v = findDuplicate(
      candidate({ operation_number: null, file_sha256: null, paid_at: "2026-07-10T14:32:00.000Z" }),
      [existing({ operation_number: null, file_sha256: null })],
    );
    expect(v.duplicate).toBe(true);
  });

  it("pasada la ventana ya no coincide", () => {
    const v = findDuplicate(
      candidate({ operation_number: null, file_sha256: null, paid_at: "2026-07-10T15:30:00.000Z" }),
      [existing({ operation_number: null, file_sha256: null })],
    );
    expect(v.duplicate).toBe(false);
  });

  it("solo el monto NO basta: bloquearía pagos legítimos del mismo precio", () => {
    const v = findDuplicate(
      candidate({
        operation_number: null,
        file_sha256: null,
        paid_at: "2026-07-11T09:00:00.000Z",
        payer_name: "Beto Ramos",
        payer_phone: "51900000000",
      }),
      [existing({ operation_number: null, file_sha256: null })],
    );
    expect(v.duplicate).toBe(false);
  });

  it("el pagador coincide por teléfono aunque el nombre venga distinto", () => {
    const v = findDuplicate(
      candidate({ operation_number: null, file_sha256: null, payer_name: "A. QUISPE" }),
      [existing({ operation_number: null, file_sha256: null })],
    );
    expect(v.duplicate).toBe(true);
  });

  it("el nombre se compara sin acentos ni mayúsculas", () => {
    const v = findDuplicate(
      candidate({ operation_number: null, file_sha256: null, payer_phone: null, payer_name: "ANÁ QUÍSPE" }),
      [existing({ operation_number: null, file_sha256: null, payer_phone: null, payer_name: "aná quispe" })],
    );
    expect(v.duplicate).toBe(true);
  });
});

describe("findDuplicate — casos que NO son duplicado", () => {
  it("sin pagos previos no hay choque", () => {
    expect(findDuplicate(candidate(), []).duplicate).toBe(false);
  });

  it("un comprobante rechazado libera su nº de operación", () => {
    const v = findDuplicate(candidate(), [existing({ validation_status: "rechazado" })]);
    expect(v.duplicate).toBe(false);
  });

  it("dos comprobantes distintos del mismo pedido conviven", () => {
    const v = findDuplicate(
      candidate({ order_id: "order-1", operation_number: "99999999", file_sha256: "zzz", paid_at: "2026-07-11T10:00:00.000Z" }),
      [existing()],
    );
    expect(v.duplicate).toBe(false);
  });
});

describe("findDuplicate — qué se le dice al operador", () => {
  it("señala a qué pedido está asociado el pago y qué coincide", () => {
    const v = findDuplicate(candidate(), [existing()]);
    expect(v.sameOrder).toBe(false);
    expect(v.conflict?.id).toBe("pay-1");
    const msg = describeDuplicate(v);
    expect(msg).toContain("#KP114985");
    expect(msg).toContain("adelanto");
    expect(msg).toContain("el nº de operación");
  });

  it("distingue una re-carga en el mismo pedido de un choque con otro", () => {
    const v = findDuplicate(candidate({ order_id: "order-1" }), [existing()]);
    expect(v.sameOrder).toBe(true);
    expect(describeDuplicate(v)).toContain("este mismo pedido");
  });

  it("gana el choque con más señales cuando hay varios candidatos", () => {
    const weak = existing({ id: "pay-weak", operation_number: null, file_sha256: "abc123", amount: null, paid_at: null, payer_name: null, payer_phone: null });
    const strong = existing({ id: "pay-strong" });
    expect(findDuplicate(candidate(), [weak, strong]).conflict?.id).toBe("pay-strong");
  });

  it("sin duplicado no hay mensaje", () => {
    expect(describeDuplicate({ duplicate: false, signals: [], conflict: null, sameOrder: false })).toBe("");
  });
});

describe("findOperationClash", () => {
  /** Supabase mínimo: captura el filtro y devuelve las filas que se le den. */
  function admin(rows: unknown[], cap: { op?: string; exclude?: string } = {}) {
    return {
      from: () => ({
        select: () => ({
          eq: (_c: string, op: string) => {
            cap.op = op;
            return {
              neq: async (_c2: string, id: string) => {
                cap.exclude = id;
                return { data: rows };
              },
            };
          },
        }),
      }),
    } as never;
  }

  const live = { id: "pay-2", order_id: "order-9", kind: "adelanto", validation_status: "validado" };
  const rejected = { ...live, id: "pay-3", validation_status: "rechazado" };

  it("un número libre no choca con nada", async () => {
    expect(await findOperationClash(admin([]), "12345678", "pay-1")).toBeNull();
  });

  it("encuentra el pago vivo que ya usa ese número", async () => {
    const cap: { op?: string; exclude?: string } = {};
    const clash = await findOperationClash(admin([live], cap), "12345678", "pay-1");
    expect(clash?.id).toBe("pay-2");
    expect(cap.op).toBe("12345678");
    // Nunca choca consigo mismo: completar dos veces el mismo pago no es un
    // duplicado.
    expect(cap.exclude).toBe("pay-1");
  });

  it("un pago rechazado libera su número", async () => {
    // Misma regla que el índice único parcial `order_payments_operation_uniq`.
    // Si esto discrepara del índice, el reproceso creería tener sitio y la
    // escritura moriría con un 23505 sin explicación.
    expect(await findOperationClash(admin([rejected]), "12345678", "pay-1")).toBeNull();
  });

  it("entre varios, se queda con uno vivo y descarta los rechazados", async () => {
    const clash = await findOperationClash(admin([rejected, live]), "12345678", "pay-1");
    expect(clash?.id).toBe("pay-2");
  });
});
