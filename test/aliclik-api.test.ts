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

// `egress: "direct"` explícito: este bloque prueba el transporte directo
// (cabeceras, parseo de errores, paginación), así que no debe depender de cuál
// sea la salida por defecto — que hoy es `edge`, porque la directa la bloquea
// Cloudflare. El valor por defecto se fija aparte, en test/env-aliclik.test.ts.
const opts = (fetchImpl: typeof fetch): AliclikClientOpts => ({
  apiToken: "tok_123",
  baseUrl: BASE,
  fetchImpl,
  egress: "direct",
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

  it("atribuye a Aliclik los fallos 5xx, que llegan en inglés y genéricos", () => {
    // Su "Internal server error" pelado se lee como un fallo NUESTRO y manda al
    // equipo a revisar el dashboard, que está bien.
    const msg = aliclikErrorMessage(500, { message: "Internal server error" });
    expect(msg).toContain("Internal server error");
    expect(msg).toContain("500");
    expect(msg).toContain("no en el dashboard");
  });

  it("deja intactos los mensajes 4xx, que sí son accionables", () => {
    expect(aliclikErrorMessage(400, { message: "El número de pedido ya existe." })).toBe(
      "El número de pedido ya existe.",
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

  it("acepta diferencias de mayúsculas y espacios sin confundir coincidencias parciales", async () => {
    const { impl } = stubFetch([
      {
        status: 200,
        body: {
          data: [{ orderNumber: "AUR5X1234" }, { orderNumber: "AUR5X123" }],
          pagination: { totalPages: 1 },
        },
      },
    ]);
    const res = await getOrder(opts(impl), "  aur5x123 ");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.orderNumber).toBe("AUR5X123");
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

describe("salida por Edge", () => {
  // Existe porque Cloudflare desafía nuestras peticiones directas (403). El
  // runtime Edge de Vercel sale por otra red, y esa es la hipótesis que queda.
  const edgeOpts = (fetchImpl: typeof fetch): AliclikClientOpts => ({
    apiToken: "tok_123",
    baseUrl: BASE,
    fetchImpl,
    egress: "edge",
    siteUrl: "https://panel.example",
    internalSecret: "secreto_interno",
  });

  it("llama a la ruta interna, no a Aliclik", async () => {
    const { impl, calls } = stubFetch([{ status: 200, body: { count: 7, page: 1, result: [] } }]);
    await listProducts(edgeOpts(impl), { limit: 1 });
    expect(calls[0]!.url).toBe("https://panel.example/api/internal/aliclik-egress");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("manda la ruta con su query, NUNCA el host", async () => {
    const { impl, calls } = stubFetch([{ status: 200, body: { count: 0, page: 1, result: [] } }]);
    await listProducts(edgeOpts(impl), { limit: 1, search: "laptop" });
    const body = JSON.parse(String(calls[0]!.init.body)) as { path: string; method: string };
    expect(body.path.startsWith("/integration/product/public?")).toBe(true);
    expect(body.path).toContain("search=laptop");
    expect(body.method).toBe("GET");
    // El host se decide en el proxy: si viajara aquí, tendríamos un proxy abierto.
    expect(body.path).not.toContain(BASE);
    expect(body.path).not.toContain("http");
  });

  it("separa el token de Aliclik del secreto de la ruta interna", async () => {
    const { impl, calls } = stubFetch([{ status: 200, body: { count: 0, page: 1, result: [] } }]);
    await listProducts(edgeOpts(impl));
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["x-internal-secret"]).toBe("secreto_interno");
    expect(h["x-aliclik-authorization"]).toBe("Bearer tok_123");
    // El token de Aliclik NO debe ir en Authorization: esa cabecera autentica
    // contra nuestra propia ruta, y confundirlas filtraría el token.
    expect(h.Authorization).toBeUndefined();
  });

  it("reenvía el cuerpo de un POST", async () => {
    const { impl, calls } = stubFetch([{ status: 201, body: { message: "ok" } }]);
    await cancelOrder(edgeOpts(impl), "ALC1");
    const body = JSON.parse(String(calls[0]!.init.body)) as { method: string; body: string };
    expect(body.method).toBe("POST");
    expect(JSON.parse(body.body)).toEqual({ orderNumber: "ALC1" });
  });

  it("devuelve los datos de Aliclik igual que la salida directa", async () => {
    const { impl } = stubFetch([{ status: 200, body: { count: 42, page: 1, result: [] } }]);
    const res = await listProducts(edgeOpts(impl));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.count).toBe(42);
  });

  it("un fallo del PROXY no se confunde con un fallo de Aliclik", async () => {
    // Lo peor que podría pasar con este experimento: creer que Aliclik rechaza
    // algo cuando la petición ni salió de nuestra infraestructura.
    const { impl } = stubFetch([{ status: 401, body: { egressError: "no autorizado" } }]);
    const res = await listProducts(edgeOpts(impl));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("Edge no disponible");
    expect(res.error).not.toContain("Token de Aliclik");
  });

  it("sigue reconociendo el muro de Cloudflare a través del proxy", async () => {
    const { impl } = stubFetch([
      { status: 403, body: '<!DOCTYPE html><html><title>Just a moment...</title>' },
    ]);
    const res = await listProducts(edgeOpts(impl));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("Cloudflare");
  });

  it("una opción explícita manda sobre el valor por defecto", async () => {
    // `direct` es la vía de escape para el día en que Aliclik ajuste su WAF.
    const { impl, calls } = stubFetch([{ status: 200, body: { count: 0, page: 1, result: [] } }]);
    await listProducts({ ...edgeOpts(impl), egress: "direct" });
    expect(calls[0]!.url.startsWith(BASE)).toBe(true);
    expect(calls[0]!.url).not.toContain("aliclik-egress");
  });
});

describe("reintento ante fallos pasajeros de Aliclik", () => {
  const opts = (fetchImpl: typeof fetch) =>
    ({ apiToken: "t", egress: "direct" as const, fetchImpl });

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("reintenta un 500 de la cotización y devuelve el resultado bueno", async () => {
    // Medido en producción: su API devuelve 500 de forma intermitente sobre
    // cotizaciones idénticas a otras que funcionan minutos después.
    let calls = 0;
    const res = await quoteShippingCost(
      opts(async () => {
        calls += 1;
        return calls === 1
          ? json(500, { message: "Internal server error" })
          : json(200, { couriers: [{ transportId: 1, deliveryCost: 16.5, returnCost: 10.5, addDays: 3, flagDeliveryExpress: false }] });
      }),
      { warehouseId: 1, lat: "-16.3", lng: "-71.5" },
    );
    expect(calls).toBe(2);
    expect(res.ok).toBe(true);
  });

  it("NO reintenta un 400: un dato malo no mejora solo", async () => {
    let calls = 0;
    const res = await quoteShippingCost(
      opts(async () => {
        calls += 1;
        return json(400, { message: "lat y lng son requeridos" });
      }),
      { warehouseId: 1, lat: "", lng: "" },
    );
    expect(calls).toBe(1);
    expect(res.ok).toBe(false);
  });

  it("NUNCA reintenta crear un pedido: duplicaría una guía real", async () => {
    // Aliclik no tiene idempotency key, así que un segundo POST puede dejar dos
    // guías para el mismo paquete. Se prefiere el error a la duplicación.
    let calls = 0;
    const res = await createOrder(
      opts(async () => {
        calls += 1;
        return json(500, { message: "Internal server error" });
      }),
      {
        delivery: 16.5,
        customer: { name: "X", phone: "51999999999" },
        shipping: { address1: "A", lat: "-16.3", lng: "-71.5" },
        products: [{ ean: "1", quantity: 1, price: 99 }],
        courier: { transportId: 1, deliveryCost: 16.5, returnCost: 10.5, addDays: 3, flagDeliveryExpress: false },
      },
    );
    expect(calls).toBe(1);
    expect(res.ok).toBe(false);
  });

  it("se rinde tras tres intentos y devuelve el error atribuido", async () => {
    let calls = 0;
    const res = await quoteShippingCost(
      opts(async () => {
        calls += 1;
        return json(500, { message: "Internal server error" });
      }),
      { warehouseId: 1, lat: "-16.3", lng: "-71.5" },
    );
    expect(calls).toBe(3);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no en el dashboard");
  });
});

describe("el mensaje no le pide a la operadora lo que ya se hizo", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("dice que ya se reintentó cuando se gastaron los tres intentos", async () => {
    // Antes ponía "reintenta en unos minutos" sin más, y la operadora reintentaba
    // a mano tres veces sobre una racha de 5xx que dura minutos.
    const res = await quoteShippingCost(
      opts(async () => json(500, { message: "Internal server error" })),
      { warehouseId: 133, lat: "-6.781378", lng: "-79.8420078" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Ya se reintentó 3 veces");
  });

  it("NO dice nada de reintentar al crear un pedido, que no se reintenta", async () => {
    // Sería el peor consejo posible: su API no tiene clave de idempotencia.
    const res = await createOrder(opts(async () => json(500, { message: "Internal server error" })), {
      delivery: 16.5,
      customer: { name: "X", phone: "51999999999" },
      shipping: { address1: "A", lat: "-16.3", lng: "-71.5" },
      products: [{ ean: "1", quantity: 1, price: 99 }],
      courier: { transportId: 1, deliveryCost: 16.5, returnCost: 10.5, addDays: 3, flagDeliveryExpress: false },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toMatch(/reintent/i);
  });
});
