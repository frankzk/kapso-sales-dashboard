import { describe, expect, it } from "vitest";
import {
  flowRequestPairs,
  flowSignedPairs,
  flowStringToSign,
  signFlowParams,
} from "@/lib/flow/sign";

/**
 * La firma de Flow.cl.
 *
 * POR QUÉ ESTAS PRUEBAS Y NO OTRAS. Las dos formas de romper el firmado son
 * silenciosas: Flow responde 401 sin decir qué parámetro sobra, falta o se
 * firmó distinto de como viajó. No hay forma de depurarlo desde la respuesta,
 * así que el candado tiene que estar acá.
 *
 * El algoritmo quedó validado contra la API REAL el 12-09-2026 —Flow verifica
 * el HMAC en cuanto encuentra la apiKey, y respondió «Transaction not found»
 * en vez de un error de firma—. Estas pruebas fijan ese comportamiento para
 * que no se pierda en la siguiente refactorización.
 */

const SECRETO = "secreto-de-prueba";

describe("el string que se firma", () => {
  it("reproduce el ejemplo del manual de Flow", () => {
    // Del manual: apiKey, currency y amount ordenados y concatenados dan
    // exactamente esto. Si esta línea cambia, el firmado dejó de ser el de Flow.
    expect(
      flowStringToSign({ apiKey: "XXXX-XXXX-XXXX", currency: "CLP", amount: 5000 }),
    ).toBe("amount5000apiKeyXXXX-XXXX-XXXXcurrencyCLP");
  });

  it("ordena por BYTES, no por idioma", () => {
    // El cliente de referencia de Flow es PHP y usa sort(), que compara byte a
    // byte. `localeCompare` pondría `payment_currency` antes que
    // `paymentMethod` —el guion bajo se ignora al comparar por idioma— y la
    // firma dejaría de cuadrar solo cuando se usaran esos dos juntos, que es
    // la clase de fallo que aparece en producción y no en desarrollo.
    const params = { paymentMethod: 170, payment_currency: "PEN", apiKey: "K" };
    expect(flowSignedPairs(params).map(([n]) => n)).toEqual([
      "apiKey",
      "paymentMethod",
      "payment_currency",
    ]);
    expect(Object.keys(params).sort((a, b) => a.localeCompare(b))).not.toEqual([
      "apiKey",
      "paymentMethod",
      "payment_currency",
    ]);
  });

  it("no mete separadores entre nombre y valor", () => {
    expect(flowStringToSign({ a: "1", b: "2" })).toBe("a1b2");
  });

  it("convierte los números con String(), que es lo que viaja", () => {
    // El monto se firma y se envía con la MISMA conversión. Si un día alguien
    // formatea al enviar pero no al firmar, Flow responde 401 y el mensaje
    // habla de otra cosa.
    expect(flowStringToSign({ amount: 20 })).toBe("amount20");
    expect(flowStringToSign({ amount: 20.5 })).toBe("amount20.5");
  });
});

describe("la firma", () => {
  it("es un HMAC-SHA256 hexadecimal estable", () => {
    expect(signFlowParams({ apiKey: "XXXX-XXXX-XXXX", currency: "CLP", amount: 5000 }, SECRETO)).toBe(
      "23a2e1765aa31ff2e0e242d8eb5650ae3302d8089159c3a5c968faa14b3578c8",
    );
  });

  it("cambia si cambia un solo valor", () => {
    const a = signFlowParams({ amount: 20 }, SECRETO);
    const b = signFlowParams({ amount: 21 }, SECRETO);
    expect(a).not.toBe(b);
  });

  it("sin secretKey no firma en vez de firmar con vacío", () => {
    // Firmar con "" produce un hash válido y una petición que Flow rechaza con
    // un 401 idéntico al de una llave equivocada. Mejor fallar acá.
    expect(() => signFlowParams({ amount: 20 }, "")).toThrow(/secretKey/i);
  });
});

describe("lo que NO se puede firmar", () => {
  it("rechaza `s`, que es la firma misma", () => {
    expect(() => flowSignedPairs({ apiKey: "K", s: "yaFirmado" })).toThrow(/`s`/);
  });

  it("rechaza un parámetro sin valor", () => {
    // Sin esto viajaría el string "undefined" y Flow se quejaría del VALOR,
    // escondiendo que el parámetro nunca debió enviarse.
    expect(() => flowSignedPairs({ apiKey: undefined as never })).toThrow(/no tiene valor/i);
    expect(() => flowSignedPairs({ apiKey: null as never })).toThrow(/no tiene valor/i);
  });

  it("rechaza un número que no es finito", () => {
    expect(() => flowSignedPairs({ amount: NaN })).toThrow(/finito/i);
    expect(() => flowSignedPairs({ amount: Infinity })).toThrow(/finito/i);
  });
});

describe("los pares que viajan", () => {
  it("son los firmados MÁS `s`, y nada más", () => {
    // La invariante que sostiene todo: lo que se firma y lo que se envía salen
    // de la misma función, así que no pueden separarse.
    const params = { apiKey: "K", amount: 20, commerceOrder: "ADEL-1" };
    const pares = flowRequestPairs(params, SECRETO);
    const nombres = pares.map(([n]) => n);

    expect(nombres).toEqual(["amount", "apiKey", "commerceOrder", "s"]);
    expect(pares.find(([n]) => n === "s")?.[1]).toBe(signFlowParams(params, SECRETO));
  });

  it("firma TODO opcional que se envíe", () => {
    // Un opcional enviado y no firmado da un 401 mudo. Acá se comprueba que
    // añadir `timeout` cambia la firma: si no la cambiara, es que no entró.
    const base = { apiKey: "K", amount: 20 };
    const conTimeout = { ...base, timeout: 900 };
    expect(signFlowParams(conTimeout, SECRETO)).not.toBe(signFlowParams(base, SECRETO));
    expect(flowStringToSign(conTimeout)).toContain("timeout900");
  });

  it("sobrevive a URLSearchParams sin perder ni reordenar nada", () => {
    // Es como se arma el cuerpo de verdad en el cliente.
    const pares = flowRequestPairs({ apiKey: "K", urlReturn: "https://x.pe/r?a=1&b=2" }, SECRETO);
    const body = new URLSearchParams(pares);
    expect(body.get("urlReturn")).toBe("https://x.pe/r?a=1&b=2");
    expect(body.get("s")).toHaveLength(64);
  });
});
