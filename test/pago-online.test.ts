// «Pago solo online (lista automática)» (MOM §41.11, docs/kapta/pago-solo-online.md):
// la regla, pura. Lo que se fija:
//   - el cliente son los últimos 9 dígitos del celular, venga con 51, +51 o espacios;
//   - entra con 1+ entrega fallida (devuelto, o anulado DESPUÉS de salir) y 0
//     recibidas, solo contra entrega (lima, provincia_cod), las tiendas juntas;
//   - los correos van solo si son de UN celular de la lista;
//   - el freno de cambio brusco: más del doble o menos de la mitad, no;
//   - los reintentos: 1, 5 y 15 minutos con 5xx/tiempo/red/429, nunca con
//     401/403, 404 se registra, 413 avisa;
//   - la alerta de dos días seguidos, sin celulares;
//   - lo que se cobra: adelanto (por defecto, owner 09-11-2026) o pago completo.

import { describe, expect, it } from "vitest";
import {
  PAGO_ONLINE_DEFAULT_REQUIREMENT,
  PAGO_ONLINE_HEADLINE,
  PAGO_ONLINE_MAX_ATTEMPTS,
  PAGO_ONLINE_REQUIREMENT_LABEL,
  PAGO_ONLINE_RETRY_DELAYS_MIN,
  classifyCodCoreAttempt,
  isFailedDay,
  isFailedDelivery,
  limaDateOf,
  nextRetryAt,
  pagoOnlineAlertText,
  pagoOnlineBlockMessage,
  pagoOnlineBrakeDecision,
  pagoOnlineEmailKey,
  pagoOnlineEmailsOf,
  pagoOnlineGuard,
  pagoOnlineListOf,
  pagoOnlineMaskedPhone,
  pagoOnlinePayload,
  pagoOnlinePhoneKey,
  pagoOnlineRegla,
  pagoOnlineRequirementMet,
  parseCodCoreTotals,
  sendStatusOf,
  shouldAlertTwoDays,
  type PagoOnlineOrderFact,
} from "@/lib/pago-online";

const o = (customer_phone: string | null, coverage: string | null, general_status: string, dispatched_at: string | null = null): PagoOnlineOrderFact => ({
  customer_phone,
  coverage,
  general_status,
  dispatched_at,
});
const OUT = "2026-10-01T15:00:00Z";

describe("el celular", () => {
  it("son los últimos 9 dígitos, con o sin 51, +51 o espacios", () => {
    expect(pagoOnlinePhoneKey("987654321")).toBe("987654321");
    expect(pagoOnlinePhoneKey("51987654321")).toBe("987654321");
    expect(pagoOnlinePhoneKey("+51 987 654 321")).toBe("987654321");
    expect(pagoOnlinePhoneKey("(+51) 987-654-321")).toBe("987654321");
    // Como `right(…, 9)` de la consulta de referencia: no exige que empiece por 9.
    expect(pagoOnlinePhoneKey("014445566")).toBe("014445566");
  });

  it("con menos de 9 dígitos no hay cliente", () => {
    expect(pagoOnlinePhoneKey("12345")).toBeNull();
    expect(pagoOnlinePhoneKey("")).toBeNull();
    expect(pagoOnlinePhoneKey(null)).toBeNull();
    expect(pagoOnlinePhoneKey(undefined)).toBeNull();
  });

  it("en pantalla solo se ven los tres últimos", () => {
    expect(pagoOnlineMaskedPhone("987654321")).toBe("••• ••• 321");
    expect(pagoOnlineMaskedPhone("98765")).toBe("•••");
  });
});

describe("la regla", () => {
  it("entrega fallida: devuelto, o anulado después de salir; el anulado antes de salir no", () => {
    expect(isFailedDelivery({ general_status: "devuelto", dispatched_at: null })).toBe(true);
    expect(isFailedDelivery({ general_status: "anulado", dispatched_at: OUT })).toBe(true);
    expect(isFailedDelivery({ general_status: "anulado", dispatched_at: null })).toBe(false);
    expect(isFailedDelivery({ general_status: "en_proceso", dispatched_at: OUT })).toBe(false);
    expect(isFailedDelivery({ general_status: "entregado", dispatched_at: OUT })).toBe(false);
  });

  it("1+ fallida y 0 recibidas, las tiendas juntas, por los últimos 9 dígitos", () => {
    const list = pagoOnlineListOf([
      o("+51 987 654 321", "lima", "devuelto", OUT),
      o("987654321", "provincia_cod", "anulado", OUT),
      o("912345678", "lima", "devuelto", OUT),
      o("51912345678", "lima", "entregado", OUT),
      o("913000000", "lima", "anulado", null),
    ]);
    expect(list).toEqual([{ phone: "987654321", failed: 2 }]);
  });

  it("solo cuentan los pedidos contra entrega (lima, provincia_cod)", () => {
    expect(pagoOnlineListOf([o("914000000", "agencia", "devuelto", OUT)])).toEqual([]);
    expect(pagoOnlineListOf([o("914000000", null, "devuelto", OUT)])).toEqual([]);
    // Una entrega por agencia tampoco lo saca: la consulta de referencia solo mira contra entrega.
    expect(pagoOnlineListOf([o("915000000", "lima", "devuelto", OUT), o("915000000", "agencia", "entregado", OUT)])).toEqual([
      { phone: "915000000", failed: 1 },
    ]);
  });

  it("sale de la lista en cuanto recibe un pedido", () => {
    const before = [o("916000000", "lima", "devuelto", OUT)];
    expect(pagoOnlineListOf(before)).toHaveLength(1);
    expect(pagoOnlineListOf([...before, o("916000000", "lima", "entregado", OUT)])).toEqual([]);
  });

  it("sin 9 dígitos no entra; un exceptuado por Kapta tampoco", () => {
    expect(pagoOnlineListOf([o("12345", "lima", "devuelto", OUT)])).toEqual([]);
    expect(pagoOnlineListOf([o("917000000", "lima", "devuelto", OUT)], new Set(["917000000"]))).toEqual([]);
  });

  it("va ordenada, como la manda Kapta", () => {
    const list = pagoOnlineListOf([o("999000000", "lima", "devuelto", OUT), o("911000000", "lima", "devuelto", OUT)]);
    expect(list.map((x) => x.phone)).toEqual(["911000000", "999000000"]);
  });
});

describe("los correos", () => {
  it("en minúsculas, válidos, solo de un celular de la lista y de uno solo", () => {
    const listed = new Set(["987654321", "915000000"]);
    const emails = pagoOnlineEmailsOf(
      [
        { customer_phone: "51987654321", email: " A@X.pe " },
        { customer_phone: "987654321", email: "a@x.pe" },
        { customer_phone: "915000000", email: "compartido@x.pe" },
        { customer_phone: "916000000", email: "compartido@x.pe" },
        { customer_phone: "913000000", email: "ajeno@x.pe" },
        { customer_phone: "987654321", email: "no-es-correo" },
      ],
      listed,
    );
    expect(emails).toEqual(["a@x.pe"]);
    expect(pagoOnlineEmailKey("x@y")).toBeNull();
    expect(pagoOnlineEmailKey("X@Y.COM")).toBe("x@y.com");
  });
});

describe("el envío", () => {
  it("el cuerpo lleva la lista entera, sin repetidos, y la regla", () => {
    const body = pagoOnlinePayload(["51987654321", "987654321", "912345678"], ["B@x.pe", "b@x.pe"], "r");
    expect(body).toEqual({ celulares: ["912345678", "987654321"], correos: ["b@x.pe"], regla: "r" });
    expect(pagoOnlinePayload([], [], "vaciar")).toEqual({ celulares: [], correos: [], regla: "vaciar" });
  });

  it("la regla dice las tiendas y la hora de Lima del cálculo", () => {
    expect(pagoOnlineRegla(["Kenku Peru", "Aurela"], new Date("2026-11-10T10:00:00Z"))).toBe(
      "1+ entrega fallida y 0 recibidas, Kenku Peru y Aurela, calculada 2026-11-10 05:00",
    );
    expect(limaDateOf(new Date("2026-11-10T04:59:00Z"))).toBe("2026-11-09");
  });

  it("lee los totales de la tienda sin fiarse de su forma", () => {
    expect(parseCodCoreTotals({ celulares: 512, correos: 140, descartados: 3, actualizado: "2026-11-10T10:00:02+00:00", regla: "x" })).toEqual({
      celulares: 512,
      correos: 140,
      descartados: 3,
      actualizado: "2026-11-10T10:00:02+00:00",
      regla: "x",
    });
    expect(parseCodCoreTotals("nada")).toEqual({ celulares: null, correos: null, descartados: null, actualizado: null, regla: null });
  });
});

describe("cada intento y sus reintentos", () => {
  it("clasifica la respuesta como dice el pedido (§4.3)", () => {
    expect(classifyCodCoreAttempt({ status: 200 })).toBe("enviado");
    expect(classifyCodCoreAttempt({ status: 404, kind: "no_encontrado" })).toBe("sin_endpoint");
    expect(classifyCodCoreAttempt({ status: 401, kind: "credenciales" })).toBe("credenciales");
    expect(classifyCodCoreAttempt({ status: 403, kind: "permisos" })).toBe("credenciales");
    expect(classifyCodCoreAttempt({ status: 413, kind: "rechazo" })).toBe("demasiado_grande");
    expect(classifyCodCoreAttempt({ status: 500, kind: "servidor" })).toBe("reintento");
    expect(classifyCodCoreAttempt({ status: 503, kind: "servidor" })).toBe("reintento");
    expect(classifyCodCoreAttempt({ status: 429, kind: "limite" })).toBe("reintento");
    expect(classifyCodCoreAttempt({ status: null, kind: "tiempo" })).toBe("reintento");
    expect(classifyCodCoreAttempt({ status: null, kind: "red" })).toBe("reintento");
    expect(classifyCodCoreAttempt({ status: 400, kind: "rechazo" })).toBe("rechazado");
    expect(classifyCodCoreAttempt({ status: 200, kind: "respuesta_invalida" })).toBe("rechazado");
    expect(classifyCodCoreAttempt({ status: 302, kind: "redireccion" })).toBe("rechazado");
  });

  it("reintenta a los 1, 5 y 15 minutos; después, ya no", () => {
    const t = new Date("2026-11-10T10:00:00Z");
    expect(PAGO_ONLINE_RETRY_DELAYS_MIN).toEqual([1, 5, 15]);
    expect(PAGO_ONLINE_MAX_ATTEMPTS).toBe(4);
    expect(nextRetryAt(1, "reintento", t)?.toISOString()).toBe("2026-11-10T10:01:00.000Z");
    expect(nextRetryAt(2, "reintento", t)?.toISOString()).toBe("2026-11-10T10:05:00.000Z");
    expect(nextRetryAt(3, "reintento", t)?.toISOString()).toBe("2026-11-10T10:15:00.000Z");
    expect(nextRetryAt(4, "reintento", t)).toBeNull();
  });

  it("nunca reintenta 401/403, 404, 413 ni un rechazo", () => {
    const t = new Date();
    for (const outcome of ["credenciales", "sin_endpoint", "demasiado_grande", "rechazado", "enviado"] as const) {
      expect(nextRetryAt(1, outcome, t), outcome).toBeNull();
    }
  });

  it("el estado que queda: se reintenta, o falló del todo", () => {
    expect(sendStatusOf("reintento", true)).toBe("reintento");
    expect(sendStatusOf("reintento", false)).toBe("fallido");
    expect(sendStatusOf("rechazado", false)).toBe("fallido");
    expect(sendStatusOf("sin_endpoint", false)).toBe("sin_endpoint");
    expect(sendStatusOf("enviado", false)).toBe("enviado");
  });
});

describe("la alerta de dos días seguidos", () => {
  it("solo si hoy y ayer terminaron mal de verdad", () => {
    expect(shouldAlertTwoDays([{ runDate: "2026-11-10", status: "fallido" }, { runDate: "2026-11-09", status: "credenciales" }], "2026-11-10")).toBe(true);
    expect(shouldAlertTwoDays([{ runDate: "2026-11-10", status: "fallido" }, { runDate: "2026-11-09", status: "enviado" }], "2026-11-10")).toBe(false);
    expect(shouldAlertTwoDays([{ runDate: "2026-11-10", status: "fallido" }, { runDate: "2026-11-08", status: "fallido" }], "2026-11-10")).toBe(false);
    expect(shouldAlertTwoDays([{ runDate: "2026-11-10", status: "reintento" }, { runDate: "2026-11-09", status: "fallido" }], "2026-11-10")).toBe(false);
  });

  it("la tienda sin el endpoint todavía (404) no es un día fallido", () => {
    expect(isFailedDay("sin_endpoint")).toBe(false);
    expect(shouldAlertTwoDays([{ runDate: "2026-11-10", status: "sin_endpoint" }, { runDate: "2026-11-09", status: "sin_endpoint" }], "2026-11-10")).toBe(false);
  });

  it("los avisos no llevan celulares ni correos", () => {
    for (const kind of ["dos_dias", "freno_cambio", "demasiado_grande"] as const) {
      const text = pagoOnlineAlertText({ kind, storeName: "Kenku Peru", detail: "HTTP 503", phones: 51234 });
      expect(text).toContain("Kenku Peru");
      expect(text).not.toMatch(/\d{9}/);
      expect(text).not.toContain("@");
    }
  });
});

describe("el freno de cambio brusco (§4.5)", () => {
  it("la primera lista pasa", () => {
    expect(pagoOnlineGuard(3885, null)).toEqual({ ok: true, kind: "primera", baseline: null });
    expect(pagoOnlineGuard(3885, 0).ok).toBe(true);
  });

  it("hasta el doble y hasta la mitad pasa; más allá, no", () => {
    expect(pagoOnlineGuard(1000, 500)).toEqual({ ok: true, kind: "ok", baseline: 500 });
    expect(pagoOnlineGuard(250, 500).ok).toBe(true);
    const more = pagoOnlineGuard(1001, 500);
    expect(more.ok).toBe(false);
    expect(!more.ok && more.reason).toContain("más del doble");
    const less = pagoOnlineGuard(249, 500);
    expect(!less.ok && less.reason).toContain("menos de la mitad");
    expect(pagoOnlineGuard(0, 500).ok).toBe(false);
  });
});

describe("lo que se cobra y el freno de un pedido", () => {
  const facts = (paymentState: string | null, over: Record<string, unknown> = {}) => ({ paymentState, financialStatus: "pending", paymentGateway: null, totalRefunded: 0, ...over });

  it("por defecto, el adelanto de la escalera del §8 (decisión del owner del 09-11-2026)", () => {
    expect(PAGO_ONLINE_DEFAULT_REQUIREMENT).toBe("adelanto");
    expect(PAGO_ONLINE_REQUIREMENT_LABEL).toEqual({ adelanto: "Adelanto (regla §8)", pago_completo: "Pago completo" });
  });

  it("adelanto: lo cumple el adelanto validado o el pago completo; uno cargado sin validar, no", () => {
    for (const s of ["adelanto_validado", "diferencia_cargada", "pago_completo"]) expect(pagoOnlineRequirementMet("adelanto", facts(s)), s).toBe(true);
    for (const s of [null, "sin_pago", "adelanto_cargado", "pago_total_cargado"]) expect(pagoOnlineRequirementMet("adelanto", facts(s)), String(s)).toBe(false);
    expect(pagoOnlineRequirementMet("adelanto", facts(null, { financialStatus: "paid", paymentGateway: "checkout" }))).toBe(true);
  });

  it("pago completo: solo el pago completo (comprobantes o checkout)", () => {
    expect(pagoOnlineRequirementMet("pago_completo", facts("adelanto_validado"))).toBe(false);
    expect(pagoOnlineRequirementMet("pago_completo", facts("pago_completo"))).toBe(true);
    expect(pagoOnlineRequirementMet("pago_completo", facts(null, { financialStatus: "paid", paymentGateway: "checkout" }))).toBe(true);
    expect(pagoOnlineRequirementMet("pago_completo", facts(null, { financialStatus: "paid", paymentGateway: "checkout", totalRefunded: 10 }))).toBe(false);
  });

  it("fuera de la lista pasa; en la lista sin lo que se pide, frena con el motivo y sus cuentas", () => {
    expect(pagoOnlineBrakeDecision({ listed: false, requirement: "adelanto", facts: facts(null), point: "guia" })).toEqual({ state: "ok", listed: false });
    expect(pagoOnlineBrakeDecision({ listed: true, requirement: "adelanto", facts: facts("adelanto_validado"), point: "guia" })).toEqual({
      state: "ok",
      listed: true,
      met: true,
    });
    const b = pagoOnlineBrakeDecision({ listed: true, failed: 2, requirement: "adelanto", facts: facts("adelanto_cargado"), point: "confirmar" });
    expect(b.state).toBe("blocked");
    expect(b.state === "blocked" && b.message).toContain(PAGO_ONLINE_HEADLINE);
    expect(b.state === "blocked" && b.message).toContain("2 entregas fallidas, 0 recibidas");
    expect(b.state === "blocked" && b.message).toContain("No se confirma contra entrega");
    expect(pagoOnlineBlockMessage("guia", "pago_completo", 1)).toContain("1 entrega fallida");
    expect(pagoOnlineBlockMessage("guia", "pago_completo", 1)).toContain("pago completo");
  });
});
