import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildShalomOrderPayload,
  documentError,
  generatePickupCode,
  isValidPickupCode,
  needsCustomDimensions,
  normalizeDocument,
  pickupCodeError,
  shalomPhone,
  splitReceiverName,
  suggestedAgencyQuery,
  shalomGuideIsCancelable,
  shalomSoftBlockers,
  shalomAirRoute,
  MIN_OVERRIDE_REASON,
} from "@/lib/shalom/draft";
import {
  describeShalomError,
  describeShalomProbeFailure,
  findCreatedOrder,
  sessionIsFresh,
  ShalomClient,
} from "@/lib/shalom/client";
import { ShalomApiError, ShalomTimeoutError } from "@/lib/shalom/types";
import { configurationBlocker, isConfigured } from "@/lib/shalom/session";
import { buildStoreUpdate } from "@/lib/store-settings";
import { PERMISSIONS, permissionsFor } from "@/lib/permissions";

function draft(over: Partial<Parameters<typeof buildShalomOrderPayload>[0]> = {}) {
  return buildShalomOrderPayload({
    originTerminalId: 404,
    destinyTerminalId: 7,
    productId: 3,
    documentType: "DNI",
    document: "87654321",
    name: "MARIA",
    lastName: "GOMEZ",
    surName: "TORRES",
    phone: "51998765432",
    pickupCode: "2415",
    ...over,
  });
}

/** Respuesta JSON de mentira, para no salir a la red en los tests. */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("shalomPhone", () => {
  it("quita el 51 que agrega la normalización interna y devuelve un número", () => {
    expect(shalomPhone("51981535978")).toBe(981535978);
  });

  it("acepta el celular local tal cual y limpia separadores", () => {
    expect(shalomPhone("981535978")).toBe(981535978);
    expect(shalomPhone("+51 981 535 978")).toBe(981535978);
    expect(shalomPhone("0051981535978")).toBe(981535978);
  });

  it("rechaza fijos y números incompletos en vez de mandarlos mutilados", () => {
    expect(shalomPhone("013456789")).toBeNull();
    expect(shalomPhone("98153597")).toBeNull();
    expect(shalomPhone(null)).toBeNull();
  });
});

describe("normalizeDocument", () => {
  it("exige la longitud exacta de cada tipo", () => {
    expect(normalizeDocument("DNI", "87654321")).toBe("87654321");
    expect(normalizeDocument("DNI", "8765432")).toBeNull();
    expect(normalizeDocument("RUC", "20123456789")).toBe("20123456789");
    expect(normalizeDocument("RUC", "2012345678")).toBeNull();
  });

  it("acepta el CE alfanumérico y lo normaliza a mayúsculas", () => {
    expect(normalizeDocument("CE", "ab12cd")).toBe("AB12CD");
    expect(normalizeDocument("CE", "ab1")).toBeNull();
  });

  it("explica el fallo en vez de devolver solo null", () => {
    expect(documentError("DNI", "")).toMatch(/falta/i);
    expect(documentError("DNI", "123")).toMatch(/8 dígitos/);
    expect(documentError("RUC", "123")).toMatch(/11 dígitos/);
    expect(documentError("DNI", "87654321")).toBeNull();
  });
});

describe("clave de recojo", () => {
  it("rechaza lo que Shalom rechaza: repetidas y consecutivas ascendentes", () => {
    expect(isValidPickupCode("1111")).toBe(false);
    expect(isValidPickupCode("9999")).toBe(false);
    expect(isValidPickupCode("1234")).toBe(false);
    expect(isValidPickupCode("6789")).toBe(false);
  });

  it("acepta una clave normal, y también la descendente que la documentación no prohíbe", () => {
    expect(isValidPickupCode("2415")).toBe(true);
    expect(isValidPickupCode("4321")).toBe(true);
    expect(isValidPickupCode("0142")).toBe(true);
  });

  it("exige exactamente 4 dígitos", () => {
    expect(isValidPickupCode("241")).toBe(false);
    expect(isValidPickupCode("24155")).toBe(false);
    expect(isValidPickupCode("24a5")).toBe(false);
    expect(isValidPickupCode(null)).toBe(false);
  });

  it("dice POR QUÉ no sirve, que es lo que el operador necesita", () => {
    expect(pickupCodeError("1111")).toMatch(/iguales/);
    expect(pickupCodeError("1234")).toMatch(/consecutiv/);
    expect(pickupCodeError("12")).toMatch(/4 dígitos/);
    expect(pickupCodeError("2415")).toBeNull();
  });

  it("genera siempre una clave válida, incluso rellenando ceros a la izquierda", () => {
    // rng → 0.0142 ⇒ "0142": el padStart es lo que evita mandar "142".
    expect(generatePickupCode(() => 0.0142)).toBe("0142");
    for (let i = 0; i < 200; i++) {
      expect(isValidPickupCode(generatePickupCode())).toBe(true);
    }
  });

  it("salta las escaleras al generar, incluso las descendentes que sí serían válidas", () => {
    const values = [0.4321, 0.2415];
    const rng = () => values.shift() ?? 0.5;
    expect(generatePickupCode(rng)).toBe("2415");
  });
});

describe("splitReceiverName", () => {
  it("toma los dos últimos tokens como apellidos, que es la convención peruana", () => {
    expect(splitReceiverName("MARIA GOMEZ TORRES")).toEqual({
      name: "MARIA",
      last_name: "GOMEZ",
      sur_name: "TORRES",
    });
  });

  it("con nombre compuesto, el nombre se queda con lo que sobra", () => {
    expect(splitReceiverName("MARIA DEL PILAR GOMEZ TORRES")).toEqual({
      name: "MARIA DEL PILAR",
      last_name: "GOMEZ",
      sur_name: "TORRES",
    });
  });

  it("no inventa apellidos cuando no los hay", () => {
    expect(splitReceiverName("MARIA")).toEqual({ name: "MARIA", last_name: "", sur_name: "" });
    expect(splitReceiverName("MARIA GOMEZ")).toEqual({
      name: "MARIA",
      last_name: "GOMEZ",
      sur_name: "",
    });
    expect(splitReceiverName(null)).toEqual({ name: "", last_name: "", sur_name: "" });
  });
});

describe("suggestedAgencyQuery", () => {
  it("prefiere la agencia que ya venía en el pedido sobre la ubicación", () => {
    expect(
      suggestedAgencyQuery({ agency_branch: "AV PARRA 379", district: "AREQUIPA", region: "AREQUIPA" }),
    ).toBe("AV PARRA 379");
  });

  it("baja a lo más específico disponible cuando no hay agencia", () => {
    expect(suggestedAgencyQuery({ district: "ATE", province: "LIMA", region: "LIMA" })).toBe("ATE");
    expect(suggestedAgencyQuery({ district: null, province: null, region: "CUSCO" })).toBe("CUSCO");
    expect(suggestedAgencyQuery({})).toBe("");
  });
});

describe("buildShalomOrderPayload", () => {
  it("arma el cuerpo con la forma que documenta la API", () => {
    const res = draft();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload).toMatchObject({
      origin_terminal_id: 404,
      destiny_terminal_id: 7,
      product_id: 3,
      quantity: 1,
      payer: "sender",
      declaracion_jurada: "ropa",
      pickup_code: "2415",
    });
    expect(res.payload.receiver).toEqual({
      document_type: "DNI",
      document: "87654321",
      name: "MARIA",
      last_name: "GOMEZ",
      sur_name: "TORRES",
      phone: 998765432,
    });
  });

  it("no manda apellidos con RUC: no aplican a una empresa", () => {
    const res = draft({
      documentType: "RUC",
      document: "20123456789",
      name: "MI EMPRESA S.A.C.",
      lastName: "IGNORADO",
      surName: "IGNORADO",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.receiver.last_name).toBeUndefined();
    expect(res.payload.receiver.sur_name).toBeUndefined();
    expect(res.payload.receiver.name).toBe("MI EMPRESA S.A.C.");
  });

  it("exige el primer apellido para DNI, porque Shalom lo pide al registrar", () => {
    const res = draft({ lastName: "" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(" ")).toMatch(/apellido/i);
  });

  it("devuelve TODOS los errores juntos, no el primero", () => {
    const res = draft({ document: "1", phone: "123", pickupCode: "1111", destinyTerminalId: null });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.length).toBeGreaterThanOrEqual(4);
    expect(res.errors.join(" ")).toMatch(/DNI/);
    expect(res.errors.join(" ")).toMatch(/teléfono/i);
    expect(res.errors.join(" ")).toMatch(/iguales/);
    expect(res.errors.join(" ")).toMatch(/agencia de destino/i);
  });

  it("no deja despachar de una agencia a sí misma", () => {
    const res = draft({ destinyTerminalId: 404 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(" ")).toMatch(/misma agencia/i);
  });

  it("pide la agencia de origen cuando la tienda no la configuró", () => {
    const res = draft({ originTerminalId: null });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(" ")).toMatch(/Ajustes/);
  });

  it("incluye el person_id cuando se conoce, para evitar la búsqueda", () => {
    const res = draft({ personId: 1234567 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.receiver.id).toBe(1234567);
  });

  it("solo agrega dimensions y aereo cuando se piden", () => {
    const plain = draft();
    expect(plain.ok && plain.payload.dimensions).toBeUndefined();
    expect(plain.ok && plain.payload.aereo).toBeUndefined();

    const custom = draft({
      aereo: true,
      dimensions: { weight_kg: 2.5, height_m: 0.3, length_m: 0.4, width_m: 0.2 },
    });
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    expect(custom.payload.aereo).toBe(true);
    expect(custom.payload.dimensions?.weight_kg).toBe(2.5);
  });
});

describe("needsCustomDimensions", () => {
  it("solo pide medidas para «Otra Medida»", () => {
    expect(needsCustomDimensions("Otra Medida")).toBe(true);
    expect(needsCustomDimensions("otra medida")).toBe(true);
    expect(needsCustomDimensions("Sobre")).toBe(false);
    expect(needsCustomDimensions(null)).toBe(false);
  });
});

describe("sessionIsFresh", () => {
  it("acepta un token con vida por delante y rechaza el vencido", () => {
    expect(sessionIsFresh(new Date(Date.now() + 3_600_000).toISOString())).toBe(true);
    expect(sessionIsFresh(new Date(Date.now() - 1_000).toISOString())).toBe(false);
    expect(sessionIsFresh(null)).toBe(false);
    expect(sessionIsFresh("no es una fecha")).toBe(false);
  });

  it("descarta el que vence dentro del margen: no llegaría vivo al otro lado", () => {
    expect(sessionIsFresh(new Date(Date.now() + 30_000).toISOString())).toBe(false);
  });
});

describe("findCreatedOrder", () => {
  const orders = [
    { id: 1, guia: "111", pickup_code: "2415", receiver: { document: "87654321" } },
    { id: 2, guia: "222", pickup_code: "9182", receiver: { document: "87654321" } },
    { id: 3, guia: "333", pickup_code: "2415", receiver: { document: "12345678" } },
  ];

  it("encuentra la guía por documento + clave, que juntos sí identifican", () => {
    const hit = findCreatedOrder(orders, { document: "87654321", pickupCode: "2415" });
    expect(hit?.guia).toBe("111");
  });

  it("devuelve null si no está: mejor que el operador verifique a mano", () => {
    expect(findCreatedOrder(orders, { document: "99999999", pickupCode: "2415" })).toBeNull();
  });

  it("ante dos coincidencias no adopta ninguna: adoptar la equivocada es peor", () => {
    const ambiguous = [...orders, { id: 4, guia: "444", pickup_code: "2415", receiver: { document: "87654321" } }];
    expect(findCreatedOrder(ambiguous, { document: "87654321", pickupCode: "2415" })).toBeNull();
  });
});

describe("describeShalomProbeFailure", () => {
  const base = "https://api.shalom-api-peru.com";

  // Esto pasó en producción: SHALOM_API_BASE apuntaba mal, Shalom devolvió 404 y
  // el panel dijo «la API key del wrapper no funciona». Se fue a pedir una key
  // nueva al proveedor cuando la key estaba perfecta.
  it("ante un 404 culpa a la URL base y NO a la API key", () => {
    const msg = describeShalomProbeFailure(new ShalomApiError("404 page not found", 404), base);
    expect(msg).toMatch(/URL base/i);
    expect(msg).toMatch(/SHALOM_API_BASE/);
    expect(msg).not.toMatch(/API key.*(no funciona|rechazada)/i);
  });

  it("incluye la URL que intentó, que es lo que hace obvio el /v1 de más", () => {
    const msg = describeShalomProbeFailure(
      new ShalomApiError("404 page not found", 404),
      "https://api.shalom-api-peru.com/v1",
    );
    expect(msg).toContain("https://api.shalom-api-peru.com/v1/v1/agencies/search");
  });

  it("un 401 sí es de la key, y lo dice", () => {
    const msg = describeShalomProbeFailure(
      new ShalomApiError("key vencida", 401, "unauthorized"),
      base,
    );
    expect(msg).toMatch(/API key.*rechazada/i);
    expect(msg).not.toMatch(/SHALOM_API_BASE/);
  });

  it("cualquier otro fallo nombra la base sin acusar a nadie", () => {
    const msg = describeShalomProbeFailure(new ShalomTimeoutError("sin respuesta"), base);
    expect(msg).toContain(base);
    expect(msg).toMatch(/sin respuesta/);
  });
});

describe("describeShalomError", () => {
  it("traduce cada código a algo que el operador pueda hacer", () => {
    expect(describeShalomError(new ShalomApiError("token vencido", 401, "shalom_auth_failed"))).toMatch(
      /volver a conectar|Vuelve a conectar/i,
    );
    // El `unauthorized` es de la key global, que vive en el entorno. Decía
    // «Ajustes → Tienda», donde esa key no está ni puede estar.
    const globalKey = describeShalomError(new ShalomApiError("key mala", 401, "unauthorized"));
    expect(globalKey).toMatch(/SHALOM_API_KEY/);
    expect(globalKey).not.toMatch(/Ajustes → Tienda/);
    expect(describeShalomError(new ShalomApiError("regla", 422, "upstream_rejected"))).toMatch(
      /regla de negocio/i,
    );
    expect(describeShalomError(new ShalomApiError("mucho", 429, "rate_limited"))).toMatch(/60 llamadas/);
  });

  it("un corte se cuenta como corte, no como rechazo", () => {
    expect(describeShalomError(new ShalomTimeoutError("No hubo respuesta de Shalom (abort)."))).toMatch(
      /No hubo respuesta/,
    );
  });
});

describe("ShalomClient", () => {
  it("manda la API key siempre y la sesión solo donde hace falta", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return jsonResponse({ items: [], products: [] });
    }) as unknown as typeof fetch;

    const client = new ShalomClient({ apiKey: "sk_test", sessionToken: "ssk_abc", fetchImpl });
    await client.searchAgencies({ q: "arequipa" });
    await client.products();

    // Agencias: solo API key — así el modal puede buscar antes de conectar.
    expect(calls[0]?.headers["X-API-Key"]).toBe("sk_test");
    expect(calls[0]?.headers["X-Shalom-Session"]).toBeUndefined();
    // Productos: tocan la cuenta del cliente, van con el token.
    expect(calls[1]?.headers["X-Shalom-Session"]).toBe("ssk_abc");
  });

  it("prefiere el token sobre email/password cuando están los dos", async () => {
    const calls: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse({ products: [] });
    }) as unknown as typeof fetch;

    await new ShalomClient({
      apiKey: "sk_test",
      sessionToken: "ssk_abc",
      email: "a@b.c",
      password: "secreto",
      fetchImpl,
    }).products();

    expect(calls[0]?.["X-Shalom-Session"]).toBe("ssk_abc");
    expect(calls[0]?.["X-Shalom-Password"]).toBeUndefined();
  });

  it("sin ninguna credencial de Shalom falla antes de salir a la red", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(new ShalomClient({ apiKey: "sk_test", fetchImpl }).products()).rejects.toThrow(
      /sesión de Shalom/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lee el envelope de error y conserva el request_id para poder reclamar", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: "upstream_rejected", message: "cuenta sin cobranza", request_id: "01KQ" } },
        422,
      ),
    ) as unknown as typeof fetch;

    const client = new ShalomClient({ apiKey: "sk_test", sessionToken: "ssk_abc", fetchImpl });
    await expect(client.products()).rejects.toMatchObject({
      status: 422,
      code: "upstream_rejected",
    });
    await expect(client.products()).rejects.toThrow(/01KQ/);
  });

  it("un 404 en la búsqueda de persona es «no existe», no un fallo", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "not_found", message: "no registrada" } }, 404),
    ) as unknown as typeof fetch;

    const client = new ShalomClient({ apiKey: "sk_test", sessionToken: "ssk_abc", fetchImpl });
    await expect(client.findPerson("70123456", "DNI")).resolves.toBeNull();
  });

  it("un corte al crear la orden sale como ShalomTimeoutError, para ir a verificar", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    }) as unknown as typeof fetch;

    const client = new ShalomClient({ apiKey: "sk_test", sessionToken: "ssk_abc", fetchImpl });
    await expect(
      client.createOrder({
        origin_terminal_id: 404,
        destiny_terminal_id: 7,
        product_id: 3,
        quantity: 1,
        payer: "sender",
        declaracion_jurada: "docs",
        receiver: { document_type: "DNI", document: "87654321" },
        pickup_code: "2415",
      }),
    ).rejects.toBeInstanceOf(ShalomTimeoutError);
  });

  it("NO reintenta la creación de la orden: un segundo POST sería una segunda guía", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "shalom_auth_failed", message: "token vencido" } }, 401),
    ) as unknown as typeof fetch;

    const client = new ShalomClient({ apiKey: "sk_test", sessionToken: "ssk_abc", fetchImpl });
    await expect(
      client.createOrder({
        origin_terminal_id: 404,
        destiny_terminal_id: 7,
        product_id: 3,
        quantity: 1,
        payer: "sender",
        declaracion_jurada: "docs",
        receiver: { document_type: "DNI", document: "87654321" },
        pickup_code: "2415",
      }),
    ).rejects.toBeInstanceOf(ShalomApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("lista las órdenes SIEMPRE paginadas: sin per_page una cuenta grande son megabytes", async () => {
    let seen = "";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen = String(url);
      return jsonResponse({ orders: [] });
    }) as unknown as typeof fetch;

    await new ShalomClient({ apiKey: "sk_test", sessionToken: "ssk_abc", fetchImpl }).recentOrders(50);
    expect(seen).toContain("per_page=50");
  });

  it("expone el cupo del rate limit que viene en cualquier respuesta", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ items: [] }, 200, { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "55" }),
    ) as unknown as typeof fetch;

    const client = new ShalomClient({ apiKey: "sk_test", fetchImpl });
    await client.searchAgencies({ q: "lima" });
    expect(client.rateLimit).toMatchObject({ limit: 60, remaining: 55 });
  });
});

describe("ajustes de tienda — Shalom", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");

  it("cifra la contraseña y guarda el resto en claro", () => {
    const patch = buildStoreUpdate(
      {
        shalom_pro_email: "cliente@empresa.com",
        shalom_pro_password: "secreto",
        shalom_origin_terminal_id: "404",
        shalom_default_product_id: "3",
      },
      KEY,
    );
    expect(patch.shalom_pro_password_enc).toMatch(/^v1:/);
    expect(JSON.stringify(patch)).not.toContain("secreto");
    expect(patch.shalom_pro_email).toBe("cliente@empresa.com");
    expect(patch.shalom_origin_terminal_id).toBe(404);
    expect(patch.shalom_default_product_id).toBe(3);
  });

  it("la API key del wrapper NO se guarda por tienda: es global (SHALOM_API_KEY)", () => {
    const patch = buildStoreUpdate(
      { shalom_pro_email: "cliente@empresa.com" } as Record<string, string>,
      KEY,
    );
    expect(patch).not.toHaveProperty("shalom_api_key_enc");
  });

  it("cambiar de email invalida el token cacheado en vez de esperar al 401", () => {
    const patch = buildStoreUpdate({ shalom_pro_email: "otro@empresa.com" }, KEY, {
      shalom_pro_email: "cliente@empresa.com",
    });
    expect(patch.shalom_session_token_enc).toBeNull();
    expect(patch.shalom_session_expires_at).toBeNull();
  });

  it("cambiar la contraseña también la invalida, aunque el email siga igual", () => {
    const patch = buildStoreUpdate(
      { shalom_pro_email: "cliente@empresa.com", shalom_pro_password: "nueva" },
      KEY,
      { shalom_pro_email: "cliente@empresa.com" },
    );
    expect(patch.shalom_session_token_enc).toBeNull();
  });

  it("REENVIAR el mismo email no tira la sesión: si no, cada guardado costaría 90 s", () => {
    // El formulario manda el email relleno en cada guardado. Sin comparar contra
    // el valor actual, tocar cualquier ajuste de la tienda obligaría a reconectar.
    const patch = buildStoreUpdate({ shalom_pro_email: "cliente@empresa.com" }, KEY, {
      shalom_pro_email: "cliente@empresa.com",
    });
    expect(patch.shalom_pro_email).toBe("cliente@empresa.com");
    expect(patch).not.toHaveProperty("shalom_session_token_enc");
  });

  it("no toca la sesión cuando solo se cambia la agencia de origen", () => {
    const patch = buildStoreUpdate({ shalom_origin_terminal_id: "66" }, KEY);
    expect(patch).not.toHaveProperty("shalom_session_token_enc");
  });

  it("configurar el email por primera vez cuenta como cambio", () => {
    const patch = buildStoreUpdate({ shalom_pro_email: "cliente@empresa.com" }, KEY, {
      shalom_pro_email: null,
    });
    expect(patch.shalom_session_token_enc).toBeNull();
  });

  it("ignora ids que no son enteros positivos en vez de guardar basura", () => {
    const patch = buildStoreUpdate(
      { shalom_origin_terminal_id: "0", shalom_default_product_id: "abc" },
      KEY,
    );
    expect(patch).not.toHaveProperty("shalom_origin_terminal_id");
    expect(patch).not.toHaveProperty("shalom_default_product_id");
  });

  it("un secreto en blanco no borra el guardado", () => {
    const patch = buildStoreUpdate({ shalom_pro_password: "" }, KEY);
    expect(patch).not.toHaveProperty("shalom_pro_password_enc");
  });
});

describe("configurationBlocker — a quién manda a arreglar el problema", () => {
  const account = {
    org_id: "org-1",
    shalom_pro_email: "cliente@empresa.com",
    shalom_pro_password_enc: "v1:xxx",
    shalom_origin_terminal_id: 404,
    shalom_origin_terminal_name: "SALAS ICA",
    shalom_default_product_id: 3,
    shalom_session_token_enc: null,
    shalom_session_expires_at: null,
  };

  afterEach(() => vi.unstubAllEnvs());

  it("sin SHALOM_API_KEY culpa al servidor, no a la tienda", () => {
    vi.stubEnv("SHALOM_API_KEY", "");
    const msg = configurationBlocker(account);
    expect(msg).toMatch(/SHALOM_API_KEY/);
    expect(msg).toMatch(/global/i);
    expect(isConfigured(account)).toBe(false);
  });

  it("con la key puesta, señala lo que le falta a la tienda", () => {
    vi.stubEnv("SHALOM_API_KEY", "sk_test");
    expect(configurationBlocker({ ...account, shalom_pro_email: null })).toMatch(/cuenta de Shalom Pro/);
    expect(configurationBlocker({ ...account, shalom_origin_terminal_id: null })).toMatch(
      /agencia de origen/,
    );
  });

  it("con las dos mitades no bloquea nada", () => {
    vi.stubEnv("SHALOM_API_KEY", "sk_test");
    expect(configurationBlocker(account)).toBeNull();
    expect(isConfigured(account)).toBe(true);
  });

  it("una tienda inexistente no revienta", () => {
    vi.stubEnv("SHALOM_API_KEY", "sk_test");
    expect(configurationBlocker(null)).toMatch(/cuenta de Shalom Pro/);
    expect(isConfigured(null)).toBe(false);
  });
});

describe("permiso shalom.create_guide", () => {
  it("existe y lo tienen los roles que despachan", () => {
    expect(PERMISSIONS).toContain("shalom.create_guide");
    expect(permissionsFor(["vendedora"]).has("shalom.create_guide")).toBe(true);
    expect(permissionsFor(["admin"]).has("shalom.create_guide")).toBe(true);
  });

  it("crear la guía NO da acceso a la clave de recojo", () => {
    const vendedora = permissionsFor(["vendedora"]);
    expect(vendedora.has("shalom.create_guide")).toBe(true);
    expect(vendedora.has("shalom.view_pickup_key")).toBe(false);
    expect(vendedora.has("shalom.reveal_pickup_key")).toBe(true);
  });

  it("un viewer no crea guías", () => {
    expect(permissionsFor(["viewer"]).has("shalom.create_guide")).toBe(false);
  });
});

describe("shalomGuideIsCancelable", () => {
  const base = {
    courier: "shalom",
    delivery_status: "pendiente",
    pickup_state: "pendiente_de_envio" as string | null,
    shalom_order_id: 12345 as number | null,
  };

  it("deja anular mientras el paquete siga pendiente de envío", () => {
    expect(shalomGuideIsCancelable(base)).toBe(true);
    expect(shalomGuideIsCancelable({ ...base, pickup_state: null })).toBe(true);
  });

  // Este es el límite que pidió la operación: en cuanto Shalom tiene el paquete
  // físicamente, borrar la orden por API deja de ser posible y de tener sentido.
  it("bloquea en cuanto el paquete llegó a la agencia", () => {
    for (const estado of [
      "enviado_a_agencia",
      "registrado_en_agencia",
      "en_transito",
      "disponible_para_recojo",
      "pendiente_de_recojo",
    ]) {
      expect(shalomGuideIsCancelable({ ...base, pickup_state: estado })).toBe(false);
    }
  });

  it("bloquea si la guía ya no está pendiente", () => {
    expect(shalomGuideIsCancelable({ ...base, delivery_status: "en_ruta" })).toBe(false);
    expect(shalomGuideIsCancelable({ ...base, delivery_status: "entregado" })).toBe(false);
    expect(shalomGuideIsCancelable({ ...base, delivery_status: "anulado" })).toBe(false);
  });

  // Sin `shalom_order_id` la guía llegó por el reporte Excel: nació en el panel
  // de Shalom y su vida la gobierna ese panel, no nosotros.
  it("bloquea las guías que no se crearon por API", () => {
    expect(shalomGuideIsCancelable({ ...base, shalom_order_id: null })).toBe(false);
  });

  it("no toca guías de otro courier", () => {
    expect(shalomGuideIsCancelable({ ...base, courier: "aliclik" })).toBe(false);
  });
});

describe("shalomSoftBlockers", () => {
  // El envío por Shalom se cobra con adelanto: sin comprobante no debería salir
  // el paquete. Pero se frena BLANDO, no duro — el caso legítimo raro (pagó
  // completo de una, el adelanto entró por otro canal) existe, y un muro deja a
  // la operadora parada el mismo día. El motivo escrito corta el descuido sin
  // cortar la excepción.
  it("frena cuando no hay ningún comprobante cargado", () => {
    const soft = shalomSoftBlockers("sin_pago");
    expect(soft).toHaveLength(1);
    expect(soft[0]).toMatch(/adelanto/i);
  });

  it("no frena en cuanto hay algo cargado, aunque falte validarlo", () => {
    // Cargado-sin-validar es un trámite pendiente, no un despacho sin cobro:
    // frenar acá castigaría a quien SÍ hizo su parte.
    for (const estado of [
      "adelanto_cargado",
      "adelanto_validado",
      "diferencia_cargada",
      "pago_completo",
      "posible_duplicado",
    ]) {
      expect(shalomSoftBlockers(estado)).toHaveLength(0);
    }
  });

  it("no frena si el estado de pago no se conoce", () => {
    // Un pedido sin estado calculado no es un pedido sin cobro. Ante la duda no
    // se estorba: el aviso ya está, y el freno se reserva para la certeza.
    expect(shalomSoftBlockers(null)).toHaveLength(0);
  });

  it("el mínimo del motivo descarta un «ok» pero admite una frase", () => {
    expect("ok".length).toBeLessThan(MIN_OVERRIDE_REASON);
    expect("pagó por transferencia".length).toBeGreaterThanOrEqual(MIN_OVERRIDE_REASON);
  });
});

describe("shalomAirRoute", () => {
  // `aereo: true` dice que la AGENCIA tiene servicio aéreo, no que lo tenga
  // desde donde despachamos. Quien manda es `origenes_aereos`: la lista de
  // agencias de origen con vuelo hasta ella. Ofrecer la casilla sin mirarla
  // sería invitar a marcar algo que la API rechaza — o a que el paquete salga
  // por una vía que no existe.
  const iquitos = { aereo: true, origenes_aereos: [584, 586, 587, 588, 591] };

  it("no ofrece nada si la agencia no tiene servicio aéreo", () => {
    expect(shalomAirRoute({ aereo: false }, 587)).toEqual({ offered: false });
    expect(shalomAirRoute({ aereo: null }, 587)).toEqual({ offered: false });
    expect(shalomAirRoute(null, 587)).toEqual({ offered: false });
  });

  it("confirma la ruta cuando nuestro origen está en la lista", () => {
    expect(shalomAirRoute(iquitos, 587)).toEqual({ offered: true, fromOrigin: "yes" });
  });

  it("avisa cuando la agencia vuela, pero no desde nuestro origen", () => {
    expect(shalomAirRoute(iquitos, 999)).toEqual({ offered: true, fromOrigin: "no" });
  });

  // Que falte el dato no es un error: la búsqueda de agencias no siempre
  // devuelve esas listas. Impedir el envío por falta de dato sería bloquear algo
  // legítimo con una excusa, así que se deja elegir y no se afirma nada.
  it("no afirma nada si falta la lista o el origen", () => {
    expect(shalomAirRoute({ aereo: true }, 587)).toEqual({ offered: true, fromOrigin: "unknown" });
    expect(shalomAirRoute({ aereo: true, origenes_aereos: [] }, 587)).toEqual({
      offered: true,
      fromOrigin: "unknown",
    });
    expect(shalomAirRoute(iquitos, null)).toEqual({ offered: true, fromOrigin: "unknown" });
  });
});

