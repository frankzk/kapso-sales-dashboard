import { describe, expect, it } from "vitest";
import { listProducts, type AliclikClientOpts } from "@/lib/aliclik";

// Un timeout AGUAS ABAJO tiene que seguir marcándose como timeout.
//
// El transporte directo ve el timeout como excepción y lo distingue. Por Edge no:
// el proxy responde 200 y mete el fallo DENTRO del cuerpo (`egressError`), así
// que sin mirar el texto todo llegaba como fallo definitivo.
//
// Lo que costaba: la creación de guías trata `timedOut` aparte a propósito —deja
// la intención en `pending` y bloquea el reintento, porque Aliclik PUDO haberla
// creado—. Al perderse esa marca, la intención se cerraba como `failed`, el
// operador leía «Aliclik rechazó el pedido», reintentaba, y quedaban dos guías
// para un mismo pedido: la primera invisible, con su número en la respuesta que
// nunca llegó. Pasó 5 veces entre el 30-07 y el 07-08.

const BASE = "https://api.aliclik-test.local";

function stubOnce(status: number, body: unknown) {
  const impl = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return impl;
}

const opts = (fetchImpl: typeof fetch): AliclikClientOpts => ({
  apiToken: "tok_123",
  baseUrl: BASE,
  fetchImpl,
  egress: "direct",
  retryBaseMs: 0,
});

describe("egressError: distinguir el timeout del rechazo", () => {
  it("marca timedOut con el texto real que devolvió el proxy", async () => {
    const res = await listProducts(
      opts(stubOnce(200, { egressError: "The operation was aborted due to timeout" })),
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.timedOut).toBe(true);
  });

  it("reconoce las otras formas de decir lo mismo", async () => {
    for (const detail of ["TimeoutError", "socket hang up: ETIMEDOUT", "request timed out"]) {
      const res = await listProducts(opts(stubOnce(200, { egressError: detail })));
      expect(res.ok === false && res.timedOut, detail).toBe(true);
    }
  });

  it("un fallo de salida que NO es timeout no se marca como tal", async () => {
    const res = await listProducts(
      opts(stubOnce(200, { egressError: "ECONNREFUSED: no route to host" })),
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.timedOut).toBeFalsy();
  });

  it("sigue explicando que el fallo es de NUESTRA salida, no de Aliclik", async () => {
    const res = await listProducts(
      opts(stubOnce(200, { egressError: "The operation was aborted due to timeout" })),
    );
    expect(res.ok === false && res.error).toContain("Salida por Edge no disponible");
  });
});
