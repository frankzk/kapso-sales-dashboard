// El lector de constancias de pago de Tanders.
//
// Lo que se fija acá es la LECTURA del medio, que tiene una trampa real: una
// constancia de Plin nombra el destino como número «Yape» («Enviado a: Grupo Gf
// S · 930 555 309 - Yape»), así que un lector ingenuo la clasifica como Yape.
// Para el veredicto da igual —los dos valen— pero el reporte que lee la
// operadora tiene que decir lo que de verdad se vio.

import { afterEach, describe, expect, it, vi } from "vitest";
import { paidAtFrom, readTandersPayment } from "@/lib/tanders/payment-vision";

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

  it("el prompt describe la app del BCP, que no siempre muestra su logo", async () => {
    // #AUR177129: «¡Transferencia exitosa!» desde la app del BCP a un Yape salió
    // «otro», y el cobro quedó en revisión por el medio. El prompt solo
    // describía Yape (morado) y Plin (celeste).
    let prompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, req: RequestInit) => {
        const body = JSON.parse(String(req.body));
        prompt = body.messages[0].content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("\n");
        return { ok: true, json: async () => ({ content: [] }) };
      }),
    );
    await readTandersPayment("b", "image/jpeg", CREDS);
    expect(prompt).toContain("LA APP DEL BCP NO SIEMPRE MUESTRA SU LOGO");
    expect(prompt).toContain("¡Transferencia exitosa!");
    expect(prompt).toContain("**** 0012");
  });

  it("#KP136441: un Prex a Yape dice adónde fue el dinero, aparte de qué app lo emitió", async () => {
    // Prex: «Titular: Grupo Gf S A C» · «Cuenta/billetera: Yape».
    vi.stubGlobal(
      "fetch",
      anthropicDice(
        '{"is_payment_proof":true,"method":"otro","destination":"Yape","recipient_name":"Grupo Gf S A C","amount":298,"operation_number":"092514213996"}',
      ),
    );
    const r = await readTandersPayment("b", "image/jpeg", CREDS);
    expect(r).toMatchObject({ method: "otro", toYape: true, recipientName: "Grupo Gf S A C" });
  });

  it("sin destino en la constancia, no se da por pagado a un Yape", async () => {
    for (const destination of ["null", '"Cuenta BBVA 0011-0123"', '""']) {
      vi.stubGlobal(
        "fetch",
        anthropicDice(`{"is_payment_proof":true,"method":"otro","destination":${destination}}`),
      );
      expect((await readTandersPayment("b", "image/jpeg", CREDS)).toYape).toBe(false);
    }
  });

  it("el prompt pide el destino aparte de la app", async () => {
    let prompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, req: RequestInit) => {
        prompt = JSON.parse(String(req.body)).messages[0].content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("\n");
        return { ok: true, json: async () => ({ content: [] }) };
      }),
    );
    await readTandersPayment("b", "image/jpeg", CREDS);
    expect(prompt).toContain('"destination"');
    expect(prompt).toContain("MUCHAS APPS PAGAN A UN YAPE");
    expect(prompt).toContain("Cuenta/billetera: Yape");
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

describe("readTandersPayment · fecha y hora del pago", () => {
  it("lee la hora con su «p. m.» para cruzar con el estado de cuenta", async () => {
    // #AUR177586: «30 set. 2026 · 07:01 p. m.»; en el estado de cuenta de Yape
    // es «Jesus Alv*» a las 19:01:21.
    vi.stubGlobal(
      "fetch",
      anthropicDice(
        '{"is_payment_proof":true,"method":"yape","amount":116.1,"operation_number":"28446207","date":"30 set. 2026","time":"07:01 p. m."}',
      ),
    );
    const r = await readTandersPayment("b", "image/jpeg", CREDS);
    expect(r.paidAt).toBe("2026-10-01T00:01:00.000Z");
  });

  it("sin hora no se inventa la medianoche", async () => {
    vi.stubGlobal(
      "fetch",
      anthropicDice('{"is_payment_proof":true,"method":"yape","amount":99,"date":"03 oct. 2026","time":null}'),
    );
    expect((await readTandersPayment("b", "image/jpeg", CREDS)).paidAt).toBeNull();
  });
});

describe("paidAtFrom", () => {
  it("el Plin de Scotiabank no trae año: es el de la lectura (#KP138386)", () => {
    const now = Date.parse("2026-10-04T21:00:00.000Z");
    expect(paidAtFrom("03 oct.", "02:13 p. m.", now)).toBe("2026-10-03T19:13:00.000Z");
  });

  it("una de diciembre leída en enero es del año anterior", () => {
    const now = Date.parse("2027-01-02T15:00:00.000Z");
    expect(paidAtFrom("30 dic.", "08:00 p. m.", now)).toBe("2026-12-31T01:00:00.000Z");
  });
});
