import { describe, it, expect } from "vitest";
import {
  aliclikErrorMessage,
  extractRayId,
  isBotChallenge,
  cancelOrder,
  createOrder,
  getOrder,
  interpretCancelResponse,
  listAllProducts,
  listProducts,
  quoteShippingCost,
  type AliclikClientOpts,
} from "@/lib/aliclik";
import { statusFingerprint } from "@/lib/aliclik-track";

const BASE = "https://api.aliclik-test.local";

/** fetch de mentira que registra las llamadas y devuelve respuestas guionizadas. */
function stubFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const opts = (fetchImpl: typeof fetch): AliclikClientOpts => ({
  apiToken: "tok_123",
  baseUrl: BASE,
  fetchImpl,
});

describe("cabeceras y autenticación", () => {
  it("envía las tres cabeceras que Aliclik exige, incluida x-aliclik-origin", () => {
    const { impl, calls } = stubFetch([{ status: 200, body: { count: 0, page: 1, result: [] } }]);
    return listProducts(opts(impl)).then(() => {
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok_123");
      expect(headers["Content-Type"]).toBe("application/json");
      // Sin esta cabecera la API rechaza la petición aunque el token sea válido.
      expect(headers["x-aliclik-origin"]).toBe("aliclik-web");
    });
  });
});

describe("errores", () => {
  it("propaga literal el mensaje en español de un 400", async () => {
    const { impl } = stubFetch([
      { status: 400, body: { statusCode: 400, message: "lat y lng son requeridos", error: "Bad Request" } },
    ]);
    const res = await quoteShippingCost(opts(impl), { warehouseId: 1, lat: "0", lng: "0" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("lat y lng son requeridos");
    expect(res.status).toBe(400);
  });

  it("junta los mensajes cuando llegan como array (validación de NestJS)", () => {
    expect(aliclikErrorMessage(400, { message: ["a es requerido", "b es requerido"] })).toBe(
      "a es requerido; b es requerido",
    );
  });

  it("da un mensaje útil cuando el cuerpo no trae ninguno", () => {
    expect(aliclikErrorMessage(401, {})).toContain("Token");
    expect(aliclikErrorMessage(502, {})).toContain("Shalom");
    expect(aliclikErrorMessage(500, {})).toContain("500");
  });

  it("nunca lanza ante un fallo de red", async () => {
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await listProducts(opts(boom));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("ECONNREFUSED");
    expect(res.timedOut).toBe(false);
  });

  it("distingue un timeout: el pedido PUDO haberse creado", async () => {
    const timeout = (async () => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;
    const res = await createOrder(opts(timeout), {
      delivery: 10,
      customer: { name: "X", phone: "51900000000" },
      shipping: { address1: "A", lat: "-12", lng: "-77" },
      products: [{ ean: "1", quantity: 1, price: 1 }],
      courier: { addDays: 0, deliveryCost: 10, returnCost: 5, transportId: 4, flagDeliveryExpress: false },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.timedOut).toBe(true);
  });
});

describe("paginación del catálogo", () => {
  it("recorre páginas y para en la primera corta", async () => {
    const full = { count: 150, page: 1, result: Array.from({ length: 100 }, (_, i) => ({ id: i })) };
    const partial = { count: 150, page: 2, result: Array.from({ length: 50 }, (_, i) => ({ id: 100 + i })) };
    const { impl, calls } = stubFetch([
      { status: 200, body: full },
      { status: 200, body: partial },
    ]);
    const res = await listAllProducts(opts(impl));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(150);
    expect(calls).toHaveLength(2);
  });

  it("recorta el limit a 100, que es el máximo de la API", async () => {
    const { impl, calls } = stubFetch([{ status: 200, body: { count: 0, page: 1, result: [] } }]);
    await listProducts(opts(impl), { limit: 5000 });
    expect(calls[0]!.url).toContain("limit=100");
  });

  it("pasa isAgency solo cuando es true", async () => {
    const { impl, calls } = stubFetch([{ status: 200, body: { count: 0, page: 1, result: [] } }]);
    await listProducts(opts(impl), { isAgency: true });
    expect(calls[0]!.url).toContain("isAgency=true");

    const { impl: impl2, calls: calls2 } = stubFetch([{ status: 200, body: { count: 0, page: 1, result: [] } }]);
    await listProducts(opts(impl2), { isAgency: false });
    expect(calls2[0]!.url).not.toContain("isAgency");
  });
});

describe("getOrder", () => {
  it("filtra por igualdad exacta — orderNumber en la API es búsqueda parcial", async () => {
    const { impl } = stubFetch([
      {
        status: 200,
        body: { data: [{ orderNumber: "ALC12" }, { orderNumber: "ALC1" }], pagination: { totalPages: 1 } },
      },
    ]);
    const res = await getOrder(opts(impl), "ALC1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.orderNumber).toBe("ALC1");
  });

  it("devuelve null cuando no aparece el pedido exacto", async () => {
    const { impl } = stubFetch([{ status: 200, body: { data: [{ orderNumber: "ALC12" }] } }]);
    const res = await getOrder(opts(impl), "ALC1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toBeNull();
  });
});

describe("interpretCancelResponse", () => {
  it("NO da por cancelado un 'Pedido no confirmado.' — la API responde 201 igual", () => {
    expect(interpretCancelResponse("Pedido no confirmado.")).toBe("not_confirmed");
  });

  it("reconoce la cancelación real", () => {
    expect(interpretCancelResponse("Pedido cancelado correctamente.")).toBe("cancelled");
    expect(interpretCancelResponse("Pedido por agencia anulado correctamente.")).toBe("cancelled");
  });

  it("ante un mensaje inesperado no adivina", () => {
    expect(interpretCancelResponse("algo raro")).toBe("unknown");
    expect(interpretCancelResponse(null)).toBe("unknown");
  });

  it("el 201 con 'no confirmado' no se confunde con éxito en el flujo real", async () => {
    const { impl } = stubFetch([{ status: 201, body: { message: "Pedido no confirmado." } }]);
    const res = await cancelOrder(opts(impl), "ALC1");
    // La llamada HTTP fue un éxito...
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // ...pero el pedido NO se canceló.
    expect(interpretCancelResponse(res.data.message)).toBe("not_confirmed");
  });
});

describe("statusFingerprint", () => {
  it("es estable e insensible a mayúsculas y espacios", () => {
    const a = statusFingerprint({ orderNumber: "ALC1", status: "DELIVERED", callStatus: "CONFIRMED", dispatchStatus: "PICKED" });
    const b = statusFingerprint({ orderNumber: " alc1 ", status: "delivered", callStatus: "confirmed", dispatchStatus: "picked" });
    expect(a).toBe(b);
  });

  it("cambia cuando cambia cualquier parte del estado", () => {
    const base = { orderNumber: "ALC1", status: "PENDING_DELIVERY", callStatus: "CONFIRMED", dispatchStatus: "TO_PREPARE" };
    const moved = statusFingerprint({ ...base, dispatchStatus: "PICKED" });
    expect(moved).not.toBe(statusFingerprint(base));
  });
});

describe("desafío anti-bot de Cloudflare", () => {
  // api.aliclik-dev.com está detrás de Cloudflare, que puede interponer un
  // desafío a las peticiones desde centros de datos — que es lo que somos en
  // Vercel. El síntoma engaña: parece un error de la API cuando es de red.
  const CHALLENGE =
    '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>' +
    '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">';

  it("reconoce la página de desafío por su cuerpo", () => {
    expect(isBotChallenge(CHALLENGE)).toBe(true);
    expect(isBotChallenge("<html><body>Attention Required! | Cloudflare</body></html>")).toBe(true);
  });

  it("lo reconoce también por el content-type", () => {
    expect(isBotChallenge("cualquier cosa", "text/html; charset=UTF-8")).toBe(true);
  });

  it("no confunde una respuesta legítima de la API con un desafío", () => {
    expect(isBotChallenge({ count: 0, result: [] }, "application/json")).toBe(false);
    expect(isBotChallenge("Pedido cancelado correctamente.")).toBe(false);
    expect(isBotChallenge(null)).toBe(false);
  });

  it("explica que NO es el token, en vez de escupir el HTML", async () => {
    const { impl } = stubFetch([{ status: 403, body: CHALLENGE }]);
    const res = await listProducts(opts(impl));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("Cloudflare");
    expect(res.error).toContain("No es el token");
    // Lo que NO debe pasar: enseñar HTML crudo al equipo.
    expect(res.error).not.toContain("<!DOCTYPE");
    expect(res.error).not.toContain("<meta");
  });

  it("un desafío servido con 200 tampoco pasa por éxito", async () => {
    // Cloudflare sirve algunos desafíos con 200; tratarlo como éxito daría un
    // catálogo vacío "correcto" y nadie se enteraría.
    const { impl } = stubFetch([{ status: 200, body: CHALLENGE }]);
    const res = await listProducts(opts(impl));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("Cloudflare");
  });

  it("manda User-Agent — una petición sin él es la primera que Cloudflare marca", async () => {
    const { impl, calls } = stubFetch([{ status: 200, body: { count: 0, page: 1, result: [] } }]);
    await listProducts(opts(impl));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("kapso-sales-dashboard");
  });
});

describe("Ray ID de Cloudflare", () => {
  // Es lo que permite a Aliclik encontrar ESTE bloqueo en su panel. Sin él, el
  // reporte es "a veces nos bloquea" y se eterniza.
  it("lo saca del pie de la página de desafío", () => {
    expect(extractRayId("<p>Ray ID: 8f1a2b3c4d5e6f70</p>")).toBe("8f1a2b3c4d5e6f70");
    expect(extractRayId('<span class="ray">Ray ID: 9a0b1c2d3e4f5061</span>')).toBe("9a0b1c2d3e4f5061");
  });

  it("no inventa uno cuando no está", () => {
    expect(extractRayId("<html>sin ray</html>")).toBeNull();
    expect(extractRayId({ message: "x" })).toBeNull();
  });

  it("prefiere la cabecera cf-ray, que es la fuente fiable", () => {
    const msg = aliclikErrorMessage(403, "<!DOCTYPE html>Just a moment...", "text/html", "abc123def456");
    expect(msg).toContain("abc123def456");
    expect(msg).toContain("Ray ID");
  });

  it("sigue siendo legible cuando no hay Ray ID", () => {
    const msg = aliclikErrorMessage(403, "<!DOCTYPE html>Just a moment...", "text/html", null);
    expect(msg).toContain("Cloudflare");
    expect(msg).not.toContain("Ray ID");
  });
});
