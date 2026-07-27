import { describe, it, expect } from "vitest";
import {
  quote,
  createGuide,
  getGuide,
  requestPickup,
  cancelGuides,
  mapSwaypState,
  isSwaypAuthError,
  trackingUrl,
  SwaypError,
  type SwaypClientOpts,
  type SwaypCreateGuideInput,
} from "@/lib/swayp";

const BASE = "https://swayp.test/api";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fake fetch that records calls and replays a queue of canned responses. */
function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const next = responses.shift() ?? { body: {} };
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function opts(fetchImpl: typeof fetch): SwaypClientOpts {
  return { token: "tok", email: "gaby@kenku.pe", baseUrl: BASE, fetchImpl };
}

const GUIDE: SwaypCreateGuideInput = {
  nombreRemitente: "Kenku",
  nitRemitente: "00000000",
  direccionRemitente: "Av. Ejercito 123",
  telefonoRemitente: "959000000",
  telefonoRecogida: "959000000",
  emailRemitente: "gaby@kenku.pe",
  ciudadRemitente: "040101",
  nombreDestinatario: "Juan Perez",
  nitDestinatario: "00000000",
  direccionDestinatario: "Calle Misti 100",
  telefonoDestinatario: "959000001",
  emailDestinatario: "gaby@kenku.pe",
  ciudadDestinatario: "040126",
  contenido: "2 x Capsulas",
  peso: "1",
  largo: "15",
  alto: "15",
  ancho: "15",
  valorDeclarado: "129",
  valorRecaudo: "129",
};

describe("auth headers", () => {
  it("sends Bearer + email + x-country=PE (their default is CO)", async () => {
    const { impl, calls } = fakeFetch([{ body: { valorFlete: 12 } }]);
    await quote(opts(impl), {
      ciudadRemitente: "040101",
      direccionRemitente: "Av. Ejercito 123",
      ciudadDestinatario: "040126",
      direccionDestinatario: "Calle Misti 100",
      peso: "1",
      largo: "15",
      alto: "15",
      ancho: "15",
      valorDeclarado: "129",
      valorRecaudo: "129",
    });
    expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
    expect(calls[0]?.headers.email).toBe("gaby@kenku.pe");
    expect(calls[0]?.headers["x-country"]).toBe("PE");
    expect(calls[0]?.url).toBe(`${BASE}/v2/guias/quotation`);
  });
});

describe("createGuide", () => {
  it("unwraps the documented {success, data} shape", async () => {
    const { impl, calls } = fakeFetch([
      { status: 201, body: { success: true, data: { guia: 10000022753, estado: "Generada", idEstado: 1 } } },
    ]);
    const r = await createGuide(opts(impl), GUIDE);
    expect(r.guia).toBe(10000022753);
    expect(r.idEstado).toBe(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/v2/guias`);
  });

  it("also reads the FLAT shape the server actually returns", async () => {
    // Real response, captured from staging: no {success,data} wrapper, the
    // guide object comes at the top level and idEstado is a string. Misreading
    // this made a successful creation look like a failure — and the fallback
    // would then create a second guide and a second package.
    const { impl } = fakeFetch([
      {
        status: 200,
        body: {
          guia: 50000002618,
          guide: 50000002618,
          idRemitente: "348",
          estado: "Generada",
          idEstado: "1",
        },
      },
    ]);
    const r = await createGuide(opts(impl), GUIDE);
    expect(r.guia).toBe(50000002618);
    expect(r.idEstado).toBe(1);
    expect(r.estado).toBe("Generada");
  });

  it("NEVER retries — a repeated create would duplicate the package", async () => {
    const { impl, calls } = fakeFetch([
      { status: 500, body: { error: "Error en manejo de inventario" } },
      { status: 201, body: { success: true, data: { guia: 1, estado: "Generada", idEstado: 1 } } },
    ]);
    await expect(createGuide(opts(impl), GUIDE)).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(1);
  });

  it("throws when the API answers 200 without a guide number", async () => {
    const { impl } = fakeFetch([{ body: { success: false, error: "Error en manejo de inventario" } }]);
    await expect(createGuide(opts(impl), GUIDE)).rejects.toThrow(/inventario/);
  });
});

describe("getGuide", () => {
  it("maps the 200-with-empty-object answer to null", async () => {
    const { impl } = fakeFetch([{ body: {} }]);
    expect(await getGuide(opts(impl), 999)).toBeNull();
  });

  it("returns the guide when it exists", async () => {
    const { impl, calls } = fakeFetch([{ body: { guia: 10000022753, idEstado: 5 } }]);
    const g = await getGuide(opts(impl), 10000022753);
    expect(g?.idEstado).toBe(5);
    expect(calls[0]?.url).toBe(`${BASE}/v2/guias/10000022753`);
  });

  it("retries once on 5xx (reads are safe to repeat)", async () => {
    const { impl, calls } = fakeFetch([
      { status: 503, body: { error: "upstream" } },
      { body: { guia: 1, idEstado: 7 } },
    ]);
    const g = await getGuide(opts(impl), 1);
    expect(g?.idEstado).toBe(7);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 4xx", async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: { error: "La guía no es válida" } },
      { body: { guia: 1 } },
    ]);
    await expect(getGuide(opts(impl), 1)).rejects.toThrow(/HTTP 400/);
    expect(calls).toHaveLength(1);
  });
});

describe("bulk state changes", () => {
  it("requestPickup sends idEstado 3", async () => {
    const { impl, calls } = fakeFetch([{ body: [] }]);
    await requestPickup(opts(impl), ["1", "2"]);
    expect(calls[0]?.url).toBe(`${BASE}/v2/guias/updateMassiveGuides`);
    expect(calls[0]?.body).toEqual({ guias: ["1", "2"], idEstado: "3" });
  });

  it("cancelGuides sends idEstado 10", async () => {
    const { impl, calls } = fakeFetch([{ body: [] }]);
    await cancelGuides(opts(impl), ["1"]);
    expect(calls[0]?.body).toEqual({ guias: ["1"], idEstado: "10" });
  });

  it("normalizes the bare array the server really returns", async () => {
    // Captured live while cancelling a real test guide — the docs promise
    // {results:[{guia,success,estado}]}, the server sends this instead.
    const { impl } = fakeFetch([
      { body: [{ guia: "50000002618", exito: "Guía Procesada", msg: "Se marco como Cancelada!" }] },
    ]);
    const r = await cancelGuides(opts(impl), ["50000002618"]);
    expect(r).toEqual([
      { guia: "50000002618", ok: true, message: "Guía Procesada" },
    ]);
  });

  it("still understands the documented {results} shape", async () => {
    const { impl } = fakeFetch([
      { body: { results: [{ guia: "1", success: true, estado: "Cancelada" }] } },
    ]);
    const r = await cancelGuides(opts(impl), ["1"]);
    expect(r[0]).toMatchObject({ guia: "1", ok: true });
  });

  it("marks a per-guide failure as not ok", async () => {
    const { impl } = fakeFetch([{ body: [{ guia: "1", error: "No se puede cancelar" }] }]);
    const r = await cancelGuides(opts(impl), ["1"]);
    expect(r[0]).toMatchObject({ guia: "1", ok: false });
  });
});

describe("isSwaypAuthError", () => {
  it("flags 401 and Swayp's own auth wording (the token cannot be refreshed)", () => {
    expect(isSwaypAuthError(new SwaypError(401, '{"message":"No tienes autorización 9067"}'))).toBe(true);
    expect(isSwaypAuthError(new SwaypError(200, '{"error":"Error: Token expired"}'))).toBe(true);
    expect(isSwaypAuthError(new SwaypError(403, "No tienes permisos para realizar esta acción."))).toBe(true);
  });

  it("does not mistake an intermediary's 403 for a dead credential", () => {
    // Observed for real: an egress gateway answering before the request ever
    // reached Swayp. Alerting "token inválido" on this would page someone over
    // a network policy.
    const proxy403 = new SwaypError(
      403,
      "Host not in allowlist: us-central1-swayp-staging.cloudfunctions.net. Add this host to your network egress settings to allow access.",
    );
    expect(isSwaypAuthError(proxy403)).toBe(false);
  });

  it("does not flag ordinary failures", () => {
    expect(isSwaypAuthError(new SwaypError(400, "La dirección debe tener al menos 5 caracteres"))).toBe(false);
    expect(isSwaypAuthError(new SwaypError(500, "Error en manejo de inventario"))).toBe(false);
    expect(isSwaypAuthError(new Error("boom"))).toBe(false);
  });
});

describe("mapSwaypState", () => {
  it("maps the happy path", () => {
    expect(mapSwaypState(1)).toBe("pendiente");
    expect(mapSwaypState(3)).toBe("pendiente");
    expect(mapSwaypState(4)).toBe("en_ruta");
    expect(mapSwaypState(5)).toBe("en_ruta");
    expect(mapSwaypState(7)).toBe("entregado");
  });

  it("keeps novedad and revisión workable (they need a gestión call)", () => {
    expect(mapSwaypState(6)).toBe("pendiente");
    expect(mapSwaypState(8)).toBe("pendiente");
  });

  it("closes cancelled, indemnified and returned guides", () => {
    expect(mapSwaypState(10)).toBe("anulado");
    expect(mapSwaypState(11)).toBe("anulado");
    expect(mapSwaypState(12)).toBe("anulado");
  });

  it("accepts the string form the webhook sends", () => {
    expect(mapSwaypState("7")).toBe("entregado");
  });

  it("returns null for an unknown code so the caller leaves the row alone", () => {
    expect(mapSwaypState(99)).toBeNull();
    expect(mapSwaypState("nope")).toBeNull();
  });
});

describe("trackingUrl", () => {
  it("builds the public tracking link", () => {
    expect(trackingUrl(10000023834)).toBe("https://www.swayp.co/tracking/10000023834");
  });
});
