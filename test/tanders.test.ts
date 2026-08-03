import { describe, expect, it } from "vitest";
import {
  buildTandersPayload,
  composeTandersNote,
  tandersCoverageEligible,
  defaultCollectionAmount,
  suggestedDestination,
  tandersPhone,
} from "@/lib/tanders/draft";
import {
  extractLabelUrl,
  extractTokens,
  extractTrackingCode,
  jwtExpiry,
  TandersClient,
} from "@/lib/tanders/client";
import { TandersApiError } from "@/lib/tanders/types";
import { parseGeoLink } from "@/lib/geo-link";

const ORIGIN = {
  address: "Jr. Restauración 525, Breña 15083, Perú",
  lat: -12.0626834,
  lng: -77.0510333,
};

function draft(over: Partial<Parameters<typeof buildTandersPayload>[0]> = {}) {
  return buildTandersPayload({
    origin: ORIGIN,
    destination: "Ramiro Priale 392, Ate 15012, Perú",
    destinationLat: -12.054714,
    destinationLng: -76.956875,
    recipientName: "Mendoza Mendoza",
    recipientPhone: "51981535978",
    collectionAmount: 89,
    note: "Esquina con la av. Urubamba",
    ...over,
  });
}

describe("tandersPhone", () => {
  it("quita el 51 que agrega la normalización interna", () => {
    expect(tandersPhone("51981535978")).toBe("981535978");
  });

  it("acepta el celular local tal cual", () => {
    expect(tandersPhone("981535978")).toBe("981535978");
  });

  it("limpia separadores y el prefijo internacional", () => {
    expect(tandersPhone("+51 981 535 978")).toBe("981535978");
    expect(tandersPhone("0051981535978")).toBe("981535978");
  });

  it("rechaza fijos y números incompletos en vez de mandarlos mutilados", () => {
    expect(tandersPhone("013456789")).toBeNull();
    expect(tandersPhone("98153597")).toBeNull();
    expect(tandersPhone(null)).toBeNull();
  });
});

describe("tandersCoverageEligible", () => {
  const location = {
    storeId: "store-1",
    region: "Lima (provincia)",
    province: "Lima",
    district: "Pueblo Libre",
  };

  it("solo acepta la cobertura materializada Lima", () => {
    expect(tandersCoverageEligible({ ...location, coverage: "lima" })).toBe(true);
    expect(tandersCoverageEligible({ ...location, coverage: "provincia_cod" })).toBe(false);
    expect(tandersCoverageEligible({ ...location, coverage: "agencia" })).toBe(false);
  });

  it("usa la geografía únicamente para filas históricas sin cobertura", () => {
    expect(tandersCoverageEligible({ ...location, coverage: null })).toBe(true);
    expect(
      tandersCoverageEligible({
        ...location,
        coverage: null,
        province: "Cañete",
        district: "San Vicente de Cañete",
      }),
    ).toBe(false);
  });

  // Cañete no era la única: son NUEVE provincias del departamento de Lima, y el
  // nombre suele llegar en el campo del distrito (Shopify guarda "Lima
  // (provincia)" en región y provincia). Con la comprobación limitada a Cañete,
  // un pedido de Barranca con `coverage: "lima"` guardado pasaba el filtro y se
  // le ofrecía reparto de Lima para un destino a 200 km.
  it("bloquea las nueve provincias del departamento, con el nombre en el distrito", () => {
    for (const district of ["Barranca", "Huaura", "Huaral", "Yauyos", "Canta", "Oyón", "Cajatambo", "Huarochirí"]) {
      expect(
        tandersCoverageEligible({
          ...location,
          province: "Lima (provincia)",
          district,
          coverage: "lima",
        }),
      ).toBe(false);
    }
  });

  it("un distrito metropolitano de verdad sigue siendo elegible", () => {
    expect(
      tandersCoverageEligible({ ...location, district: "Barranco", coverage: "lima" }),
    ).toBe(true);
  });

  it("bloquea Cañete aunque una fila histórica todavía diga cobertura Lima", () => {
    expect(
      tandersCoverageEligible({
        ...location,
        coverage: "lima",
        province: "Cañete",
        district: "San Vicente de Cañete",
      }),
    ).toBe(false);
  });
});

describe("defaultCollectionAmount", () => {
  it("no vuelve a cobrar un pedido ya pagado por Yape", () => {
    expect(defaultCollectionAmount({ paymentState: "pago_completo", orderTotal: 89 })).toBe(0);
  });

  it("cobra el total cuando el pago sigue pendiente", () => {
    expect(defaultCollectionAmount({ paymentState: "adelanto_validado", orderTotal: 89 })).toBe(89);
    expect(defaultCollectionAmount({ paymentState: null, orderTotal: 120.5 })).toBe(120.5);
  });

  it("nunca devuelve negativo", () => {
    expect(defaultCollectionAmount({ paymentState: null, orderTotal: -5 })).toBe(0);
    expect(defaultCollectionAmount({ paymentState: null, orderTotal: null })).toBe(0);
  });
});

describe("buildTandersPayload", () => {
  it("reproduce el cuerpo exacto que acepta la API", () => {
    const res = draft();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload).toEqual({
      packageType: "XXS",
      weightGrams: 100,
      origin: "Jr. Restauración 525, Breña 15083, Perú",
      originLat: "-12.0626834",
      originLng: "-77.0510333",
      destination: "Ramiro Priale 392, Ate 15012, Perú",
      destinationLat: -12.054714,
      destinationLng: -76.956875,
      recipientFullName: "Mendoza Mendoza",
      recipientPhone: "981535978",
      note: "Esquina con la av. Urubamba",
      collectionAmount: 89,
    });
  });

  it("manda el origen como texto y el destino como número, como su frontend", () => {
    const res = draft();
    if (!res.ok) throw new Error("debería construir");
    expect(typeof res.payload.originLat).toBe("string");
    expect(typeof res.payload.destinationLat).toBe("number");
  });

  it("exige el punto del mapa: la dirección sola no alcanza", () => {
    const res = draft({ destinationLat: null, destinationLng: null });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(" ")).toContain("punto en el mapa");
  });

  it("trata 0/0 como coordenada ausente", () => {
    const res = draft({ destinationLat: 0, destinationLng: 0 });
    expect(res.ok).toBe(false);
  });

  it("junta todos los errores para no arreglarlos de a uno", () => {
    const res = draft({ recipientName: "  ", recipientPhone: "123", destinationLat: null });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("bloquea la guía si la tienda no configuró su origen", () => {
    const res = draft({ origin: { address: null, lat: null, lng: null } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(" ")).toContain("origen");
  });

  it("redondea el monto a dos decimales", () => {
    const res = draft({ collectionAmount: 89.999 });
    if (!res.ok) throw new Error("debería construir");
    expect(res.payload.collectionAmount).toBe(90);
  });

  it("acepta cobro cero (pedido ya pagado)", () => {
    const res = draft({ collectionAmount: 0 });
    expect(res.ok).toBe(true);
  });
});

describe("suggestedDestination", () => {
  it("arma la dirección buscable y omite lo que falta", () => {
    expect(
      suggestedDestination({ address: "Ramiro Priale 392", district: "Ate", region: "Lima" }),
    ).toBe("Ramiro Priale 392, Ate, Lima, Perú");
    expect(suggestedDestination({ address: null, district: "Ate", region: null })).toBe("Ate, Perú");
  });
});

describe("composeTandersNote", () => {
  it("manda la referencia Y la nota del pedido, en ese orden", () => {
    expect(
      composeTandersNote({
        reference: "Entre av.el bosque y av.santa rosa",
        shopifyNote: "https://maps.app.goo.gl/7qzEm3PQCMCb6w7j9",
      }),
    ).toBe("Entre av.el bosque y av.santa rosa\nhttps://maps.app.goo.gl/7qzEm3PQCMCb6w7j9");
  });

  it("funciona con una sola de las dos", () => {
    expect(composeTandersNote({ reference: "Portón azul", shopifyNote: null })).toBe("Portón azul");
    expect(composeTandersNote({ reference: null, shopifyNote: "Llamar antes" })).toBe("Llamar antes");
    expect(composeTandersNote({ reference: "  ", shopifyNote: "" })).toBe("");
  });

  it("no repite el mismo texto dos veces", () => {
    expect(
      composeTandersNote({ reference: "Llamar antes", shopifyNote: "  llamar  antes " }),
    ).toBe("Llamar antes");
  });

  it("omite la parte que ya está contenida en la otra", () => {
    expect(
      composeTandersNote({
        reference: "Portón azul",
        shopifyNote: "Portón azul, tocar el timbre dos veces",
      }),
    ).toBe("Portón azul, tocar el timbre dos veces");
  });
});

describe("parseGeoLink", () => {
  it("prefiere el pin del lugar (!3d!4d) sobre el centro de la cámara (@)", () => {
    const res = parseGeoLink(
      "https://www.google.com/maps/place/X/@-12.05,-76.95,17z/data=!3m1!4b1!4m5!3m4!1s0x0!8m2!3d-12.054714!4d-76.956875",
    );
    expect(res).toEqual({ ok: true, point: { lat: -12.054714, lng: -76.956875 } });
  });

  it("lee el enlace con solo @", () => {
    const res = parseGeoLink("https://www.google.com/maps/@-12.0626834,-77.0510333,17z");
    expect(res).toEqual({ ok: true, point: { lat: -12.0626834, lng: -77.0510333 } });
  });

  it("lee ?q= y query= (incluido el %2C de un enlace copiado)", () => {
    expect(parseGeoLink("https://maps.google.com/?q=-12.05,-76.95")).toEqual({
      ok: true,
      point: { lat: -12.05, lng: -76.95 },
    });
    expect(
      parseGeoLink("https://www.google.com/maps/search/?api=1&query=-12.05%2C-76.95"),
    ).toEqual({ ok: true, point: { lat: -12.05, lng: -76.95 } });
  });

  it("lee el par pegado a mano", () => {
    expect(parseGeoLink("-12.054714, -76.956875")).toEqual({
      ok: true,
      point: { lat: -12.054714, lng: -76.956875 },
    });
  });

  it("explica qué hacer con un enlace corto en vez de fallar en seco", () => {
    const res = parseGeoLink("https://maps.app.goo.gl/abc123");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("enlace largo");
  });

  it("rechaza texto sin coordenadas y el 0/0", () => {
    expect(parseGeoLink("Ramiro Priale 392, Ate").ok).toBe(false);
    expect(parseGeoLink("0, 0").ok).toBe(false);
    expect(parseGeoLink("").ok).toBe(false);
  });
});

describe("extractTokens", () => {
  // exp = iat + 900: el access token dura 15 minutos.
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    Buffer.from(JSON.stringify({ sub: "u1", exp: 1785120539 })).toString("base64url") +
    ".sig";

  it("acepta camelCase, snake_case y respuesta anidada en data", () => {
    expect(extractTokens({ accessToken: jwt }).accessToken).toBe(jwt);
    expect(extractTokens({ access_token: jwt }).accessToken).toBe(jwt);
    expect(extractTokens({ data: { accessToken: jwt } }).accessToken).toBe(jwt);
  });

  it("lee la expiración del propio JWT", () => {
    expect(extractTokens({ accessToken: jwt }).expiresAt).toBe(1785120539);
    expect(jwtExpiry("no-es-un-jwt")).toBeNull();
  });

  it("si no encuentra el token dice qué claves llegaron", () => {
    expect(() => extractTokens({ sessionKey: "x" })).toThrowError(/sessionKey/);
  });
});

describe("extractTrackingCode", () => {
  // Respuesta real de una guía creada el 27/07/2026.
  const real = {
    id: "cms3ov8db00080mxdbvigryzy",
    status: "PENDING",
    aliclikOrderNumber: "TANDER17851846826402032",
    aliclikSyncStatus: "SYNCED",
    labelGeneratedAt: null,
  };

  it("devuelve el N° de seguimiento, no el cuid interno", () => {
    expect(extractTrackingCode(real)).toBe("TANDER17851846826402032");
  });

  it("cae al cuid si la sincronización todavía no dio número", () => {
    expect(extractTrackingCode({ id: "cms3ov8db00080mxdbvigryzy" })).toBe(
      "cms3ov8db00080mxdbvigryzy",
    );
    expect(extractTrackingCode({ id: "abc", aliclikOrderNumber: "  " })).toBe("abc");
  });

  it("devuelve null cuando no hay ningún identificador utilizable", () => {
    expect(extractTrackingCode({ id: "" })).toBeNull();
    expect(extractTrackingCode(null)).toBeNull();
  });
});

describe("extractLabelUrl", () => {
  it("no inventa etiqueta en la respuesta real de creación", () => {
    // labelGeneratedAt viene null: el PDF se genera después de crear el pedido.
    expect(
      extractLabelUrl({ id: "x", status: "PENDING", labelGeneratedAt: null }),
    ).toBeNull();
  });

  it("encuentra el PDF bajo cualquiera de los nombres candidatos", () => {
    expect(extractLabelUrl({ id: "1", labelUrl: "https://x/a.pdf" })).toBe("https://x/a.pdf");
    expect(extractLabelUrl({ id: "1", pdf_url: "https://x/b.pdf" })).toBe("https://x/b.pdf");
  });

  it("devuelve null cuando la etiqueta todavía no existe", () => {
    expect(extractLabelUrl({ id: "1", status: "Pendiente" })).toBeNull();
    expect(extractLabelUrl({ id: "1", labelUrl: "pendiente" })).toBeNull();
    expect(extractLabelUrl(null)).toBeNull();
  });
});

describe("TandersClient", () => {
  const jwt = (exp: number) =>
    "h." + Buffer.from(JSON.stringify({ exp })).toString("base64url") + ".s";
  const future = () => Math.floor(Date.now() / 1000) + 900;

  function stub(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const { status, body } = handler(url, init);
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const payload = (() => {
    const r = draft();
    if (!r.ok) throw new Error("fixture inválida");
    return r.payload;
  })();

  it("hace login y manda el bearer al crear el pedido", async () => {
    const { calls, fetchImpl } = stub((url) =>
      url.endsWith("/auth/login")
        ? { status: 200, body: { accessToken: jwt(future()), refreshToken: "r" } }
        : { status: 201, body: { id: "cms2mftih00180mtjjbot9str", status: "Pendiente" } },
    );
    const client = new TandersClient({ email: "e@x.com", password: "p", fetchImpl });
    const order = await client.createOrder(payload);

    expect(order.id).toBe("cms2mftih00180mtjjbot9str");
    expect(calls[0]?.url).toContain("/auth/login");
    const created = calls[1];
    if (!created) throw new Error("no se llamó a /orders");
    expect(created.url).toContain("/orders");
    const headers = created.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Bearer /);
    expect(JSON.parse(created.init.body as string)).toEqual(payload);
  });

  it("reusa el token vigente en vez de loguearse otra vez", async () => {
    const { calls, fetchImpl } = stub((url) =>
      url.endsWith("/auth/login")
        ? { status: 200, body: { accessToken: jwt(future()) } }
        : { status: 201, body: { id: "a" } },
    );
    const client = new TandersClient({ email: "e@x.com", password: "p", fetchImpl });
    await client.createOrder(payload);
    await client.createOrder(payload);
    expect(calls.filter((c) => c.url.endsWith("/auth/login"))).toHaveLength(1);
  });

  it("vuelve a loguearse cuando el token de 15 minutos ya venció", async () => {
    const { calls, fetchImpl } = stub((url) =>
      url.endsWith("/auth/login")
        ? { status: 200, body: { accessToken: jwt(Math.floor(Date.now() / 1000) - 10) } }
        : { status: 201, body: { id: "a" } },
    );
    const client = new TandersClient({ email: "e@x.com", password: "p", fetchImpl });
    await client.createOrder(payload);
    await client.createOrder(payload);
    expect(calls.filter((c) => c.url.endsWith("/auth/login"))).toHaveLength(2);
  });

  it("reintenta UNA vez ante un 401 con token nuevo", async () => {
    let orderAttempts = 0;
    const { calls, fetchImpl } = stub((url) => {
      if (url.endsWith("/auth/login")) return { status: 200, body: { accessToken: jwt(future()) } };
      orderAttempts += 1;
      return orderAttempts === 1
        ? { status: 401, body: { message: "Unauthorized" } }
        : { status: 201, body: { id: "ok" } };
    });
    const client = new TandersClient({ email: "e@x.com", password: "p", fetchImpl });
    expect((await client.createOrder(payload)).id).toBe("ok");
    expect(calls.filter((c) => c.url.endsWith("/auth/login"))).toHaveLength(2);
  });

  it("NO reintenta un 500: la guía pudo haberse creado igual", async () => {
    let orderAttempts = 0;
    const { fetchImpl } = stub((url) => {
      if (url.endsWith("/auth/login")) return { status: 200, body: { accessToken: jwt(future()) } };
      orderAttempts += 1;
      return { status: 500, body: { message: "boom" } };
    });
    const client = new TandersClient({ email: "e@x.com", password: "p", fetchImpl });
    await expect(client.createOrder(payload)).rejects.toBeInstanceOf(TandersApiError);
    expect(orderAttempts).toBe(1);
  });

  it("propaga el status y el mensaje del error (saldo insuficiente, cupo, etc.)", async () => {
    const { fetchImpl } = stub((url) =>
      url.endsWith("/auth/login")
        ? { status: 200, body: { accessToken: jwt(future()) } }
        : { status: 402, body: { message: "Saldo insuficiente" } },
    );
    const client = new TandersClient({ email: "e@x.com", password: "p", fetchImpl });
    await expect(client.createOrder(payload)).rejects.toMatchObject({
      status: 402,
      message: "Saldo insuficiente",
    });
  });
});
