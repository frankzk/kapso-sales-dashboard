// Coordenada por dirección (Google), el PILOTO (docs/kapta/geocodificacion-propuesta.md):
// qué se le manda a Google (nunca nombre, celular ni pedido), cómo se lee lo que
// devuelve, el candado (cada motivo de rechazo), la cuenta del piloto y que el
// botón de Ajustes exija «Administrar tiendas» y no llame a nada sin la clave.
// Sin red ni base real: Google y Supabase son falsos.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  allowed: true,
  key: "",
  run: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "store-1", org_id: "org-1" } }) }) }),
    }),
  }),
  createServerSupabase: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));
vi.mock("@/lib/permissions-access", () => ({
  hasOrgPermission: vi.fn(async (_org: string, perm: string) => h.allowed && perm === "stores.manage"),
}));
vi.mock("next/navigation", () => ({
  redirect: (p: string) => {
    throw new Error(`redirect:${p}`);
  },
}));
vi.mock("@/lib/env", () => ({ env: { googleGeocodingApiKey: () => h.key } }));

import {
  GEOCODE_KEY_MISSING,
  GOOGLE_GEOCODE_ENDPOINT,
  aggregateGeocodePilot,
  geocodeQueryString,
  geocodeRequestParams,
  geocodeSafeguard,
  haversineMeters,
  median,
  parseGeocodeResponse,
  type GeocodeAddressComponent,
  type GeocodePilotSample,
  type GeocodeResult,
} from "@/lib/geocode-google";

// ─── Ayudas ──────────────────────────────────────────────────────────────────

const comp = (long_name: string, ...types: string[]): GeocodeAddressComponent => ({ long_name, short_name: long_name, types });

function result(over: Partial<GeocodeResult> = {}): GeocodeResult {
  return {
    lat: -16.3989,
    lng: -71.535,
    locationType: "ROOFTOP",
    partialMatch: false,
    components: [
      comp("123", "street_number"),
      comp("Avenida Ejército", "route"),
      comp("Yanahuara", "administrative_area_level_3", "political"),
      comp("Arequipa", "administrative_area_level_2", "political"),
      comp("Arequipa", "administrative_area_level_1", "political"),
      comp("Perú", "country", "political"),
    ],
    ...over,
  };
}

const AREQUIPA = { district: "Yanahuara", region: "Arequipa" };

// ─── La petición ─────────────────────────────────────────────────────────────

describe("qué se le manda a Google", () => {
  const order = {
    address: "Av. Ejército 123",
    district: "Yanahuara",
    province: "Arequipa",
    region: "Arequipa",
    customer_name: "María Quispe Huamán",
    customer_phone: "987654321",
    order_name: "#KP200123",
    shopify_order_id: "woo:200123",
  };

  it("solo la dirección: calle, distrito, provincia y departamento, con region=pe y country:PE", () => {
    const p = geocodeRequestParams(order);
    expect(p).toEqual({
      address: "Av. Ejército 123, Yanahuara, Arequipa",
      region: "pe",
      components: "country:PE",
      language: "es",
    });
  });

  it("nunca lleva el nombre, el celular ni el pedido, aunque reciba la fila entera", () => {
    const qs = decodeURIComponent(geocodeQueryString(geocodeRequestParams(order)!)).replace(/\+/g, " ");
    for (const pii of ["María", "Quispe", "987654321", "KP200123", "200123", "woo:"]) {
      expect(qs).not.toContain(pii);
    }
    expect(Object.keys(geocodeRequestParams(order)!).sort()).toEqual(["address", "components", "language", "region"]);
    // La clave no va en la query pura: la pone el servidor.
    expect(qs).not.toContain("key=");
  });

  it("quita un celular escrito dentro de la dirección", () => {
    for (const phone of ["987654321", "987 654 321", "+51 987654321", "51987654321", "987-654-321"]) {
      const p = geocodeRequestParams({ ...order, address: `Jr. Lima 450 cel ${phone}` })!;
      expect(p.address).not.toMatch(/987/);
      expect(p.address).toContain("Jr. Lima 450");
    }
  });

  it("sin calle no hay consulta; las partes repetidas y el «(provincia)» van una vez y limpios", () => {
    expect(geocodeRequestParams({ ...order, address: "" })).toBeNull();
    expect(geocodeRequestParams({ ...order, address: "   987654321 " })).toBeNull();
    const lima = geocodeRequestParams({ address: "Calle Los Pinos 145", district: "Lima", province: "Lima", region: "Lima (provincia)" })!;
    expect(lima.address).toBe("Calle Los Pinos 145, Lima");
  });

  it("es la Geocoding API clásica (v3), no la v4", () => {
    expect(GOOGLE_GEOCODE_ENDPOINT).toBe("https://maps.googleapis.com/maps/api/geocode/json");
  });
});

// ─── La respuesta ────────────────────────────────────────────────────────────

describe("leer la respuesta de Google", () => {
  it("OK: el primer resultado, con location_type y partial_match", () => {
    const parsed = parseGeocodeResponse({
      status: "OK",
      results: [
        {
          address_components: [{ long_name: "Yanahuara", short_name: "Yanahuara", types: ["administrative_area_level_3"] }],
          geometry: { location: { lat: -16.39, lng: -71.54 }, location_type: "RANGE_INTERPOLATED" },
          partial_match: true,
          formatted_address: "no se guarda",
        },
        { geometry: { location: { lat: 0, lng: 0 }, location_type: "ROOFTOP" } },
      ],
    });
    expect(parsed).toEqual({
      kind: "ok",
      result: {
        lat: -16.39,
        lng: -71.54,
        locationType: "RANGE_INTERPOLATED",
        partialMatch: true,
        components: [{ long_name: "Yanahuara", short_name: "Yanahuara", types: ["administrative_area_level_3"] }],
      },
    });
  });

  it("ZERO_RESULTS, errores de la clave (fatales) y basura", () => {
    expect(parseGeocodeResponse({ status: "ZERO_RESULTS", results: [] })).toEqual({ kind: "zero_results" });
    expect(parseGeocodeResponse({ status: "REQUEST_DENIED", error_message: "x" })).toEqual({ kind: "error", status: "REQUEST_DENIED", fatal: true });
    expect(parseGeocodeResponse({ status: "OVER_QUERY_LIMIT" })).toEqual({ kind: "error", status: "OVER_QUERY_LIMIT", fatal: false });
    expect(parseGeocodeResponse(null)).toEqual({ kind: "error", status: "INVALID_RESPONSE", fatal: false });
    expect(parseGeocodeResponse({ status: "OK", results: [{ geometry: {} }] })).toEqual({ kind: "error", status: "INVALID_RESPONSE", fatal: false });
  });
});

// ─── El candado ──────────────────────────────────────────────────────────────

describe("el candado", () => {
  it("pasa: ROOFTOP o RANGE_INTERPOLATED, completo, mismo distrito y departamento, en el Perú", () => {
    expect(geocodeSafeguard(result(), AREQUIPA)).toEqual({ ok: true, lat: -16.3989, lng: -71.535, precision: "ROOFTOP" });
    expect(geocodeSafeguard(result({ locationType: "RANGE_INTERPOLATED" }), AREQUIPA)).toMatchObject({
      ok: true,
      precision: "RANGE_INTERPOLATED",
    });
  });

  it("sin resultado", () => {
    expect(geocodeSafeguard(null, AREQUIPA)).toEqual({ ok: false, reason: "sin_resultado" });
  });

  it("impreciso: GEOMETRIC_CENTER y APPROXIMATE no sirven", () => {
    for (const t of ["GEOMETRIC_CENTER", "APPROXIMATE", ""]) {
      expect(geocodeSafeguard(result({ locationType: t }), AREQUIPA)).toEqual({ ok: false, reason: "impreciso" });
    }
  });

  it("coincidencia parcial", () => {
    expect(geocodeSafeguard(result({ partialMatch: true }), AREQUIPA)).toEqual({ ok: false, reason: "coincidencia_parcial" });
  });

  it("el pedido sin distrito o sin departamento reconocible no se puede comprobar", () => {
    expect(geocodeSafeguard(result(), { district: "", region: "Arequipa" })).toEqual({ ok: false, reason: "pedido_sin_destino" });
    expect(geocodeSafeguard(result(), { district: "Yanahuara", region: "Av Mariátegui mercado" })).toEqual({
      ok: false,
      reason: "pedido_sin_destino",
    });
  });

  it("otro departamento, aunque sea exacto", () => {
    expect(geocodeSafeguard(result(), { district: "Yanahuara", region: "Cusco" })).toEqual({ ok: false, reason: "departamento_distinto" });
  });

  it("otro distrito, aunque sea exacto y del mismo departamento", () => {
    expect(geocodeSafeguard(result(), { district: "Cayma", region: "Arequipa" })).toEqual({ ok: false, reason: "distrito_distinto" });
  });

  it("fuera del Perú", () => {
    expect(geocodeSafeguard(result({ lat: -33.45, lng: -70.66 }), AREQUIPA)).toEqual({ ok: false, reason: "fuera_del_peru" });
  });

  it("tildes, mayúsculas y Cusco/Cuzco no cuentan como distinto", () => {
    const cusco = result({
      lat: -13.53,
      lng: -71.97,
      components: [comp("Wánchaq", "administrative_area_level_3"), comp("Cusco", "administrative_area_level_1")],
    });
    expect(geocodeSafeguard(cusco, { district: "WANCHAQ", region: "Cuzco" }).ok).toBe(true);
    expect(geocodeSafeguard(result(), { district: "yanahuará", region: "AREQUIPA" }).ok).toBe(true);
  });

  it("Google con prefijo administrativo en el departamento («Departamento de», «Región»)", () => {
    for (const dep of ["Departamento de Arequipa", "Región Arequipa", "Gobierno Regional de Arequipa"]) {
      const r = result({ components: [comp("Yanahuara", "administrative_area_level_3"), comp(dep, "administrative_area_level_1")] });
      expect(geocodeSafeguard(r, AREQUIPA).ok).toBe(true);
    }
  });

  it("Lima: «Provincia de Lima» es Lima; sin nivel 3 usa la localidad; Surco y Cercado por su nombre de siempre", () => {
    const surco = result({
      lat: -12.14,
      lng: -76.99,
      components: [comp("Santiago de Surco", "locality", "political"), comp("Provincia de Lima", "administrative_area_level_1")],
    });
    expect(geocodeSafeguard(surco, { district: "Surco", region: "Lima (provincia)" }).ok).toBe(true);
    const cercado = result({
      lat: -12.05,
      lng: -77.04,
      components: [comp("Cercado de Lima", "sublocality_level_1", "sublocality"), comp("Municipalidad Metropolitana de Lima", "administrative_area_level_1")],
    });
    expect(geocodeSafeguard(cercado, { district: "Lima", region: "Lima" }).ok).toBe(true);
    // Miraflores de Lima no es Miraflores de Arequipa.
    const miraflores = result({
      lat: -12.12,
      lng: -77.03,
      components: [comp("Miraflores", "locality"), comp("Provincia de Lima", "administrative_area_level_1")],
    });
    expect(geocodeSafeguard(miraflores, { district: "Miraflores", region: "Arequipa" })).toEqual({ ok: false, reason: "departamento_distinto" });
  });

  it("el nivel 3 manda sobre la localidad", () => {
    const r = result({
      components: [comp("Cayma", "administrative_area_level_3"), comp("Yanahuara", "locality"), comp("Arequipa", "administrative_area_level_1")],
    });
    expect(geocodeSafeguard(r, AREQUIPA)).toEqual({ ok: false, reason: "distrito_distinto" });
  });

  it("un nombre doble («Lurigancho-Chosica») casa con su mitad del padrón", () => {
    const r = result({
      lat: -11.94,
      lng: -76.7,
      components: [comp("Lurigancho", "administrative_area_level_3"), comp("Provincia de Lima", "administrative_area_level_1")],
    });
    expect(geocodeSafeguard(r, { district: "Lurigancho-Chosica", region: "Lima (provincia)" }).ok).toBe(true);
  });

  it("los alias de Lima solo valen en Lima: «Jesús» de Cajamarca no es Jesús María", () => {
    const r = result({
      lat: -7.25,
      lng: -78.38,
      components: [comp("Jesús María", "administrative_area_level_3"), comp("Cajamarca", "administrative_area_level_1")],
    });
    expect(geocodeSafeguard(r, { district: "Jesús", region: "Cajamarca" })).toEqual({ ok: false, reason: "distrito_distinto" });
  });
});

// ─── Distancia y cuenta ──────────────────────────────────────────────────────

describe("distancia y cuenta del piloto", () => {
  it("haversine: cero en el mismo punto, ~111 km por grado de latitud, simétrica", () => {
    const a = { lat: -12.1, lng: -77.03 };
    expect(haversineMeters(a, a)).toBe(0);
    expect(haversineMeters({ lat: 0, lng: -77 }, { lat: 1, lng: -77 })).toBeCloseTo(111_195, -1);
    const b = { lat: -12.1027, lng: -77.03 };
    expect(haversineMeters(a, b)).toBeCloseTo(300, -1);
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  it("mediana con número par e impar de valores", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([400, 100, 200, 300])).toBe(250);
  });

  const ok = (coverage: "lima" | "provincia_cod", distanceM: number, precision: "ROOFTOP" | "RANGE_INTERPOLATED" = "ROOFTOP") =>
    ({ coverage, ok: true, precision, distanceM }) as GeocodePilotSample;
  const no = (coverage: "lima" | "provincia_cod", reason: "impreciso" | "distrito_distinto" | "sin_direccion") =>
    ({ coverage, ok: false, reason }) as GeocodePilotSample;

  it("por cobertura: muestra, pasan, motivos, mediana, ≤ 300 m, > 1 km y criterio B", () => {
    const samples: GeocodePilotSample[] = [
      // Lima: 10 que pasan, 9 a ≤ 300 m (90 %: cumple justo), 1 a 1,5 km.
      ...Array.from({ length: 9 }, (_, i) => ok("lima", 50 + i * 25)),
      ok("lima", 1500, "RANGE_INTERPOLATED"),
      no("lima", "impreciso"),
      no("lima", "impreciso"),
      no("lima", "sin_direccion"),
      // Provincia: 4 que pasan, 2 a ≤ 300 m (50 %): no cumple.
      ok("provincia_cod", 100),
      ok("provincia_cod", 300),
      ok("provincia_cod", 301),
      ok("provincia_cod", 2000, "RANGE_INTERPOLATED"),
      no("provincia_cod", "distrito_distinto"),
    ];
    const { byCoverage, total } = aggregateGeocodePilot(samples);
    const [lima, prov] = byCoverage;
    expect(lima).toMatchObject({
      coverage: "lima",
      sampled: 13,
      passed: 10,
      rejections: { impreciso: 2, sin_direccion: 1 },
      rooftop: 9,
      rangeInterpolated: 1,
      medianM: (150 + 175) / 2,
      within300Pct: 90,
      beyond1kmPct: 10,
      rooftopWithin300Pct: 100,
      criterionBMet: true,
      smallSample: true,
    });
    expect(prov).toMatchObject({
      coverage: "provincia_cod",
      sampled: 5,
      passed: 4,
      rejections: { distrito_distinto: 1 },
      medianM: 300.5,
      within300Pct: 50,
      beyond1kmPct: 25,
      criterionBMet: false,
    });
    expect(prov!.rooftopWithin300Pct).toBeCloseTo(66.667, 2);
    expect(total).toMatchObject({ coverage: "total", sampled: 18, passed: 14, rejections: { impreciso: 2, sin_direccion: 1, distrito_distinto: 1 } });
    expect(total.within300Pct).toBeCloseTo((11 / 14) * 100, 6);
    expect(total.criterionBMet).toBe(false);
  });

  it("sin puntos que pasan no hay porcentajes ni veredicto", () => {
    const { byCoverage } = aggregateGeocodePilot([no("lima", "impreciso")]);
    expect(byCoverage[0]).toMatchObject({ passed: 0, medianM: null, within300Pct: null, beyond1kmPct: null, criterionBMet: null });
    expect(byCoverage[1]).toMatchObject({ sampled: 0, passed: 0, criterionBMet: null });
  });
});

// ─── La pasada en el servidor (Supabase y Google falsos) ────────────────────

type Call = { table: string; method: string; args: unknown[] };

function fakeAdmin(tables: { order_master: Record<string, unknown>[]; wooIds: string[] }) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      let rangeFrom = 0;
      let rangeTo = Infinity;
      let ids: string[] | null = null;
      for (const m of ["select", "eq", "gte", "not", "order"]) {
        chain[m] = (...args: unknown[]) => {
          calls.push({ table, method: m, args });
          return chain;
        };
      }
      chain.in = (...args: unknown[]) => {
        calls.push({ table, method: "in", args });
        if (args[0] === "id") ids = args[1] as string[];
        return chain;
      };
      chain.range = (a: number, b: number) => {
        rangeFrom = a;
        rangeTo = b;
        return chain;
      };
      for (const w of ["insert", "update", "upsert", "delete", "rpc"]) {
        chain[w] = () => {
          throw new Error(`escritura prohibida: ${table}.${w}`);
        };
      }
      chain.then = (res: (v: unknown) => unknown) => {
        const data =
          table === "order_master"
            ? tables.order_master.slice(rangeFrom, rangeTo + 1)
            : (ids ?? []).filter((id) => tables.wooIds.includes(id)).map((id) => ({ id }));
        return Promise.resolve({ data, error: null }).then(res);
      };
      return chain;
    },
  };
  return { client: client as never, calls };
}

function googleOk(lat: number, lng: number, district: string, dep: string, locationType = "ROOFTOP") {
  return {
    status: "OK",
    results: [
      {
        address_components: [
          { long_name: district, short_name: district, types: ["administrative_area_level_3"] },
          { long_name: dep, short_name: dep, types: ["administrative_area_level_1"] },
        ],
        geometry: { location: { lat, lng }, location_type: locationType },
      },
    ],
  };
}

describe("runGeocodePilot", () => {
  const rows = [
    { order_id: "o1", coverage: "lima", address: "Av. Larco 345", district: "Miraflores", province: "Lima", region: "Lima (provincia)", latitude: -12.1211, longitude: -77.0297 },
    { order_id: "o2", coverage: "provincia_cod", address: "Av. Ejército 123", district: "Yanahuara", province: "Arequipa", region: "Arequipa", latitude: "-16.3989", longitude: "-71.5350" },
    { order_id: "o3", coverage: "provincia_cod", address: "Mz B Lt 22", district: "Cayma", province: "Arequipa", region: "Arequipa", latitude: -16.37, longitude: -71.54 },
    { order_id: "o4", coverage: "lima", address: "", district: "Surco", province: "Lima", region: "Lima", latitude: -12.14, longitude: -76.99 },
    // Shopify (no está en wooIds): fuera de la muestra.
    { order_id: "o5", coverage: "lima", address: "Jr. X 1", district: "Lince", province: "Lima", region: "Lima", latitude: -12.08, longitude: -77.03 },
  ];

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("mide solo WooCommerce, compara con el pin, no escribe y devuelve solo cuentas", async () => {
    const { runGeocodePilot } = await import("@/lib/geocode-google-server");
    const { client, calls } = fakeAdmin({ order_master: rows, wooIds: ["o1", "o2", "o3", "o4"] });
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      const address = new URL(url).searchParams.get("address") ?? "";
      const body = address.startsWith("Av. Larco")
        ? googleOk(-12.1220, -77.0297, "Miraflores", "Provincia de Lima")
        : address.startsWith("Av. Ejército")
          ? googleOk(-16.3989, -71.535, "Yanahuara", "Arequipa", "RANGE_INTERPOLATED")
          : googleOk(-16.37, -71.54, "Cayma", "Arequipa", "GEOMETRIC_CENTER");
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const run = await runGeocodePilot(client, "store-1", { key: "CLAVE-FALSA", fetchImpl: fetchImpl as never, now: new Date("2026-11-02T15:00:00Z") });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const r = run.report;
    expect(r.apiCalls).toBe(3); // o4 no tiene calle: no se consulta
    expect(r.total).toMatchObject({ sampled: 4, passed: 2, rejections: { impreciso: 1, sin_direccion: 1 } });
    const [lima, prov] = r.byCoverage;
    expect(lima).toMatchObject({ sampled: 2, passed: 1, criterionBMet: true });
    expect(lima!.medianM).toBeCloseTo(100, -1);
    expect(prov).toMatchObject({ sampled: 2, passed: 1, medianM: 0, criterionBMet: true });

    // La muestra: WooCommerce, últimos 7 días, Lima/Provincia COD, con pin.
    expect(calls).toContainEqual({ table: "orders", method: "not", args: ["raw->woo", "is", null] });
    expect(calls).toContainEqual({ table: "order_master", method: "in", args: ["coverage", ["lima", "provincia_cod"]] });
    expect(calls).toContainEqual({ table: "order_master", method: "not", args: ["latitude", "is", null] });
    expect(calls).toContainEqual({ table: "order_master", method: "gte", args: ["order_created_at", "2026-10-26T15:00:00.000Z"] });

    // A Google: la API clásica, solo la dirección.
    for (const u of urls) {
      expect(u.startsWith("https://maps.googleapis.com/maps/api/geocode/json?")).toBe(true);
      expect(u).not.toMatch(/o[1-5]\b|Lince/);
    }
    // El resultado y el registro no llevan direcciones, ids de pedido ni la clave.
    const out = JSON.stringify(r) + vi.mocked(console.info).mock.calls.map((c) => String(c[0])).join("\n");
    for (const s of ["Larco", "Ejército", "Mz B", "o1", "o2", "CLAVE-FALSA", "Miraflores", "Yanahuara"]) {
      expect(out).not.toContain(s);
    }
  });

  it("una clave rechazada corta la pasada y lo dice, sin datos", async () => {
    const { runGeocodePilot } = await import("@/lib/geocode-google-server");
    const { client } = fakeAdmin({ order_master: rows, wooIds: ["o1", "o2", "o3"] });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "REQUEST_DENIED", error_message: "API key not valid" }), { status: 200 }));
    const run = await runGeocodePilot(client, "store-1", { key: "CLAVE-FALSA", fetchImpl: fetchImpl as never });
    expect(run).toEqual({ ok: false, error: expect.stringContaining("REQUEST_DENIED") });
    expect(JSON.stringify(run)).not.toContain("CLAVE-FALSA");
  });

  it("el cupo diario agotado (OVER_QUERY_LIMIT) deja de consultar y lo cuenta aparte", async () => {
    const { runGeocodePilot } = await import("@/lib/geocode-google-server");
    const many = Array.from({ length: 20 }, (_, i) => ({ ...rows[1]!, order_id: `p${i}` }));
    const { client } = fakeAdmin({ order_master: many, wooIds: many.map((m) => m.order_id) });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "OVER_QUERY_LIMIT" }), { status: 200 }));
    const run = await runGeocodePilot(client, "store-1", { key: "k", fetchImpl: fetchImpl as never });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.report.quotaHit).toBe(true);
    expect(run.report.total.rejections.sin_cupo).toBe(20);
    // Como mucho las 5 que ya estaban en vuelo.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("pasado el presupuesto de tiempo no empieza más consultas y marca la pasada como cortada", async () => {
    const { runGeocodePilot, GEOCODE_PILOT } = await import("@/lib/geocode-google-server");
    const many = Array.from({ length: 12 }, (_, i) => ({ ...rows[1]!, order_id: `p${i}` }));
    const { client } = fakeAdmin({ order_master: many, wooIds: many.map((m) => m.order_id) });
    let t = 0;
    const fetchImpl = vi.fn(async () => {
      // La primera tanda sale a la vez; al volver, ya se pasó el presupuesto.
      await new Promise((r) => setTimeout(r, 0));
      t = GEOCODE_PILOT.budgetMs + 1;
      return new Response(JSON.stringify(googleOk(-16.3989, -71.535, "Yanahuara", "Arequipa")), { status: 200 });
    });
    const run = await runGeocodePilot(client, "store-1", { key: "k", fetchImpl: fetchImpl as never, clock: () => t });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.report.truncated).toBe(true);
    expect(fetchImpl.mock.calls.length).toBe(GEOCODE_PILOT.concurrency);
    expect(run.report.total.rejections.sin_tiempo).toBe(12 - GEOCODE_PILOT.concurrency);
  });

  it("el tope de la muestra es el cupo diario de Google (400)", async () => {
    const { GEOCODE_PILOT } = await import("@/lib/geocode-google-server");
    expect(GEOCODE_PILOT.cap).toBe(400);
    expect(GEOCODE_PILOT.concurrency).toBe(5);
    expect(GEOCODE_PILOT.budgetMs + GEOCODE_PILOT.requestTimeoutMs).toBeLessThanOrEqual(50_000);
  });
});

// ─── El botón de Ajustes ─────────────────────────────────────────────────────

describe("la acción de Ajustes", () => {
  const ACTION = readFileSync(resolve(process.cwd(), "app/dashboard/[storeId]/settings/geocode-actions.ts"), "utf8");

  it("en el código: exige «Administrar tiendas» antes de leer la clave y de medir", () => {
    expect(ACTION.startsWith('"use server";')).toBe(true);
    const perm = ACTION.indexOf('hasOrgPermission((store as { org_id: string }).org_id, "stores.manage")');
    const key = ACTION.indexOf("env.googleGeocodingApiKey()");
    const run = ACTION.indexOf("runGeocodePilot(admin");
    expect(perm).toBeGreaterThan(0);
    expect(key).toBeGreaterThan(perm);
    expect(run).toBeGreaterThan(key);
  });

  beforeEach(() => {
    h.allowed = true;
    h.key = "k";
    h.run.mockReset();
  });

  async function action() {
    vi.doMock("@/lib/geocode-google-server", () => ({ runGeocodePilot: h.run }));
    vi.resetModules();
    const mod = await import("@/app/dashboard/[storeId]/settings/geocode-actions");
    const fd = new FormData();
    fd.set("store_id", "store-1");
    return mod.runGeocodePilotAction({}, fd);
  }

  it("sin permiso no mide", async () => {
    h.allowed = false;
    expect(await action()).toEqual({ error: "Sin permiso." });
    expect(h.run).not.toHaveBeenCalled();
  });

  it("sin la clave lo dice y no llama a nada", async () => {
    h.key = "";
    expect(await action()).toEqual({ error: GEOCODE_KEY_MISSING });
    expect(GEOCODE_KEY_MISSING).toBe("Falta GOOGLE_GEOCODING_API_KEY en Vercel");
    expect(h.run).not.toHaveBeenCalled();
  });

  it("con permiso y clave devuelve el reporte", async () => {
    const report = { apiCalls: 0 };
    h.run.mockResolvedValue({ ok: true, report });
    expect(await action()).toEqual({ report });
    expect(h.run).toHaveBeenCalledWith(expect.anything(), "store-1", { key: "k" });
  });
});

describe("los confirmados por Chatby sin ubicación", () => {
  const ACTION = readFileSync(resolve(process.cwd(), "app/dashboard/[storeId]/settings/geocode-actions.ts"), "utf8");

  it("en el código: el mismo permiso antes de la clave y de consultar", () => {
    const start = ACTION.indexOf("export async function runGeocodeChatbyAction");
    const body = ACTION.slice(start);
    const perm = body.indexOf('"stores.manage"');
    const key = body.indexOf("env.googleGeocodingApiKey()");
    const run = body.indexOf("runGeocodeChatbyCheck(admin");
    expect(start).toBeGreaterThan(0);
    expect(perm).toBeGreaterThan(0);
    expect(key).toBeGreaterThan(perm);
    expect(run).toBeGreaterThan(key);
  });

  it("prueba pedido por pedido, no escribe y solo da el punto de los que pasan", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    // La acción de arriba deja el módulo simulado: aquí va el de verdad.
    vi.doUnmock("@/lib/geocode-google-server");
    vi.resetModules();
    const { runGeocodeChatbyCheck } = await import("@/lib/geocode-google-server");
    const checks = [
      { order_id: "c1", outcome: "confirmado", reason: null, guide_state: "para_persona", guide_detail: "sin_ubicacion" },
      { order_id: "c2", outcome: "para_asesora", reason: "sin_ubicacion", guide_state: "para_persona", guide_detail: "sin_ubicacion" },
    ];
    const masters = [
      { order_id: "c1", order_name: "#KP1", coverage: "provincia_cod", address: "Av. Ejército 123", district: "Yanahuara", province: "Arequipa", region: "Arequipa" },
      { order_id: "c2", order_name: "#KP2", coverage: "provincia_cod", address: "Mz B Lt 22", district: "Cayma", province: "Arequipa", region: "Arequipa" },
    ];
    const client = {
      from(table: string) {
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "or", "limit", "in"]) chain[m] = () => chain;
        for (const w of ["insert", "update", "upsert", "delete"]) {
          chain[w] = () => {
            throw new Error(`escritura prohibida: ${table}.${w}`);
          };
        }
        chain.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: table === "chatby_auto_checks" ? checks : masters, error: null }).then(res);
        return chain;
      },
    };
    const fetchImpl = vi.fn(async (url: string) => {
      const address = new URL(url).searchParams.get("address") ?? "";
      const body = address.startsWith("Av. Ejército")
        ? googleOk(-16.3989, -71.535, "Yanahuara", "Arequipa", "ROOFTOP")
        : googleOk(-16.37, -71.54, "Cayma", "Arequipa", "GEOMETRIC_CENTER");
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const run = await runGeocodeChatbyCheck(client as never, "store-1", { key: "k", fetchImpl: fetchImpl as never });
    expect(run).toEqual({
      ok: true,
      apiCalls: 2,
      rows: [
        { orderName: "#KP1", stage: "preparacion", coverage: "provincia_cod", ok: true, precision: "ROOFTOP", point: { lat: -16.3989, lng: -71.535 } },
        { orderName: "#KP2", stage: "por_confirmar", coverage: "provincia_cod", ok: false, reason: "impreciso" },
      ],
    });
  });
});

describe("la coordenada por dirección para la guía automática (0301)", () => {
  it("la guía automática solo acepta el edificio", async () => {
    const { geocodeUsableForAutoGuide } = await import("@/lib/geocode-google");
    expect(geocodeUsableForAutoGuide({ ok: true, lat: -6.8, lng: -79.8, precision: "ROOFTOP" })).toBe(true);
    expect(geocodeUsableForAutoGuide({ ok: true, lat: -6.8, lng: -79.8, precision: "RANGE_INTERPOLATED" })).toBe(false);
    expect(geocodeUsableForAutoGuide({ ok: false, reason: "impreciso" })).toBe(false);
  });

  function cacheAdmin(initial: Record<string, unknown> | null) {
    const state = { row: initial, upserts: [] as Record<string, unknown>[] };
    const client = {
      from() {
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) chain[m] = () => chain;
        chain.maybeSingle = () => Promise.resolve({ data: state.row, error: null });
        chain.upsert = (row: Record<string, unknown>) => {
          state.upserts.push(row);
          state.row = row;
          return Promise.resolve({ error: null });
        };
        return chain;
      },
    };
    return { client: client as never, state };
  }

  const order = { order_id: "o1", store_id: "s1", address: "Av. Ejército 123", district: "Yanahuara", province: "Arequipa", region: "Arequipa" };

  it("consulta una vez y después usa lo guardado; un error no se guarda", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.doUnmock("@/lib/geocode-google-server");
    vi.resetModules();
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const { client, state } = cacheAdmin(null);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(googleOk(-16.3989, -71.535, "Yanahuara", "Arequipa", "ROOFTOP")), { status: 200 }));
    const first = await geocodeOrderAddress(client, order, { key: "k", fetchImpl: fetchImpl as never });
    expect(first).toMatchObject({ kind: "ok", precision: "ROOFTOP", cached: false });
    expect(state.upserts).toHaveLength(1);
    const second = await geocodeOrderAddress(client, order, { key: "k", fetchImpl: fetchImpl as never });
    expect(second).toMatchObject({ kind: "ok", cached: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Otra dirección: vuelve a consultar. El número de la cuadra no sirve para la guía.
    const moved = { ...order, address: "Calle Nueva 456" };
    const interpolated = vi.fn(async () => new Response(JSON.stringify(googleOk(-16.39, -71.53, "Yanahuara", "Arequipa", "RANGE_INTERPOLATED")), { status: 200 }));
    expect(await geocodeOrderAddress(client, moved, { key: "k", fetchImpl: interpolated as never })).toMatchObject({ kind: "rejected", precision: "RANGE_INTERPOLATED" });

    const fresh = cacheAdmin(null);
    const failing = vi.fn(async () => new Response("oops", { status: 500 }));
    expect(await geocodeOrderAddress(fresh.client, order, { key: "k", fetchImpl: failing as never })).toMatchObject({ kind: "unavailable" });
    expect(fresh.state.upserts).toHaveLength(0);
  });
});

// ─── La medición de Lima para los reintentos automáticos (0308) ──────────────

describe("la medición de Lima: el criterio B con el edificio", () => {
  it("sin medición, con pocos puntos ROOFTOP o por debajo del 90 %: no deja encender", async () => {
    const { geocodeLimaGate, GEOCODE_LIMA_MIN_ROOFTOP } = await import("@/lib/geocode-google");
    const base = { ranAt: "2026-11-05T15:00:00Z", rooftop: 40, rooftopWithin300Pct: 92 } as never as import("@/lib/geocode-google").GeocodeLimaRunSummary;
    expect(geocodeLimaGate(null)).toMatchObject({ ok: false, reason: expect.stringContaining("Todavía no hay una medición de Lima") });
    expect(GEOCODE_LIMA_MIN_ROOFTOP).toBe(15);
    expect(geocodeLimaGate({ ...base, rooftop: GEOCODE_LIMA_MIN_ROOFTOP - 1 })).toMatchObject({ ok: false, reason: expect.stringContaining("hacen falta al menos 15") });
    expect(geocodeLimaGate({ ...base, rooftopWithin300Pct: 89.9 })).toMatchObject({ ok: false, reason: expect.stringContaining("hace falta el 90 %") });
    expect(geocodeLimaGate({ ...base, rooftopWithin300Pct: null })).toMatchObject({ ok: false });
    expect(geocodeLimaGate({ ...base, rooftop: GEOCODE_LIMA_MIN_ROOFTOP, rooftopWithin300Pct: 90 })).toEqual({ ok: true });
    // La primera medición de Lima (08-11-2026): 17 con el edificio, los 17 a 300 m o menos.
    expect(geocodeLimaGate({ ...base, rooftop: 17, rooftopWithin300Pct: 100 })).toEqual({ ok: true });
  });

  it("la cuenta guardada se lee con cuidado: lo roto no enciende nada", async () => {
    const { parseGeocodeLimaRunSummary, geocodeLimaRunSummary, aggregateGeocodePilot } = await import("@/lib/geocode-google");
    const samples: GeocodePilotSample[] = [
      { coverage: "lima", ok: true, precision: "ROOFTOP", distanceM: 50 },
      { coverage: "lima", ok: true, precision: "RANGE_INTERPOLATED", distanceM: 900 },
      { coverage: "lima", ok: false, reason: "impreciso" },
    ];
    const lima = aggregateGeocodePilot(samples).byCoverage[0]!;
    const summary = geocodeLimaRunSummary(lima, { ranAt: "x", days: 7, cap: 150, stores: 2, apiCalls: 3, truncated: false, quotaHit: false });
    expect(summary).toMatchObject({ sampled: 3, passed: 2, rooftop: 1, rangeInterpolated: 1, rooftopWithin300Pct: 100, rooftopMeetsB: true, within300Pct: 50, rejections: { impreciso: 1 } });
    expect(parseGeocodeLimaRunSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
    expect(parseGeocodeLimaRunSummary(null)).toBeNull();
    expect(parseGeocodeLimaRunSummary({ sampled: "x" })).toBeNull();
    expect(parseGeocodeLimaRunSummary({ ...summary, rejections: { inventado: 3, impreciso: "y" } })!.rejections).toEqual({});
  });
});

describe("runGeocodeLimaMeasure: solo Lima, con tope, y guarda solo cuentas", () => {
  function limaAdmin(rows: Record<string, unknown>[]) {
    const calls: Call[] = [];
    const inserts: { table: string; row: Record<string, unknown> }[] = [];
    const client = {
      from(table: string) {
        const chain: Record<string, unknown> = {};
        let rangeFrom = 0;
        let rangeTo = Infinity;
        let ids: string[] | null = null;
        for (const m of ["select", "eq", "gte", "not", "order"]) {
          chain[m] = (...args: unknown[]) => {
            calls.push({ table, method: m, args });
            return chain;
          };
        }
        chain.in = (...args: unknown[]) => {
          calls.push({ table, method: "in", args });
          if (args[0] === "id") ids = args[1] as string[];
          return chain;
        };
        chain.range = (a: number, b: number) => {
          rangeFrom = a;
          rangeTo = b;
          return chain;
        };
        chain.insert = async (row: Record<string, unknown>) => {
          if (table !== "geocode_pilot_runs") throw new Error(`escritura prohibida: ${table}`);
          inserts.push({ table, row });
          return { error: null };
        };
        for (const w of ["update", "upsert", "delete", "rpc"]) {
          chain[w] = () => {
            throw new Error(`escritura prohibida: ${table}.${w}`);
          };
        }
        chain.then = (res: (v: unknown) => unknown) => {
          const data = table === "order_master" ? rows.slice(rangeFrom, rangeTo + 1) : (ids ?? []).map((id) => ({ id }));
          return Promise.resolve({ data, error: null }).then(res);
        };
        return chain;
      },
    };
    return { client: client as never, calls, inserts };
  }

  it("mide como mucho 150 pedidos de Lima entre las tiendas, y guarda la cuenta sin direcciones ni pedidos", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.doUnmock("@/lib/geocode-google-server");
    vi.resetModules();
    const { runGeocodeLimaMeasure } = await import("@/lib/geocode-google-server");
    const { GEOCODE_LIMA_CAP } = await import("@/lib/geocode-google");
    expect(GEOCODE_LIMA_CAP).toBe(150);
    const lima = Array.from({ length: 220 }, (_, i) => ({
      order_id: `L${i}`, coverage: "lima", address: `Av. Larco ${100 + i}`, district: "Miraflores", province: "Lima", region: "Lima",
      latitude: -12.1211, longitude: -77.0297,
    }));
    const prov = Array.from({ length: 30 }, (_, i) => ({
      order_id: `P${i}`, coverage: "provincia_cod", address: `Av. Ejército ${i}`, district: "Yanahuara", province: "Arequipa", region: "Arequipa",
      latitude: -16.3989, longitude: -71.535,
    }));
    // Provincia primero: aun así no entra a la muestra.
    const { client, calls, inserts } = limaAdmin([...prov, ...lima]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(googleOk(-12.1212, -77.0297, "Miraflores", "Provincia de Lima")), { status: 200 }));
    const run = await runGeocodeLimaMeasure(client, {
      orgId: "org-1", storeIds: ["s1", "s2"], key: "CLAVE-FALSA", actor: "user-1", fetchImpl: fetchImpl as never, now: new Date("2026-11-05T15:00:00Z"),
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(fetchImpl).toHaveBeenCalledTimes(150);
    expect(run.summary).toMatchObject({ sampled: 150, passed: 150, rooftop: 150, rooftopWithin300Pct: 100, rooftopMeetsB: true, apiCalls: 150, cap: 150, stores: 2 });
    expect(calls).toContainEqual({ table: "order_master", method: "in", args: ["store_id", ["s1", "s2"]] });
    expect(calls).toContainEqual({ table: "order_master", method: "in", args: ["coverage", ["lima"]] });
    expect(calls).toContainEqual({ table: "orders", method: "not", args: ["raw->woo", "is", null] });
    for (const u of fetchImpl.mock.calls.map((c) => String((c as unknown[])[0]))) expect(u).not.toContain("Ej%C3%A9rcito");

    // Lo guardado: una fila de Lima de la organización, con solo cuentas.
    expect(inserts).toHaveLength(1);
    const saved = inserts[0]!.row;
    expect(saved).toMatchObject({ org_id: "org-1", store_id: null, coverage: "lima", created_by: "user-1", summary: run.summary });
    const out = JSON.stringify(saved) + JSON.stringify(run) + vi.mocked(console.info).mock.calls.map((c) => String(c[0])).join("\n");
    for (const s of ["Larco", "Miraflores", "L0", "L149", "CLAVE-FALSA", "-12.12", "-77.02"]) expect(out).not.toContain(s);
  });

  it("una clave rechazada no guarda nada", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runGeocodeLimaMeasure } = await import("@/lib/geocode-google-server");
    const { client, inserts } = limaAdmin([
      { order_id: "L1", coverage: "lima", address: "Av. Larco 1", district: "Miraflores", province: "Lima", region: "Lima", latitude: -12.12, longitude: -77.03 },
    ]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "REQUEST_DENIED" }), { status: 200 }));
    const run = await runGeocodeLimaMeasure(client, { orgId: "org-1", storeIds: ["s1"], key: "k", actor: null, fetchImpl: fetchImpl as never });
    expect(run).toEqual({ ok: false, error: expect.stringContaining("REQUEST_DENIED") });
    expect(inserts).toEqual([]);
  });
});

describe("el panel: medir Lima y el interruptor de los reintentos", () => {
  const ACTIONS = readFileSync(resolve(process.cwd(), "app/dashboard/automatizaciones/actions.ts"), "utf8");
  it("medir y encender pasan por la misma puerta (automations.manage y producción); encender exige B", () => {
    const measure = ACTIONS.slice(ACTIONS.indexOf("export async function measureLimaGeocodeNow"));
    expect(measure.indexOf("await gate(orgId)")).toBeGreaterThan(-1);
    expect(measure.indexOf("await gate(orgId)")).toBeLessThan(measure.indexOf("runGeocodeLimaMeasure("));
    const toggle = ACTIONS.slice(ACTIONS.indexOf("export async function setRetryGeocode"), ACTIONS.indexOf("export interface LimaGeocodeMeasureResult"));
    expect(toggle).toContain("await gate(orgId)");
    expect(toggle).toContain("geocodeLimaGate(latest?.summary ?? null)");
    expect(toggle).toContain("if (on) {");
    expect(toggle).toContain("automation: RETRY_GEOCODE_EVENT");
  });
});

// ---------------------------------------------------------------------------
// La medición de Lima no se confirma sola y tiene tope por día (05-11-2026)
// ---------------------------------------------------------------------------

describe("el pin del Master que es el punto de Google", () => {
  it("a 5 m o menos del punto bueno de la caché es Google; una corrección a mano nunca", async () => {
    const { masterPinIsGoogle, GEOCODE_SAME_PIN_METERS } = await import("@/lib/geocode-google");
    expect(GEOCODE_SAME_PIN_METERS).toBe(5);
    const google = { latitude: -12.1211, longitude: -77.0297 };
    expect(masterPinIsGoogle({ latitude: "-12.1211", longitude: "-77.0297", geo_source: "courier" }, google)).toBe(true);
    expect(masterPinIsGoogle({ latitude: -12.12112, longitude: -77.0297, geo_source: "courier" }, google)).toBe(true);
    // ~50 m: lo puso otra persona (el courier en la puerta, por ejemplo).
    expect(masterPinIsGoogle({ latitude: -12.1216, longitude: -77.0297, geo_source: "courier" }, google)).toBe(false);
    expect(masterPinIsGoogle({ latitude: -12.1211, longitude: -77.0297, geo_source: "manual" }, google)).toBe(false);
    expect(masterPinIsGoogle({ latitude: null, longitude: null }, google)).toBe(false);
    expect(masterPinIsGoogle({ latitude: -12.1211, longitude: -77.0297 }, null)).toBe(false);
  });
});

describe("runGeocodeLimaMeasure: sin los pins de Google y con 150 consultas por día", () => {
  function dayAdmin(tables: { order_master: Record<string, unknown>[]; order_geocodes?: Record<string, unknown>[]; runs?: Record<string, unknown>[] }) {
    const inserts: Record<string, unknown>[] = [];
    const client = {
      from(table: string) {
        const chain: Record<string, unknown> = {};
        let rangeFrom = 0;
        let rangeTo = Infinity;
        const filters: Array<(r: Record<string, unknown>) => boolean> = [];
        let ids: string[] | null = null;
        for (const m of ["select", "not", "order"]) chain[m] = () => chain;
        chain.eq = (c: string, v: unknown) => {
          filters.push((r) => r[c] === v);
          return chain;
        };
        chain.gte = (c: string, v: string) => {
          if (table === "geocode_pilot_runs") filters.push((r) => Date.parse(String(r[c])) >= Date.parse(v));
          return chain;
        };
        chain.in = (c: string, vs: string[]) => {
          if (c === "id") ids = vs;
          if (c === "order_id") filters.push((r) => vs.includes(String(r.order_id)));
          return chain;
        };
        chain.range = (a: number, b: number) => {
          rangeFrom = a;
          rangeTo = b;
          return chain;
        };
        chain.insert = async (row: Record<string, unknown>) => {
          if (table !== "geocode_pilot_runs") throw new Error(`escritura prohibida: ${table}`);
          inserts.push(row);
          return { error: null };
        };
        for (const w of ["update", "upsert", "delete", "rpc"]) {
          chain[w] = () => {
            throw new Error(`escritura prohibida: ${table}.${w}`);
          };
        }
        chain.then = (res: (v: unknown) => unknown) => {
          let data: unknown[];
          if (table === "order_master") data = tables.order_master.slice(rangeFrom, rangeTo + 1);
          else if (table === "orders") data = (ids ?? []).map((id) => ({ id }));
          else if (table === "order_geocodes") data = (tables.order_geocodes ?? []).filter((r) => filters.every((f) => f(r)));
          else if (table === "geocode_pilot_runs") data = (tables.runs ?? []).filter((r) => filters.every((f) => f(r)));
          else data = [];
          return Promise.resolve({ data, error: null }).then(res);
        };
        return chain;
      },
    };
    return { client: client as never, inserts };
  }

  const limaRow = (i: number, extra: Record<string, unknown> = {}) => ({
    order_id: `L${i}`, coverage: "lima", address: `Av. Larco ${100 + i}`, district: "Miraflores", province: "Lima", region: "Lima",
    latitude: -12.1211, longitude: -77.0297, geo_source: "courier", ...extra,
  });
  const NOW = new Date("2026-11-05T20:00:00Z"); // 15:00 en Lima

  it("un pedido cuyo pin es su punto de Google (una guía automática) no entra a la muestra", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.doUnmock("@/lib/geocode-google-server");
    vi.resetModules();
    const { runGeocodeLimaMeasure } = await import("@/lib/geocode-google-server");
    const rows = [limaRow(0), limaRow(1), limaRow(2, { geo_source: "manual" }), limaRow(3)];
    const order_geocodes = [
      // L0: el pin del Master es el de Google → fuera.
      { order_id: "L0", ok: true, latitude: -12.1211, longitude: -77.0297 },
      // L1: Google dio otro punto (a ~50 m): el pin es de una persona → entra.
      { order_id: "L1", ok: true, latitude: -12.1216, longitude: -77.0297 },
      // L2: corrección a mano igual al punto de Google → entra.
      { order_id: "L2", ok: true, latitude: -12.1211, longitude: -77.0297 },
    ];
    const { client } = dayAdmin({ order_master: rows, order_geocodes });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(googleOk(-12.1212, -77.0297, "Miraflores", "Provincia de Lima")), { status: 200 }));
    const run = await runGeocodeLimaMeasure(client, { orgId: "org-1", storeIds: ["s1"], key: "k", actor: null, fetchImpl: fetchImpl as never, now: NOW });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(run.summary.sampled).toBe(3);
  });

  it("descuenta lo que ya gastaron las mediciones de hoy; ayer no cuenta", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { runGeocodeLimaMeasure } = await import("@/lib/geocode-google-server");
    const rows = Array.from({ length: 200 }, (_, i) => limaRow(i));
    const runs = [
      { org_id: "org-1", coverage: "lima", created_at: "2026-11-05T14:00:00Z", summary: { apiCalls: 120 } },
      { org_id: "org-1", coverage: "lima", created_at: "2026-11-05T04:00:00Z", summary: { apiCalls: 150 } }, // 23:00 de ayer en Lima
      { org_id: "org-2", coverage: "lima", created_at: "2026-11-05T14:00:00Z", summary: { apiCalls: 150 } },
    ];
    const { client, inserts } = dayAdmin({ order_master: rows, runs });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(googleOk(-12.1212, -77.0297, "Miraflores", "Provincia de Lima")), { status: 200 }));
    const run = await runGeocodeLimaMeasure(client, { orgId: "org-1", storeIds: ["s1"], key: "k", actor: null, fetchImpl: fetchImpl as never, now: NOW });
    expect(run.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(30);
    expect(inserts[0]).toMatchObject({ summary: expect.objectContaining({ apiCalls: 30, cap: 30 }) });
  });

  it("con las 150 de hoy gastadas no consulta nada y lo dice", async () => {
    const { runGeocodeLimaMeasure } = await import("@/lib/geocode-google-server");
    const runs = [
      { org_id: "org-1", coverage: "lima", created_at: "2026-11-05T14:00:00Z", summary: { apiCalls: 100 } },
      { org_id: "org-1", coverage: "lima", created_at: "2026-11-05T15:00:00Z", summary: { apiCalls: 50 } },
    ];
    const { client, inserts } = dayAdmin({ order_master: [limaRow(0)], runs });
    const fetchImpl = vi.fn();
    const run = await runGeocodeLimaMeasure(client, { orgId: "org-1", storeIds: ["s1"], key: "k", actor: null, fetchImpl: fetchImpl as never, now: NOW });
    expect(run).toEqual({ ok: false, error: "Ya se usaron las 150 consultas de hoy para medir Lima; vuelve mañana." });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });
});
