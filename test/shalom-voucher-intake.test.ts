import { describe, expect, it } from "vitest";
import { matchCandidate, type VoucherCandidate } from "@/lib/shalom/voucher-intake";

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
