// El lector de constancias de pago de Tanders.
//
// Lo que se fija acá es la LECTURA del medio, que tiene una trampa real: una
// constancia de Plin nombra el destino como número «Yape» («Enviado a: Grupo Gf
// S · 930 555 309 - Yape»), así que un lector ingenuo la clasifica como Yape.
// Para el veredicto da igual —los dos valen— pero el reporte que lee la
// operadora tiene que decir lo que de verdad se vio.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readTandersPayment } from "@/lib/tanders/payment-vision";

const CREDS = { anthropicApiKey: "sk-test", anthropicModel: "modelo-x" };

/** Responde como la API de Anthropic con el JSON que le pasemos. */
function anthropicDice(json: string) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: json }] }),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("readTandersPayment", () => {
  it("lee un Yape a Grupo GF SAC", async () => {
    vi.stubGlobal(
      "fetch",
      anthropicDice(
        '{"is_payment_proof":true,"method":"yape","recipient_name":"Grupo GF S","amount":298,"operation_number":"12345"}',
      ),
    );
    const r = await readTandersPayment("base64", "image/jpeg", CREDS);
    expect(r.ok).toBe(true);
    expect(r.method).toBe("yape");
    expect(r.recipientName).toBe("Grupo GF S");
    expect(r.amount).toBe(298);
  });

  it("un Plin al número Yape se lee como Plin, no como Yape", async () => {
    vi.stubGlobal(
      "fetch",
      anthropicDice(
        '{"is_payment_proof":true,"method":"plin (a número Yape)","recipient_name":"Grupo Gf S","amount":298,"operation_number":"86480816"}',
      ),
    );
    const r = await readTandersPayment("base64", "image/jpeg", CREDS);
    expect(r.method).toBe("plin");
  });

  it("una transferencia se lee como BCP", async () => {
    vi.stubGlobal(
      "fetch",
      anthropicDice('{"is_payment_proof":true,"method":"transferencia BCP","amount":149}'),
    );
    expect((await readTandersPayment("b", "image/jpeg", CREDS)).method).toBe("bcp");
  });

  it("un medio desconocido no se fuerza a ninguno de los buenos", async () => {
    vi.stubGlobal("fetch", anthropicDice('{"is_payment_proof":true,"method":"mercado pago"}'));
    expect((await readTandersPayment("b", "image/jpeg", CREDS)).method).toBe("otro");
  });

  it("un fallo de la API no es un pago mal hecho: ok=false", async () => {
    // La diferencia importa: `ok:false` deja la guía PENDIENTE (bloquea sin
    // acusar); un veredicto negativo mandaría a alguien a investigar un fraude
    // que no existe. Ver payment-check.ts.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const r = await readTandersPayment("b", "image/jpeg", CREDS);
    expect(r.ok).toBe(false);
    expect(r.isPaymentProof).toBe(false);
  });

  it("sin clave del modelo no llama a nadie y devuelve ok=false", async () => {
    // La clave de la tienda cae a la del entorno (0052), así que hay que
    // vaciar las dos: si no, la prueba pasaría o no según la máquina.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await readTandersPayment("b", "image/jpeg", {});
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
