import { describe, expect, it, vi } from "vitest";
import { FlowClient, flowPaymentLink } from "@/lib/flow/client";
import { FlowApiError, FlowTimeoutError, FLOW_MEDIO_YAPE_ONE_SHOT } from "@/lib/flow/types";
import { signFlowParams } from "@/lib/flow/sign";

/**
 * El cliente de Flow.cl.
 *
 * Lo que se prueba acá es lo que no se puede depurar desde la respuesta de
 * Flow: que todo lo que sale vaya firmado, que un fallo de transporte no se
 * disfrace de «Flow rechazó el pago», y que crear una orden no se reintente
 * nunca —dos links vivos por el mismo pedido es un cliente pagando dos veces—.
 */

const CREDENCIALES = { apiKey: "APIKEY-1234", secretKey: "secreto-de-prueba" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const COBRO_OK = { url: "https://www.flow.cl/app/web/pay.php", token: "TOK123", flowOrder: 181182854 };

function cobroValido() {
  return {
    commerceOrder: "ADEL-1042",
    subject: "Adelanto pedido",
    amount: 20,
    email: "cliente@correo.pe",
    urlConfirmation: "https://kapta.pe/api/webhooks/flowcl/tienda-1",
    urlReturn: "https://kapta.pe/pago/retorno",
  };
}

describe("createPayment", () => {
  it("manda todo firmado y arma el link", async () => {
    let body: URLSearchParams | null = null;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = new URLSearchParams(String(init?.body));
      return jsonResponse(COBRO_OK);
    }) as unknown as typeof fetch;

    const res = await new FlowClient({ ...CREDENCIALES, fetchImpl }).createPayment({
      ...cobroValido(),
      currency: "PEN",
      paymentMethod: FLOW_MEDIO_YAPE_ONE_SHOT,
      timeout: 900,
    });

    expect(res.link).toBe("https://www.flow.cl/app/web/pay.php?token=TOK123");
    expect(res.flowOrder).toBe(181182854);

    // La comprobación que importa: se recalcula la firma con TODO lo que
    // viajó menos `s`. Si el cliente hubiera añadido un campo después de
    // firmar —o se hubiera dejado uno fuera—, esto no cuadra.
    const enviado = Object.fromEntries(body!.entries());
    const { s, ...firmados } = enviado;
    expect(s).toBe(signFlowParams(firmados, CREDENCIALES.secretKey));
    expect(firmados.paymentMethod).toBe(String(FLOW_MEDIO_YAPE_ONE_SHOT));
    expect(firmados.timeout).toBe("900");
    expect(firmados.apiKey).toBe(CREDENCIALES.apiKey);
  });

  it("no manda los opcionales que no se pidieron", async () => {
    let body: URLSearchParams | null = null;
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      body = new URLSearchParams(String(init?.body));
      return jsonResponse(COBRO_OK);
    }) as unknown as typeof fetch;

    await new FlowClient({ ...CREDENCIALES, fetchImpl }).createPayment(cobroValido());
    expect(body!.has("paymentMethod")).toBe(false);
    expect(body!.has("timeout")).toBe(false);
    // Y aun así la firma cuadra con lo que quedó.
    const { s, ...firmados } = Object.fromEntries(body!.entries());
    expect(s).toBe(signFlowParams(firmados, CREDENCIALES.secretKey));
  });

  it("va por POST a /payment/create con el content-type del manual", async () => {
    const llamadas: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      llamadas.push({ url: String(url), init });
      return jsonResponse(COBRO_OK);
    }) as unknown as typeof fetch;

    await new FlowClient({ ...CREDENCIALES, fetchImpl }).createPayment(cobroValido());
    expect(llamadas[0]?.url).toBe("https://www.flow.cl/api/payment/create");
    expect(llamadas[0]?.init?.method).toBe("POST");
    expect((llamadas[0]?.init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("NO reintenta: crear una orden dos veces deja dos links cobrables", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    await expect(
      new FlowClient({ ...CREDENCIALES, fetchImpl }).createPayment(cobroValido()),
    ).rejects.toBeInstanceOf(FlowTimeoutError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rechaza una url de callback relativa antes de salir a la red", async () => {
    // Una variable de entorno vacía produce «undefined/api/…». Se ve acá y no
    // en el soporte de Flow tres días después, con el cobro sin confirmar.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      new FlowClient({ ...CREDENCIALES, fetchImpl }).createPayment({
        ...cobroValido(),
        urlConfirmation: "undefined/api/webhooks/flowcl/t1",
      }),
    ).rejects.toThrow(/urlConfirmation.*absoluta/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("una respuesta 200 sin token no es un cobro creado", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ url: "https://x" })) as unknown as typeof fetch;
    await expect(
      new FlowClient({ ...CREDENCIALES, fetchImpl }).createPayment(cobroValido()),
    ).rejects.toBeInstanceOf(FlowApiError);
  });
});

describe("errores", () => {
  it("traduce el objeto Error de Flow y conserva el mensaje útil", async () => {
    // Es el error real que devolvió la sonda con un email de relleno.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 1000, message: "The userEmail: sonda@example.com is not valid." }, 400),
    ) as unknown as typeof fetch;

    const err = await new FlowClient({ ...CREDENCIALES, fetchImpl })
      .createPayment(cobroValido())
      .catch((e) => e);

    expect(err).toBeInstanceOf(FlowApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe(1000);
    expect(err.message).toMatch(/userEmail/);
  });

  it("reconoce la apiKey desconocida, que se disfraza de llave mal copiada", async () => {
    // Es lo que devuelve el SANDBOX ante una llave de producción. Sin
    // distinguirlo se pierde media tarde revisando el copiar-pegar.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 401, message: "Internal Server Error - apiKey not found" }, 401),
    ) as unknown as typeof fetch;

    const err = await new FlowClient({ ...CREDENCIALES, fetchImpl })
      .getStatus("TOK")
      .catch((e) => e);

    expect(err).toBeInstanceOf(FlowApiError);
    expect(err.isUnknownApiKey).toBe(true);
  });

  it("una respuesta que no es JSON no es «Flow rechazó el pago»", async () => {
    // Un proxy, un portal cautivo o una caída devuelven HTML. Tratarlo como
    // respuesta de la pasarela sería inventarse que Flow dijo algo.
    const fetchImpl = vi.fn(
      async () => new Response("<html>403 Forbidden</html>", { status: 403 }),
    ) as unknown as typeof fetch;

    const err = await new FlowClient({ ...CREDENCIALES, fetchImpl })
      .getStatus("TOK")
      .catch((e) => e);

    expect(err).toBeInstanceOf(FlowTimeoutError);
    expect(err).not.toBeInstanceOf(FlowApiError);
    expect(err.message).toMatch(/no-JSON/i);
  });

  it("un timeout se distingue de un rechazo", async () => {
    const fetchImpl = vi.fn(
      (_u: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    ) as unknown as typeof fetch;

    const err = await new FlowClient({ ...CREDENCIALES, fetchImpl, timeoutMs: 10 })
      .getStatus("TOK")
      .catch((e) => e);

    expect(err).toBeInstanceOf(FlowTimeoutError);
    expect(err.message).toMatch(/no respondió/i);
  });
});

describe("getStatus", () => {
  it("va por GET con la firma en la query", async () => {
    let url = "";
    const fetchImpl = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
      url = String(u);
      expect(init?.method).toBe("GET");
      return jsonResponse({ flowOrder: 1, commerceOrder: "ADEL-1", status: 2 });
    }) as unknown as typeof fetch;

    const res = await new FlowClient({ ...CREDENCIALES, fetchImpl }).getStatus("TOK123");

    const qs = new URLSearchParams(url.split("?")[1]);
    const { s, ...firmados } = Object.fromEntries(qs.entries());
    expect(firmados).toEqual({ apiKey: CREDENCIALES.apiKey, token: "TOK123" });
    expect(s).toBe(signFlowParams(firmados, CREDENCIALES.secretKey));
    expect(res.status).toBe(2);
  });

  it("sin token no sale a la red", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(new FlowClient({ ...CREDENCIALES, fetchImpl }).getStatus("")).rejects.toThrow(
      /token/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("flowPaymentLink", () => {
  it("une url y token como dice el manual: con `?token=`", () => {
    expect(flowPaymentLink("https://www.flow.cl/app/web/pay.php", "ABC")).toBe(
      "https://www.flow.cl/app/web/pay.php?token=ABC",
    );
  });
});

describe("configuración", () => {
  it("sin credenciales no se construye", () => {
    expect(() => new FlowClient({ apiKey: "", secretKey: "x" })).toThrow(/apiKey y secretKey/);
    expect(() => new FlowClient({ apiKey: "x", secretKey: "" })).toThrow(/apiKey y secretKey/);
  });

  it("apunta a producción por omisión y admite el sandbox", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      urls.push(String(u));
      return jsonResponse({ status: 1 });
    }) as unknown as typeof fetch;

    await new FlowClient({ ...CREDENCIALES, fetchImpl }).getStatus("T");
    await new FlowClient({
      ...CREDENCIALES,
      fetchImpl,
      baseUrl: "https://sandbox.flow.cl/api/",
    }).getStatus("T");

    expect(urls[0]).toMatch(/^https:\/\/www\.flow\.cl\/api\//);
    // La barra final se recorta: sin eso saldría «…/api//payment/getStatus».
    expect(urls[1]).toMatch(/^https:\/\/sandbox\.flow\.cl\/api\/payment/);
  });
});
