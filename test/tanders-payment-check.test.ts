import { describe, expect, it } from "vitest";
import {
  checkTandersPayment,
  isExpectedRecipient,
  normalizeOperationNumber,
  normalizeRecipient,
} from "@/lib/tanders/payment-check";

/** Comprobante bueno: Yape a Grupo GF SAC por lo que dice la guía. */
function voucher(over: Partial<Parameters<typeof checkTandersPayment>[0]["voucher"]> = {}) {
  return {
    ok: true,
    isVoucher: true,
    method: "yape" as const,
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

describe("el BBVA pega el final del celular al nombre", () => {
  // #KP137040 y otros dos cobros del courier, lectura TEXTUAL de producción: la
  // app del BBVA, al pagar a un Yape desde «Envío a contactos», escribe el
  // contacto como «Grupo gf s •5309». Salían «El pago NO va a Grupo GF SAC».
  it("#KP137040: «Grupo gf s •5309» es Grupo GF SAC con el celular ···309", () => {
    expect(isExpectedRecipient("Grupo gf s •5309")).toBe(true);
    expect(checkTandersPayment({
      voucher: voucher({ recipientName: "Grupo gf s •5309", amount: 99 }),
      expectedAmount: 99,
    })).toMatchObject({ state: "validado", reasons: [] });
  });

  it("también la forma de Plin, con el número entero", () => {
    expect(isExpectedRecipient("Grupo Gf S · 930 555 309 - Yape")).toBe(true);
  });

  it("y la de Plin sin número, con la billetera pegada al nombre", () => {
    // #KP136682 (comprobante de pedido): «Grupo Gf S - Yape». La misma forma
    // puede llegar como cobro del courier.
    expect(isExpectedRecipient("Grupo Gf S - Yape")).toBe(true);
    expect(isExpectedRecipient("Juan Pérez - Yape")).toBe(false);
  });

  it("los dígitos son el celular: si no terminan en 309, es otra cuenta", () => {
    // Separarlos no es tirarlos. El nombre encaja, pero el celular manda.
    expect(isExpectedRecipient("Grupo gf s •5123")).toBe(false);
    expect(checkTandersPayment({
      voucher: voucher({ recipientName: "Grupo gf s •5123", amount: 99 }),
      expectedAmount: 99,
    })).toMatchObject({ state: "rechazado", reasons: ["destinatario_distinto"] });
  });

  it("un nombre ajeno con nuestro celular sigue siendo otra cuenta", () => {
    expect(isExpectedRecipient("Juan Pérez •5309")).toBe(false);
  });

  it("la cuenta enmascarada del BCP no es el celular: no desmiente nada", () => {
    // #AUR177129: la app del BCP pone «**** 0012» bajo «Grupo Gf S.». Es la
    // cuenta, no el ···309; tomarla por celular rechazaría un cobro bueno.
    expect(isExpectedRecipient("Grupo Gf S. **** 0012")).toBe(true);
    // Pero el nombre sigue exigiéndose igual.
    expect(isExpectedRecipient("Juan Pérez **** 0012")).toBe(false);
  });
});

describe("cualquier app que pague a un Yape", () => {
  // #KP136441, lectura TEXTUAL de producción salvo el destino: Prex con
  // «Titular: Grupo Gf S A C» y «Cuenta/billetera: Yape». Salía «El medio de
  // pago no es Yape, Plin ni transferencia BCP»; había 43 así, 30 validados a mano.
  const prex = voucher({
    method: "otro",
    toYape: true,
    recipientName: "Grupo Gf S A C",
    amount: 298,
    operationNumber: "092514213996",
  });

  it("#KP136441: un Prex a nuestro Yape es un cobro válido", () => {
    expect(checkTandersPayment({ voucher: prex, expectedAmount: 298 })).toEqual({
      state: "validado",
      reasons: [],
      summary: "Pago a su Yape desde otra app a Grupo GF SAC por S/ 298.00.",
    });
  });

  it("una app desconocida que no dice adónde fue el dinero sigue sin aceptarse", () => {
    const r = checkTandersPayment({ voucher: { ...prex, toYape: false }, expectedAmount: 298 });
    expect(r.reasons).toEqual(["medio_no_aceptado"]);
  });

  it("ir a un Yape no perdona el destinatario ni el monto", () => {
    expect(
      checkTandersPayment({ voucher: { ...prex, recipientName: "Juan Pérez" }, expectedAmount: 298 })
        .reasons,
    ).toEqual(["destinatario_distinto"]);
    expect(checkTandersPayment({ voucher: prex, expectedAmount: 150 }).reasons).toEqual([
      "monto_distinto",
    ]);
  });
});

describe("la app del BCP", () => {
  it("#AUR177129: su constancia leída como BCP es un cobro válido", () => {
    // Lectura TEXTUAL de producción, salvo el medio: el lector devolvió «otro».
    expect(checkTandersPayment({
      voucher: voucher({ method: "bcp", recipientName: "Grupo Gf S.", amount: 80.1 }),
      expectedAmount: 80.1,
    })).toMatchObject({ state: "validado", reasons: [] });
  });
});

describe("normalizeOperationNumber", () => {
  it("hace colisionar dos transcripciones del mismo pago", () => {
    // Si no colisionan, el reuso del comprobante no se detecta: es toda la
    // razón de ser de la normalización.
    expect(normalizeOperationNumber("86 480 816")).toBe(normalizeOperationNumber("864-808-16"));
    expect(normalizeOperationNumber("864-808-16")).toBe("86480816");
  });

  it("quita separadores pero NO etiquetas: por eso el prompt pide el código a secas", () => {
    // Límite conocido y deliberado. Recortar letras del principio rompería un
    // código BCP alfanumérico legítimo, así que se ataja en el origen
    // (payment-vision.ts) en vez de adivinar acá.
    expect(normalizeOperationNumber("N° 86480816")).toBe("N86480816");
  });

  it("conserva los ceros a la izquierda", () => {
    // Yape los emite así ("06420756"). Tratarlo como número los perdería y
    // haría chocar operaciones distintas.
    expect(normalizeOperationNumber("06420756")).toBe("06420756");
  });

  it("una lectura truncada no es una clave: devuelve null", () => {
    // Casos reales del histórico (10-09-2026): el modelo elidió el medio del
    // número en vez de devolver null. Quitarle los puntos daría un número que
    // no existe, y compararlo podría acusar en falso o tapar el duplicado
    // bueno. Sin dato es mejor que con dato inventado.
    expect(normalizeOperationNumber("202609...495099")).toBeNull();
    expect(normalizeOperationNumber("2026…675")).toBeNull();
    // Un punto suelto entre dígitos SÍ es separador, no elisión.
    expect(normalizeOperationNumber("784.444.034.2156")).toBe("7844440342156");
  });

  it("acepta los alfanuméricos de banco y no inventa vacíos", () => {
    expect(normalizeOperationNumber(" bcp-2026a ")).toBe("BCP2026A");
    expect(normalizeOperationNumber("---")).toBeNull();
    expect(normalizeOperationNumber(null)).toBeNull();
  });
});

describe("checkTandersPayment", () => {
  it("valida el caso bueno", () => {
    const v = checkTandersPayment({ voucher: voucher(), expectedAmount: 89 });
    expect(v.state).toBe("validado");
    expect(v.reasons).toEqual([]);
  });

  it("acepta también una transferencia BCP a Grupo GF SAC", () => {
    const v = checkTandersPayment({
      voucher: voucher({ method: "bcp" }),
      expectedAmount: 89,
    });
    expect(v.state).toBe("validado");
    expect(v.summary).toContain("Transferencia BCP");
  });

  it("acepta un Plin: cae en la misma cuenta que el Yape", () => {
    // #KP131846 (10-09-2026): Plin de S/ 298 a «Grupo Gf S · 930 555 309 -
    // Yape». Es el mismo dinero en la misma cuenta; el motorizado remite con la
    // billetera que tenga. Rechazarlo por el logo rechazaba un cobro bueno —7
    // de los 9 rechazos de ese día eran esto.
    const v = checkTandersPayment({
      voucher: voucher({ method: "plin", amount: 298 }),
      expectedAmount: 298,
    });
    expect(v.state).toBe("validado");
    expect(v.summary).toContain("Plin");
  });

  it("un comprobante ya usado en otra guía NO cobra, aunque todo lo demás cuadre", () => {
    // El mismo dinero no acredita dos pedidos. Este motivo bloquea un
    // comprobante por lo demás perfecto: buen medio, buena cuenta, buen monto.
    const v = checkTandersPayment({
      voucher: voucher({ operationNumber: "86480816" }),
      expectedAmount: 89,
      duplicateOf: ["#KP131846"],
    });
    expect(v.state).toBe("rechazado");
    expect(v.reasons).toEqual(["operacion_duplicada"]);
    // El nº y la otra guía van en el veredicto: sin eso es una acusación sin
    // respaldo y quien revisa no sabe por dónde empezar.
    expect(v.summary).toContain("86480816");
    expect(v.summary).toContain("#KP131846");
  });

  it("sin duplicados no inventa el motivo", () => {
    for (const dup of [undefined, null, []]) {
      const v = checkTandersPayment({
        voucher: voucher(),
        expectedAmount: 89,
        duplicateOf: dup,
      });
      expect(v.state).toBe("validado");
    }
  });

  it("rechaza un medio que no es Yape, Plin ni BCP", () => {
    const v = checkTandersPayment({ voucher: voucher({ method: "otro" }), expectedAmount: 89 });
    expect(v.state).toBe("rechazado");
    expect(v.reasons).toContain("medio_no_aceptado");
  });

  it("un Plin a otra cuenta se rechaza igual que un Yape a otra cuenta", () => {
    // Aceptar el medio no es aceptar el pago: lo que decide sigue siendo a
    // quién fue el dinero.
    const v = checkTandersPayment({
      voucher: voucher({ method: "plin", recipientName: "Juan Pérez" }),
      expectedAmount: 89,
    });
    expect(v.state).toBe("rechazado");
    expect(v.reasons).toContain("destinatario_distinto");
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
