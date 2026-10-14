// El cliente de SimpleFact (lib/invoicing/simplefact.ts, MOM §35.4).
//
// Aquí no hay red: `fetchImpl` es siempre un falso y nunca se llama a
// SimpleFact. Lo que se fija es lo que no se puede depurar después desde una
// boleta ya enviada a SUNAT: que crear la venta sea UNA sola llamada, que un
// corte o un 3xx vuelvan como «no se sabe» (y el comprobante quede en duda, no
// repetido), y que el token no salga nunca: ni en la URL, ni en un error, ni en
// lo que se guarda de la respuesta. Las respuestas son las de la documentación
// de SimpleFact (docs.simplefact.pe/api/sales), con su RUC de ejemplo
// 20601643316 en el nombre de los archivos.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SIMPLEFACT_GET_TIMEOUT_MS,
  SIMPLEFACT_POST_TIMEOUT_MS,
  SIMPLEFACT_RAW_MAX_CHARS,
  SIMPLEFACT_TEST_PAGE_SIZE,
  simplefactCreateSale,
  simplefactListSales,
  testSimplefactConnection,
  type SimplefactConn,
} from "@/lib/invoicing/simplefact";
import { buildSalePayload, classifySaleResponse, type SimplefactSalePayload } from "@/lib/invoicing/rules";

// ── Datos ────────────────────────────────────────────────────────────────────

/** Un token de prueba con la forma de uno real. No es de ninguna cuenta. */
const TOKEN = "b00131b17becc9906f5081793e79a5d74a7ab6cbPRUEBA0000000000";
const BASE = "https://grupogf.simplefact.pe/api/v1";
/** El RUC de los archivos de ejemplo de la documentación. */
const RUC_DOC = "20601643316";
/** GRUPO GF S.A.C. (§35.2). */
const RUC_GF = "20556792829";

function payload(): SimplefactSalePayload {
  const built = buildSalePayload({
    invoiceId: "6f1c2a3b-9d8e-4f00-a1b2-c3d4e5f60718",
    orderName: "#KP136181",
    items: [
      { code: "FAJA-01", name: "Faja Reductora Colombiana", qty: 1, priceCents: 12_990 },
      { code: "ENVIO", name: "Servicio de envío", qty: 1, priceCents: 1_000 },
    ],
    totalCents: 13_990,
  });
  if (!built) throw new Error("la boleta de prueba no cuadra");
  return built;
}

/** La venta de ejemplo de «Listar ventas» (factura F001-141). */
function docListSale(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 409,
    invoice_type_name: "Factura de Venta Electrónica",
    invoice_type: "01",
    invoice_type_name_short: "F",
    serie: "F001",
    correlative: "141",
    customer_name: "ACR TECHNOLGIES SAC",
    status: "processing",
    tax_total: "6101.69",
    total: "40000.00",
    date: "2020-05-06T23:27:59.000000Z",
    currency: "PEN",
    xml_url: "https://demo.simplefact.pe/app/download/invoices/20601643316-01-F001-141.xml",
    pdf_url: "https://demo.simplefact.pe/app/download/invoices/20601643316-01-F001-141.pdf",
    bill: {
      id: 276,
      message: "La Factura numero F001-141, ha sido aceptada",
      order_id: 409,
      cdr_url: "https://demo.simplefact.pe/app/download/invoices/R-20601643316-01-F001-141.zip",
      status: "accepted",
    },
    void: null,
    notes: null,
    items: [],
    origin: "api",
    payment_method: "cash",
    payment_status: "paid",
    ...over,
  };
}

function docList(data: unknown[]): Record<string, unknown> {
  return {
    data,
    links: { first: `${BASE}/sales/orders?page=1`, prev: null, next: null },
    meta: { current_page: 1, from: 1, last_page: 1, per_page: "20", to: data.length, total: data.length },
  };
}

/** Tal como la manda SimpleFact (PHP): con las barras escapadas. */
const DOC_LIST_RAW = String.raw`{"data":[{"id":409,"invoice_type":"01","serie":"F001","correlative":"141","xml_url":"https:\/\/demo.simplefact.pe\/app\/download\/invoices\/20601643316-01-F001-141.xml","pdf_url":"https:\/\/demo.simplefact.pe\/app\/download\/invoices\/20601643316-01-F001-141.pdf","bill":{"id":276,"cdr_url":"https:\/\/demo.simplefact.pe\/app\/download\/invoices\/R-20601643316-01-F001-141.zip","status":"accepted"},"notes":null}],"links":{"next":null},"meta":{"total":1}}`;

/** La respuesta de ejemplo de «Crear una venta» (boleta B001-97). */
const DOC_CREATE = {
  success: true,
  data: {
    id: 407,
    invoice_type: "03",
    invoice_number: "B001-97",
    serie: "B001",
    correlative: "97",
    customer_name: "CLIENTES VARIOS",
    customer_document_type: "1",
    customer_document_number: "00000000",
    status: "processing",
    total: "139.90",
    currency: "PEN",
    xml_url: "https://demo.simplefact.pe/cdn/ZXlKcGRpSTZJamRselVHWkJh",
    pdf_url: "https://demo.simplefact.pe/cdn/ZXlKcGRpE5kVEp3VGxCcU5YRkdX",
    notes: "Pedido #KP136181 · Kapta 6f1c2a3b",
    bill: {
      id: 275,
      order_id: 407,
      xml_path: "invoices/20601643316-03-B001-97.xml",
      cdr_path: null,
      pdf_path: "invoices/20601643316-03-B001-97.pdf",
      status: "success",
      message: "Enviado a SUNAT",
    },
  },
};

// ── Falsos de fetch ──────────────────────────────────────────────────────────

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function conn(fetchImpl: typeof fetch, over: Partial<SimplefactConn> = {}): SimplefactConn {
  return { subdomain: "grupogf", token: TOKEN, fetchImpl, ...over };
}

/** Un fetch que no contesta nunca y además ignora la señal de aborto. */
const neverFetch = () => vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

/** El fallo de red de undici: «fetch failed» con el código en `cause`. */
function networkError(code: string): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`read ${code}`), { code }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

// ── Crear la venta ───────────────────────────────────────────────────────────

describe("simplefactCreateSale: lo que sale", () => {
  it("un POST a /sales/orders del subdominio, con el Bearer en la cabecera y la boleta tal cual", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(DOC_CREATE));
    const boleta = payload();
    await simplefactCreateSale(conn(fetchImpl), boleta);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(`${BASE}/sales/orders`);
    expect(call!.init.method).toBe("POST");
    expect(call!.init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    expect(typeof call!.init.body).toBe("string");
    expect(JSON.parse(String(call!.init.body))).toEqual(boleta);
    // Comprador sin identificar y sin correo: SimpleFact no le escribe a nadie (§35.5).
    expect(JSON.parse(String(call!.init.body))).toMatchObject({
      invoice_type: "03",
      customer_name: "CLIENTES VARIOS",
      customer_document_number: "00000000",
      email_send: false,
    });
  });

  it("no sigue redirecciones y lleva una señal para cortar", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(DOC_CREATE));
    await simplefactCreateSale(conn(fetchImpl), payload());
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init.cache).toBe("no-store");
  });

  it("el token no va en la URL", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(DOC_CREATE));
    await simplefactCreateSale(conn(fetchImpl), payload());
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(new URL(calls[0]!.url).search).toBe("");
  });

  it("el subdominio pegado como dirección entera se normaliza, y siempre va por https a simplefact.pe", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(DOC_CREATE));
    await simplefactCreateSale(conn(fetchImpl, { subdomain: "https://GrupoGF.simplefact.pe/app" }), payload());
    expect(calls[0]!.url).toBe(`${BASE}/sales/orders`);
  });

  it("un subdominio que no es de simplefact.pe no sale a la red", async () => {
    for (const subdomain of ["evil.com", "grupogf.simplefact.pe.evil.com", "token@evil.com", "", "http://"]) {
      const { fetchImpl } = fakeFetch(() => json(DOC_CREATE));
      const res = await simplefactCreateSale(conn(fetchImpl, { subdomain }), payload());
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(res).toEqual({ http: null, body: null, error: "Subdominio de SimpleFact inválido" });
    }
  });

  it("sin token, o con un token roto (espacios, salto de línea), no sale a la red", async () => {
    for (const [token, error] of [
      ["", "Falta el token de SimpleFact"],
      ["   ", "Falta el token de SimpleFact"],
      [`${TOKEN}\nX-Otra: 1`, "El token de SimpleFact no es válido"],
      ["abc def", "El token de SimpleFact no es válido"],
    ] as const) {
      const { fetchImpl } = fakeFetch(() => json(DOC_CREATE));
      const res = await simplefactCreateSale(conn(fetchImpl, { token }), payload());
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(res).toEqual({ http: null, body: null, error });
    }
  });

  it("el token pegado con espacios alrededor se manda limpio", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(DOC_CREATE));
    await simplefactCreateSale(conn(fetchImpl, { token: `  ${TOKEN}\n` }), payload());
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("simplefactCreateSale: lo que vuelve", () => {
  it("la venta creada vuelve entera, y classifySaleResponse la lee como emitida", async () => {
    const { fetchImpl } = fakeFetch(() => json(DOC_CREATE, 200));
    const res = await simplefactCreateSale(conn(fetchImpl), payload());
    expect(res).toEqual({ http: 200, body: DOC_CREATE });

    const outcome = classifySaleResponse(res.http, res.body, RUC_DOC);
    expect(outcome).toMatchObject({ status: "emitida", simplefactId: 407, serie: "B001", correlative: "97", ruc: RUC_DOC, rucMismatch: false });
    // Con el RUC de otra empresa, la boleta queda marcada (§35.4).
    expect(classifySaleResponse(res.http, res.body, RUC_GF)).toMatchObject({ status: "emitida", rucMismatch: true });
  });

  it("un 4xx vuelve con su código y su mensaje, sin error de transporte", async () => {
    const body = { success: false, message: "The given data was invalid.", errors: { items: ["El campo items es obligatorio."] } };
    const { fetchImpl } = fakeFetch(() => json(body, 422));
    const res = await simplefactCreateSale(conn(fetchImpl), payload());
    expect(res).toEqual({ http: 422, body });
    expect(classifySaleResponse(res.http, res.body, RUC_GF)).toMatchObject({ status: "error", stop: null });
  });

  it("un 3xx vuelve tal cual, no se sigue, y la boleta queda en duda", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () => new Response("", { status: 302, headers: { Location: "https://login.simplefact.pe/" } }),
    );
    const res = await simplefactCreateSale(conn(fetchImpl), payload());
    expect(calls).toHaveLength(1);
    expect(res).toEqual({ http: 302, body: { raw: "" } });
    expect(classifySaleResponse(res.http, res.body, RUC_GF).status).toBe("en_duda");
  });

  it("una página que no es JSON se guarda recortada en { raw }", async () => {
    const html = `<html><body>502 Bad Gateway</body></html>${" ".repeat(5_000)}`;
    const { fetchImpl } = fakeFetch(() => new Response(html, { status: 502, headers: { "Content-Type": "text/html" } }));
    const res = await simplefactCreateSale(conn(fetchImpl), payload());
    expect(res.http).toBe(502);
    expect(res.body).toEqual({ raw: html.slice(0, SIMPLEFACT_RAW_MAX_CHARS) });
    expect((res.body as { raw: string }).raw).toHaveLength(SIMPLEFACT_RAW_MAX_CHARS);
    expect(classifySaleResponse(res.http, res.body, RUC_GF).status).toBe("en_duda");
  });

  it("un 200 que no es JSON (un portal cautivo) queda en duda, no emitido", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("<html>Inicia sesión</html>", { status: 200 }));
    const res = await simplefactCreateSale(conn(fetchImpl), payload());
    expect(res).toEqual({ http: 200, body: { raw: "<html>Inicia sesión</html>" } });
    expect(classifySaleResponse(res.http, res.body, RUC_GF).status).toBe("en_duda");
  });

  it("una respuesta enorme no se interpreta", async () => {
    const huge = "x".repeat(2_000_001);
    const { fetchImpl } = fakeFetch(() => new Response(huge, { status: 200 }));
    const res = await simplefactCreateSale(conn(fetchImpl), payload());
    expect(res.http).toBe(200);
    expect(res.body).toEqual({ raw: huge.slice(0, SIMPLEFACT_RAW_MAX_CHARS) });
    expect(res.error).toBe("La respuesta de SimpleFact es demasiado grande");
  });
});

describe("simplefactCreateSale: sin respuesta es en duda, y no se repite", () => {
  it("la red se cae: http null, un motivo corto, una sola llamada", async () => {
    const fetchImpl = vi.fn(async () => {
      throw networkError("ECONNRESET");
    }) as unknown as typeof fetch;
    const res = await simplefactCreateSale(conn(fetchImpl), payload());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ http: null, body: null, error: "No hubo respuesta de SimpleFact (ECONNRESET)" });
    expect(classifySaleResponse(res.http, res.body, RUC_GF)).toEqual({ status: "en_duda", error: "SimpleFact no respondió." });
  });

  it("un fetch que lanza de forma síncrona tampoco rompe la pasada", async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const res = await simplefactCreateSale(conn(fetchImpl), payload());
    expect(res).toEqual({ http: null, body: null, error: "No hubo respuesta de SimpleFact (boom)" });
  });

  it("tiempo agotado con un fetch que nunca contesta (ni escucha la señal): http null", async () => {
    const fetchImpl = neverFetch();
    const res = await simplefactCreateSale(conn(fetchImpl, { timeoutMs: 20 }), payload());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ http: null, body: null, error: "SimpleFact no respondió en 20 ms" });
  });

  it("tiempo agotado con un fetch que sí escucha la señal: se aborta", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
        }),
    ) as unknown as typeof fetch;
    const res = await simplefactCreateSale(conn(fetchImpl, { timeoutMs: 20 }), payload());
    expect(signal?.aborted).toBe(true);
    expect(res).toEqual({ http: null, body: null, error: "SimpleFact no respondió en 20 ms" });
  });

  it("crear espera 25 s por omisión", async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = simplefactCreateSale(conn(neverFetch()), payload()).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(SIMPLEFACT_POST_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(SIMPLEFACT_POST_TIMEOUT_MS).toBe(25_000);
    expect((await pending).error).toBe("SimpleFact no respondió en 25000 ms");
  });

  it("contestó el código pero el cuerpo no llegó: manda el código (un 2xx queda en duda)", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 201,
      text: () => Promise.reject(Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } })),
    })) as unknown as typeof fetch;
    const res = await simplefactCreateSale(conn(fetchImpl), payload());
    expect(res).toEqual({ http: 201, body: null, error: "SimpleFact cortó la respuesta (UND_ERR_SOCKET)" });
    expect(classifySaleResponse(res.http, res.body, RUC_GF).status).toBe("en_duda");
  });

  it("el cuerpo que nunca termina de llegar también corta por tiempo", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, text: () => new Promise<string>(() => undefined) })) as unknown as typeof fetch;
    const res = await simplefactCreateSale(conn(fetchImpl, { timeoutMs: 20 }), payload());
    expect(res).toEqual({ http: 200, body: null, error: "SimpleFact no terminó de responder en 20 ms" });
    expect(classifySaleResponse(res.http, res.body, RUC_GF).status).toBe("en_duda");
  });

  it("algo que no es una respuesta HTTP es no-respondió", async () => {
    const fetchImpl = vi.fn(async () => ({}) as Response) as unknown as typeof fetch;
    const res = await simplefactCreateSale(conn(fetchImpl), payload());
    expect(res).toEqual({ http: null, body: null, error: "SimpleFact no devolvió una respuesta HTTP" });
  });
});

// ── El token no sale ─────────────────────────────────────────────────────────

describe("el token no aparece en nada de lo que se devuelve", () => {
  /** El token con una barra: PHP la escapa como «\/» y el texto crudo no la trae literal. */
  const SLASH_TOKEN = "42|sf/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

  const leaks: Array<[string, string, (token: string) => typeof fetch]> = [
    [
      "un error de red que cita la cabecera",
      TOKEN,
      (token) =>
        vi.fn(async () => {
          throw new TypeError(`Headers.append: "Bearer ${token}" is an invalid header value.`);
        }) as unknown as typeof fetch,
    ],
    [
      "un error con la cabecera en `cause`",
      TOKEN,
      (token) =>
        vi.fn(async () => {
          throw Object.assign(new TypeError("fetch failed"), { cause: { message: `bad header Bearer ${token}` } });
        }) as unknown as typeof fetch,
    ],
    [
      "un JSON que repite la cabecera en un valor y en una llave",
      TOKEN,
      (token) =>
        fakeFetch(() =>
          json({ success: false, message: `Token ${token} inválido`, debug: { headers: { authorization: [`Bearer ${token}`] }, [token]: 1 } }, 401),
        ).fetchImpl,
    ],
    [
      "un JSON de PHP con la barra escapada",
      SLASH_TOKEN,
      (token) =>
        fakeFetch(
          () =>
            new Response(`{"message":"Bearer ${token.replace(/\//g, "\\/")} no existe"}`, {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }),
        ).fetchImpl,
    ],
    [
      "una página HTML que imprime las cabeceras",
      TOKEN,
      (token) =>
        fakeFetch(() => new Response(`<pre>Authorization: Bearer ${token}</pre>`, { status: 500 })).fetchImpl,
    ],
    [
      "un HTML largo con el token justo en el corte",
      TOKEN,
      (token) =>
        fakeFetch(
          () => new Response(`${"a".repeat(SIMPLEFACT_RAW_MAX_CHARS - 10)}${token}`, { status: 500 }),
        ).fetchImpl,
    ],
  ];

  for (const [name, token, make] of leaks) {
    it(`crear: ${name}`, async () => {
      const res = await simplefactCreateSale(conn(make(token), { token }), payload());
      const out = JSON.stringify(res);
      expect(out).not.toContain(token);
      // Tampoco un pedazo largo del token (el corte de 2000 no lo parte a medias).
      expect(out).not.toContain(token.slice(0, 10));
    });

    it(`listar: ${name}`, async () => {
      const res = await simplefactListSales(conn(make(token), { token }), { shortdate: "today" });
      const out = JSON.stringify(res);
      expect(out).not.toContain(token);
      expect(out).not.toContain(token.slice(0, 10));
    });

    it(`probar conexión: ${name}`, async () => {
      const res = await testSimplefactConnection(conn(make(token), { token }), RUC_GF);
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).not.toContain(token);
    });
  }

  it("el resto de la respuesta queda intacta", async () => {
    const { fetchImpl } = fakeFetch(() => json({ message: `Token ${TOKEN} inválido`, code: 401 }, 401));
    const res = await simplefactCreateSale(conn(fetchImpl), payload());
    expect(res).toEqual({ http: 401, body: { message: "Token [token] inválido", code: 401 } });
  });

  it("el módulo no escribe en la consola ni lee el entorno", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/invoicing/simplefact.ts"), "utf8");
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/process\.env/);
    // Solo importa las reglas puras: ni la base, ni el cifrado, ni `node:crypto`.
    const specifiers = [...src.matchAll(/(?:\bfrom|\bimport|require)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers).toEqual(["@/lib/invoicing/rules"]);
    // La dirección sale de rules.ts: un solo lugar decide adónde viaja el token.
    expect(src).toContain("simplefactBaseUrl(");
    expect(src).not.toMatch(/https:\/\/\$\{/);
  });
});

// ── Listar ventas ────────────────────────────────────────────────────────────

describe("simplefactListSales", () => {
  it("un GET con solo los filtros que se pasan, codificados", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(docList([])));
    await simplefactListSales(conn(fetchImpl), { shortdate: "today", pageSize: 50, page: 2 });
    await simplefactListSales(conn(fetchImpl), { shortdate: "yesterday" });
    await simplefactListSales(conn(fetchImpl), { page: 3 });
    await simplefactListSales(conn(fetchImpl), {});
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/sales/orders?shortdate=today&pageSize=50&page=2`,
      `${BASE}/sales/orders?shortdate=yesterday`,
      `${BASE}/sales/orders?page=3`,
      `${BASE}/sales/orders`,
    ]);
  });

  it("los filtros se codifican: un valor raro no inyecta otro parámetro", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(docList([])));
    await simplefactListSales(conn(fetchImpl), { shortdate: "today&pageSize=1000" as "today" });
    expect(calls[0]!.url).toBe(`${BASE}/sales/orders?shortdate=today%26pageSize%3D1000`);
    expect(new URL(calls[0]!.url).searchParams.get("pageSize")).toBeNull();
  });

  it("un número que no es entero positivo no se manda", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(docList([])));
    await simplefactListSales(conn(fetchImpl), { pageSize: 0, page: Number.NaN });
    await simplefactListSales(conn(fetchImpl), { pageSize: 1.5, page: -1 });
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/sales/orders`, `${BASE}/sales/orders`]);
  });

  it("GET con Bearer y Accept, sin cuerpo ni Content-Type, sin seguir redirecciones", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(docList([])));
    await simplefactListSales(conn(fetchImpl), { shortdate: "today" });
    const init = calls[0]!.init;
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, Accept: "application/json" });
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("manual");
    expect(calls[0]!.url).not.toContain(TOKEN);
  });

  it("lee el JSON de PHP con las barras escapadas", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(DOC_LIST_RAW, { status: 200 }));
    const res = await simplefactListSales(conn(fetchImpl), { shortdate: "today" });
    expect(res.http).toBe(200);
    expect(res.error).toBeUndefined();
    const sale = (res.body as { data: Array<{ xml_url: string }> }).data[0]!;
    expect(sale.xml_url).toBe("https://demo.simplefact.pe/app/download/invoices/20601643316-01-F001-141.xml");
  });

  it("leer espera 15 s por omisión", async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = simplefactListSales(conn(neverFetch()), { shortdate: "today" }).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(SIMPLEFACT_GET_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(SIMPLEFACT_GET_TIMEOUT_MS).toBe(15_000);
    expect(await pending).toEqual({ http: null, body: null, error: "SimpleFact no respondió en 15000 ms" });
  });

  it("timeoutMs manda sobre el de omisión", async () => {
    const res = await simplefactListSales(conn(neverFetch(), { timeoutMs: 15 }), {});
    expect(res).toEqual({ http: null, body: null, error: "SimpleFact no respondió en 15 ms" });
  });
});

// ── Probar conexión ──────────────────────────────────────────────────────────

describe("testSimplefactConnection: el token tiene que ser del RUC (§35.4)", () => {
  it(`lee ${SIMPLEFACT_TEST_PAGE_SIZE} ventas y confirma el RUC de sus archivos`, async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(docList([docListSale()])));
    const res = await testSimplefactConnection(conn(fetchImpl), RUC_DOC);
    expect(res).toEqual({ ok: true, ruc: RUC_DOC, sales: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/sales/orders?pageSize=20`);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("con el cuerpo crudo de la documentación (barras escapadas)", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(DOC_LIST_RAW, { status: 200 }));
    expect(await testSimplefactConnection(conn(fetchImpl), RUC_DOC)).toEqual({ ok: true, ruc: RUC_DOC, sales: 1 });
  });

  it("cuenta todas las ventas leídas, aunque solo algunas tengan archivos", async () => {
    const sinArchivos = docListSale({ xml_url: null, pdf_url: null, bill: null });
    const { fetchImpl } = fakeFetch(() => json(docList([docListSale(), sinArchivos, docListSale({ id: 410 })])));
    expect(await testSimplefactConnection(conn(fetchImpl), RUC_DOC)).toEqual({ ok: true, ruc: RUC_DOC, sales: 3 });
  });

  it("el token es de otro RUC: lo dice y devuelve el RUC leído", async () => {
    const { fetchImpl } = fakeFetch(() => json(docList([docListSale()])));
    expect(await testSimplefactConnection(conn(fetchImpl), RUC_GF)).toEqual({
      ok: false,
      error: `El token es del RUC ${RUC_DOC}, no del ${RUC_GF}`,
      ruc: RUC_DOC,
    });
  });

  it("ventas de dos RUC en la misma cuenta: no se adivina", async () => {
    const otra = docListSale({
      id: 500,
      xml_url: `https://demo.simplefact.pe/app/download/invoices/${RUC_GF}-03-B001-12.xml`,
      pdf_url: null,
      bill: null,
    });
    const { fetchImpl } = fakeFetch(() => json(docList([docListSale(), otra])));
    expect(await testSimplefactConnection(conn(fetchImpl), RUC_DOC)).toEqual({
      ok: false,
      error: "La cuenta tiene ventas de más de un RUC",
      ruc: null,
    });
  });

  it("sin ventas, o sin ventas con archivos, no se confirma el RUC", async () => {
    const vacias = [docList([]), docList([docListSale({ xml_url: null, pdf_url: null, bill: { status: "pending" } })])];
    for (const body of vacias) {
      const { fetchImpl } = fakeFetch(() => json(body));
      expect(await testSimplefactConnection(conn(fetchImpl), RUC_GF)).toEqual({
        ok: false,
        error: "La cuenta no tiene ventas con archivos: no se pudo confirmar el RUC",
        ruc: null,
      });
    }
  });

  it("SimpleFact no respondió", async () => {
    const caida = vi.fn(async () => {
      throw networkError("ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await testSimplefactConnection(conn(caida), RUC_GF)).toEqual({ ok: false, error: "SimpleFact no respondió", ruc: null });
    expect(await testSimplefactConnection(conn(neverFetch(), { timeoutMs: 15 }), RUC_GF)).toEqual({
      ok: false,
      error: "SimpleFact no respondió",
      ruc: null,
    });
  });

  it("401 y 403: token rechazado", async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = fakeFetch(() => json({ message: "Unauthenticated." }, status));
      expect(await testSimplefactConnection(conn(fetchImpl), RUC_GF)).toEqual({ ok: false, error: "Token rechazado", ruc: null });
    }
  });

  it("otro código: lo dice, incluida una redirección", async () => {
    for (const status of [302, 404, 429, 500, 503]) {
      const { fetchImpl } = fakeFetch(() => new Response("", { status }));
      expect(await testSimplefactConnection(conn(fetchImpl), RUC_GF)).toEqual({
        ok: false,
        error: `SimpleFact contestó ${status}`,
        ruc: null,
      });
    }
  });

  it("un 200 que no es la lista de ventas no es «la cuenta no tiene ventas»", async () => {
    for (const respond of [
      () => new Response("<html>Inicia sesión</html>", { status: 200 }),
      () => json({ success: true }),
      () => json([docListSale()]),
    ]) {
      const { fetchImpl } = fakeFetch(respond);
      expect(await testSimplefactConnection(conn(fetchImpl), RUC_GF)).toEqual({
        ok: false,
        error: "SimpleFact no devolvió la lista de ventas",
        ruc: null,
      });
    }
  });

  it("sin subdominio o sin token no sale a la red y dice por qué", async () => {
    const { fetchImpl } = fakeFetch(() => json(docList([docListSale()])));
    expect(await testSimplefactConnection(conn(fetchImpl, { subdomain: "evil.com" }), RUC_DOC)).toEqual({
      ok: false,
      error: "Subdominio de SimpleFact inválido",
      ruc: null,
    });
    expect(await testSimplefactConnection(conn(fetchImpl, { token: "" }), RUC_DOC)).toEqual({
      ok: false,
      error: "Falta el token de SimpleFact",
      ruc: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("el RUC esperado se compara sin espacios alrededor", async () => {
    const { fetchImpl } = fakeFetch(() => json(docList([docListSale()])));
    expect(await testSimplefactConnection(conn(fetchImpl), ` ${RUC_DOC} `)).toEqual({ ok: true, ruc: RUC_DOC, sales: 1 });
  });
});
