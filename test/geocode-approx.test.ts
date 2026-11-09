// «Aceptar ubicación aproximada en la calle correcta» (Confirmación por Chatby,
// MOM §6.1 y §40; owner, 08-11-2026; 0316): la reja de la calle, qué hace
// cada posición (Apagado / Simulación / Activo), la caché de Google con el
// punto aproximado, la medición contra el punto del motorizado y su cuenta
// (mediana y % a menos de 150 m), y que el panel, el servidor, la migración,
// el MOM y DEPLOY digan lo mismo. Sin red ni base real.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  APPROX_COORDINATE_NOTE,
  APPROX_NEAR_METERS,
  approxDecision,
  approxModeFrom,
  approxReference,
  approxSummary,
  approxSummaryLine,
  geocodeApproxStreet,
  mapsHref,
  type ApproxReference,
} from "@/lib/geocode-approx";
import { haversineMeters, type GeocodeResult } from "@/lib/geocode-google";
import { chatbyAutoSettingsFrom } from "@/lib/chatby-autoconfirm";
import {
  AUTOMATIONS,
  AUTOMATION_WRITE_WHITELIST,
  CHATBY_APPROX_KEY,
  automationEventLabel,
  automationValueLabel,
  isSwitchable,
  switchableEntry,
} from "@/lib/automations-catalog";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

/** Lo que Google devuelve para «Jirón José Olaya 245», Ayacucho, Huamanga (#KP204092). */
function olaya(overrides: Partial<{ route: string; short: string; number: string | null; province: string | null }> = {}): GeocodeResult {
  const route = overrides.route ?? "Jirón José Olaya";
  const components = [
    ...(overrides.number === null ? [] : [{ long_name: overrides.number ?? "245", short_name: overrides.number ?? "245", types: ["street_number"] }]),
    { long_name: route, short_name: overrides.short ?? "Jr. José Olaya", types: ["route"] },
    { long_name: "Ayacucho", short_name: "Ayacucho", types: ["administrative_area_level_3", "political"] },
    ...(overrides.province === null
      ? []
      : [{ long_name: overrides.province ?? "Huamanga", short_name: overrides.province ?? "Huamanga", types: ["administrative_area_level_2", "political"] }]),
    { long_name: "Ayacucho", short_name: "Ayacucho", types: ["administrative_area_level_1", "political"] },
  ];
  return { lat: -13.1597, lng: -74.2236, locationType: "RANGE_INTERPOLATED", partialMatch: false, components };
}
const ORDER = { address: "Jirón José Olaya 245", province: "Huamanga" };

describe("la reja de la calle", () => {
  it("#KP204092: misma calle, mismo número y misma provincia pasa", () => {
    expect(geocodeApproxStreet(olaya(), ORDER)).toEqual({ ok: true });
  });

  it("«Jr.» es «Jirón», sin tildes ni mayúsculas, con «N°» y la z igual a la s", () => {
    expect(geocodeApproxStreet(olaya(), { address: "jr jose olaya n° 245", province: "huamanga" })).toEqual({ ok: true });
    expect(geocodeApproxStreet(olaya(), { address: "Jr.José Olaya Nro. 245 - 2do piso", province: "Huamanga" })).toEqual({ ok: true });
    const nunez = olaya({ route: "Jirón Mariano Núñez", short: "Jr. Mariano Núñez", number: "644", province: "San Román" });
    expect(geocodeApproxStreet(nunez, { address: "Jr. Mariano Nuñes 644", province: "San Roman" })).toEqual({ ok: true });
    expect(geocodeApproxStreet(olaya({ province: "Provincia de Huamanga" }), ORDER)).toEqual({ ok: true });
  });

  it("otra calle, otro número u otra provincia: no", () => {
    expect(geocodeApproxStreet(olaya(), { address: "Jirón Bellido 245", province: "Huamanga" })).toEqual({ ok: false, reason: "otra_calle" });
    // Ante la duda, no: una inicial no es el nombre.
    expect(geocodeApproxStreet(olaya(), { address: "Jr. J. Olaya 245", province: "Huamanga" })).toEqual({ ok: false, reason: "otra_calle" });
    expect(geocodeApproxStreet(olaya(), { address: "Jirón José Olaya 425", province: "Huamanga" })).toEqual({ ok: false, reason: "otro_numero" });
    expect(geocodeApproxStreet(olaya(), { address: "Jirón José Olaya 245", province: "Huanta" })).toEqual({ ok: false, reason: "otra_provincia" });
    expect(geocodeApproxStreet(olaya(), { address: "Jirón José Olaya 245", province: null })).toEqual({ ok: false, reason: "otra_provincia" });
    expect(geocodeApproxStreet(olaya({ province: null }), ORDER)).toEqual({ ok: false, reason: "otra_provincia" });
  });

  it("sin la calle o el número de Google: no", () => {
    expect(geocodeApproxStreet(olaya({ number: null }), ORDER)).toEqual({ ok: false, reason: "sin_calle" });
    expect(geocodeApproxStreet({ ...olaya(), components: olaya().components.filter((c) => !c.types.includes("route")) }, ORDER)).toEqual({
      ok: false,
      reason: "sin_calle",
    });
    // Una «calle» que solo es el tipo de vía no nombra nada.
    expect(geocodeApproxStreet(olaya({ route: "Calle", short: "Calle" }), ORDER)).toEqual({ ok: false, reason: "sin_calle" });
  });
});

describe("qué hace cada posición", () => {
  const approx = { lat: -13.1597, lng: -74.2236 };
  const rooftop = { kind: "ok" as const, lat: -13.15, lng: -74.22 };

  it("el edificio se usa siempre, en cualquier posición", () => {
    for (const mode of ["apagado", "simulacion", "activo"] as const) {
      expect(approxDecision(mode, rooftop)).toEqual({ use: "edificio", lat: -13.15, lng: -74.22 });
    }
  });

  it("Apagado: el punto aproximado no cuenta; lo de hoy", () => {
    expect(approxDecision("apagado", { kind: "rejected", approx })).toEqual({ use: "ninguna", simulated: false });
  });

  it("Simulación: no se usa, el pedido queda para la asesora, y queda la marca de que habría confirmado", () => {
    expect(approxDecision("simulacion", { kind: "rejected", approx })).toEqual({ use: "ninguna", simulated: true });
  });

  it("Activo: se usa como coordenada de la guía", () => {
    expect(approxDecision("activo", { kind: "rejected", approx })).toEqual({ use: "aproximada", ...approx });
  });

  it("sin punto que pase la reja, ninguna posición inventa uno", () => {
    for (const mode of ["apagado", "simulacion", "activo"] as const) {
      expect(approxDecision(mode, { kind: "rejected", approx: null })).toEqual({ use: "ninguna", simulated: false });
      expect(approxDecision(mode, { kind: "rejected" })).toEqual({ use: "ninguna", simulated: false });
      expect(approxDecision(mode, { kind: "unavailable" })).toEqual({ use: "ninguna", simulated: false });
    }
  });

  it("la posición: sin la columna o con un valor raro, Apagado", () => {
    expect(approxModeFrom(undefined)).toBe("apagado");
    expect(approxModeFrom("off")).toBe("apagado");
    expect(approxModeFrom("activo")).toBe("activo");
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: true })?.approx_mode).toBe("apagado");
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: true, approx_mode: "simulacion" })?.approx_mode).toBe("simulacion");
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: true, approx_mode: "encendido" })?.approx_mode).toBe("apagado");
  });
});

// ─── La caché de Google con el punto aproximado ─────────────────────────────

function googleResponse(result: GeocodeResult) {
  return {
    status: "OK",
    results: [
      {
        address_components: result.components,
        geometry: { location: { lat: result.lat, lng: result.lng }, location_type: result.locationType },
        partial_match: result.partialMatch,
      },
    ],
  };
}

function cacheAdmin(initial: Record<string, unknown> | null, opts: { failApproxSave?: boolean } = {}) {
  const state = { row: initial, upserts: [] as Record<string, unknown>[] };
  const client = {
    from() {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: state.row, error: null });
      chain.upsert = (row: Record<string, unknown>) => {
        state.upserts.push(row);
        if (opts.failApproxSave && "approx_kind" in row) return Promise.resolve({ error: { code: "PGRST204", message: "Could not find the 'approx_kind' column" } });
        state.row = row;
        return Promise.resolve({ error: null });
      };
      return chain;
    },
  };
  return { client: client as never, state };
}

const AYACUCHO = { order_id: "o1", store_id: "s1", address: "Jirón José Olaya 245", district: "Ayacucho", province: "Huamanga", region: "Ayacucho" };

describe("geocodeOrderAddress con la ubicación aproximada (0316)", () => {
  it("sin pedirlo, la cuadra se rechaza y no se guarda nada de la calle (los reintentos de Lima no cambian)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const { client, state } = cacheAdmin(null);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(googleResponse(olaya())), { status: 200 }));
    const geo = await geocodeOrderAddress(client, AYACUCHO, { key: "k", fetchImpl: fetchImpl as never });
    expect(geo).toEqual({ kind: "rejected", reason: "impreciso", precision: "RANGE_INTERPOLATED", cached: false });
    expect(state.upserts[0]).toMatchObject({ ok: false, precision: "RANGE_INTERPOLATED", latitude: null, reason: "no_es_edificio" });
    expect(Object.keys(state.upserts[0]!).some((k) => k.startsWith("approx_"))).toBe(false);
  });

  it("pidiéndolo, guarda el punto de la calle correcta y lo devuelve; el edificio sigue vacío", async () => {
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const { client, state } = cacheAdmin(null);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(googleResponse(olaya())), { status: 200 }));
    const geo = await geocodeOrderAddress(client, AYACUCHO, { key: "k", fetchImpl: fetchImpl as never, approxMode: "simulacion" });
    expect(geo).toMatchObject({ kind: "rejected", precision: "RANGE_INTERPOLATED", approx: { lat: -13.1597, lng: -74.2236 } });
    expect(state.upserts[0]).toMatchObject({
      ok: false,
      latitude: null,
      longitude: null,
      approx_kind: "calle",
      approx_latitude: -13.1597,
      approx_longitude: -74.2236,
      approx_mode: "simulacion",
    });
    // La pasada siguiente usa lo guardado: no vuelve a gastar la consulta.
    const again = await geocodeOrderAddress(client, AYACUCHO, { key: "k", fetchImpl: fetchImpl as never, approxMode: "activo" });
    expect(again).toMatchObject({ kind: "rejected", cached: true, approx: { lat: -13.1597, lng: -74.2236 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Y sin pedirlo, lo guardado no sale.
    const off = await geocodeOrderAddress(client, AYACUCHO, { key: "k", fetchImpl: fetchImpl as never });
    expect(off).toEqual({ kind: "rejected", reason: "no_es_edificio", cached: true });
  });

  it("otra calle: guarda el motivo, sin punto", async () => {
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const { client, state } = cacheAdmin(null);
    const other = olaya({ route: "Jirón Bellido", short: "Jr. Bellido" });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(googleResponse(other)), { status: 200 }));
    const geo = await geocodeOrderAddress(client, AYACUCHO, { key: "k", fetchImpl: fetchImpl as never, approxMode: "activo" });
    expect(geo).toMatchObject({ kind: "rejected", approx: null });
    expect(state.upserts[0]).toMatchObject({ approx_kind: "otra_calle", approx_latitude: null, approx_longitude: null });
  });

  it("una fila de antes con la cuadra y sin veredicto de la calle se vuelve a consultar una vez", async () => {
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const first = cacheAdmin(null);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(googleResponse(olaya())), { status: 200 }));
    await geocodeOrderAddress(first.client, AYACUCHO, { key: "k", fetchImpl: fetchImpl as never });
    const old = { ...first.state.row!, approx_kind: null, approx_latitude: null, approx_longitude: null };
    const { client } = cacheAdmin(old);
    const geo = await geocodeOrderAddress(client, AYACUCHO, { key: "k", fetchImpl: fetchImpl as never, approxMode: "simulacion" });
    expect(geo).toMatchObject({ approx: { lat: -13.1597, lng: -74.2236 }, cached: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Sin la 0316 (la fila no trae las columnas) no se vuelve a consultar.
    const legacy = cacheAdmin({ ...first.state.row! });
    await geocodeOrderAddress(legacy.client, AYACUCHO, { key: "k", fetchImpl: fetchImpl as never, approxMode: "simulacion" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("si la base no tiene las columnas, guarda lo de siempre para no volver a gastar la consulta", async () => {
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const { client, state } = cacheAdmin(null, { failApproxSave: true });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(googleResponse(olaya())), { status: 200 }));
    await geocodeOrderAddress(client, AYACUCHO, { key: "k", fetchImpl: fetchImpl as never, approxMode: "simulacion" });
    // Con lo de la 0325, con lo de la 0316 y, al final, lo de siempre (test/geocode-calle-sufijo.test.ts).
    expect(state.upserts).toHaveLength(3);
    expect(state.row).toMatchObject({ reason: "no_es_edificio" });
    expect(Object.keys(state.row!).some((k) => k.startsWith("approx_"))).toBe(false);
  });

  it("el punto aproximado también es «de Google» para las mediciones y los reintentos", async () => {
    const { googlePinnedOrderIds } = await import("@/lib/geocode-google-server");
    const rows = [
      { order_id: "a", ok: false, latitude: null, longitude: null, approx_kind: "calle", approx_latitude: -13.1597, approx_longitude: -74.2236 },
      { order_id: "b", ok: false, latitude: null, longitude: null, approx_kind: "otra_calle", approx_latitude: null, approx_longitude: null },
    ];
    const client = {
      from() {
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "in", "eq"]) chain[m] = () => chain;
        chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res);
        return chain;
      },
    };
    const pinned = await googlePinnedOrderIds(client as never, [
      { order_id: "a", latitude: -13.1597, longitude: -74.2236, geo_source: "courier" },
      { order_id: "b", latitude: -13.1597, longitude: -74.2236, geo_source: "courier" },
    ]);
    expect([...pinned]).toEqual(["a"]);
  });
});

// ─── La medición ─────────────────────────────────────────────────────────────

describe("la medición contra el punto del motorizado", () => {
  const approx = { lat: -13.1597, lng: -74.2236, usedAt: null };
  const ship = (o: Partial<{ delivery_status: string; aliclik_attempts: number; latitude: number | null; longitude: number | null; created_at: string }> = {}) => ({
    delivery_status: "entregado",
    aliclik_attempts: 1,
    latitude: -13.1607,
    longitude: -74.2236,
    created_at: "2026-11-08T15:00:00Z",
    ...o,
  });

  it("todavía sin entregar ni intentar: «aún no entregado»", () => {
    expect(approxReference(approx, [])).toEqual({ state: "sin_entregar" });
    expect(approxReference(approx, [ship({ delivery_status: "en_ruta", aliclik_attempts: 0 })])).toEqual({ state: "sin_entregar" });
  });

  it("entregado o intentado: la distancia, en metros (haversine)", () => {
    const r = approxReference(approx, [ship()]);
    expect(r.state).toBe("medido");
    if (r.state !== "medido") return;
    expect(r.distanceM).toBeCloseTo(haversineMeters(approx, { lat: -13.1607, lng: -74.2236 }), 6);
    expect(Math.round(r.distanceM)).toBe(111);
    // Un intento fallido también mide.
    expect(approxReference(approx, [ship({ delivery_status: "en_ruta", aliclik_attempts: 2 })]).state).toBe("medido");
  });

  it("prefiere la guía entregada y, si no, la más reciente; sin coordenada no mide", () => {
    const older = ship({ delivery_status: "anulado", aliclik_attempts: 1, latitude: -13.2, created_at: "2026-11-05T15:00:00Z" });
    const delivered = ship({ latitude: -13.1607, created_at: "2026-11-01T15:00:00Z" });
    const r = approxReference(approx, [older, delivered]);
    expect(r.state === "medido" && r.point.lat).toBe(-13.1607);
    expect(approxReference(approx, [ship({ latitude: null, longitude: null })])).toEqual({ state: "sin_punto" });
  });

  it("la guía que se creó con el propio punto (Activo) no mide: es el punto que mandó Kapta", () => {
    const used = { ...approx, usedAt: "2026-11-08T14:58:00Z" };
    // Aliclik devuelve en su reporte la coordenada que le mandamos, a veces corrida unos metros.
    const own = ship({ latitude: -13.1599, created_at: "2026-11-08T15:00:00Z" });
    expect(approxReference(used, [own]).state).toBe("mismo_punto");
    // Una guía creada después, por una persona, sí mide.
    const later = ship({ created_at: "2026-11-09T15:00:00Z" });
    expect(approxReference(used, [later]).state).toBe("medido");
    // Y un punto igual al aproximado (a 5 m o menos) nunca mide, se haya marcado o no.
    expect(approxReference(approx, [ship({ latitude: -13.1597, longitude: -74.2236 })]).state).toBe("mismo_punto");
  });

  it("la cuenta: medidos, a menos de 150 m (% de los medidos) y la mediana", () => {
    const at = (distanceM: number): ApproxReference => ({ state: "medido", point: { lat: 0, lng: 0 }, distanceM });
    const refs: ApproxReference[] = [at(40), at(149.9), at(150), at(600), { state: "sin_entregar" }, { state: "mismo_punto", point: { lat: 0, lng: 0 } }];
    const s = approxSummary(refs);
    expect(s).toEqual({ total: 6, measured: 4, near: 2, nearPct: 50, medianM: (149.9 + 150) / 2, pending: 1 });
    expect(approxSummaryLine(s)).toBe(`4 pedidos medidos · 2 a menos de ${APPROX_NEAR_METERS} m · distancia típica 150 m`);
    expect(approxSummary([at(80), at(20), at(300)]).medianM).toBe(80);
    expect(approxSummaryLine(approxSummary([at(80)]))).toBe("1 pedido medido · 1 a menos de 150 m · distancia típica 80 m");
    expect(approxSummary([])).toEqual({ total: 0, measured: 0, near: 0, nearPct: null, medianM: null, pending: 0 });
    expect(approxSummaryLine(approxSummary([]))).toBe("0 pedidos medidos todavía");
    expect(mapsHref({ lat: -13.1597, lng: -74.2236 })).toBe("https://www.google.com/maps?q=-13.1597,-74.2236");
  });

  it("el panel lee los puntos, su fila del Master y sus guías de Aliclik, sin escribir", async () => {
    const { loadApproxRows } = await import("@/lib/chatby-approx-server");
    const tables: Record<string, Record<string, unknown>[]> = {
      order_geocodes: [
        { order_id: "o1", approx_latitude: -13.1597, approx_longitude: -74.2236, approx_mode: "simulacion", approx_used_at: null },
        { order_id: "o2", approx_latitude: -6.77, approx_longitude: -79.84, approx_mode: "activo", approx_used_at: "2026-11-08T10:00:00Z" },
      ],
      order_master: [
        { order_id: "o1", order_name: "#KP204092", address: "Jirón José Olaya 245" },
        { order_id: "o2", order_name: "#KP204099", address: "Av. quiñones N° 546" },
      ],
      shipments: [{ order_id: "o1", delivery_status: "entregado", aliclik_attempts: 1, latitude: -13.1607, longitude: -74.2236, created_at: "2026-11-09T10:00:00Z" }],
    };
    const seen: string[] = [];
    const client = {
      from(table: string) {
        seen.push(table);
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "in", "eq", "order", "limit"]) chain[m] = () => chain;
        for (const w of ["insert", "update", "upsert", "delete"]) {
          chain[w] = () => {
            throw new Error(`escritura prohibida: ${table}.${w}`);
          };
        }
        chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(res);
        return chain;
      },
    };
    const rows = await loadApproxRows(client as never, ["s1"]);
    expect(rows.map((r) => [r.orderName, r.mode, r.reference.state])).toEqual([
      ["#KP204092", "simulacion", "medido"],
      ["#KP204099", "activo", "sin_entregar"],
    ]);
    expect(new Set(seen)).toEqual(new Set(["order_geocodes", "order_master", "shipments"]));
  });
});

// ─── El servidor, el panel, la migración, el MOM y DEPLOY ───────────────────

describe("la guía automática de Chatby con la ubicación aproximada", () => {
  const server = read("lib/chatby-autoconfirm-server.ts");

  it("la posición sale de los ajustes y decide `approxDecision`; Google sigue sin consultarse en dry", () => {
    expect(server).toContain("approxMode: settings.approx_mode");
    expect(server).toContain("const decision = approxDecision(g.approxMode, geo);");
    expect(server).toContain('g.geocodeKey && !g.dry && row.coverage === "provincia_cod"');
    expect(server).toContain("{ key: g.geocodeKey, approxMode }");
  });

  it("Simulación: queda para la asesora con el mismo motivo de siempre", () => {
    expect(server).toMatch(/if \(decision\.use === "ninguna"\) \{[\s\S]*?return \{ kind: "hold", reason: "sin_ubicacion", detail: null, state: "para_persona" \};/);
  });

  it("Activo: la guía dice de dónde salió la coordenada y queda marcada para la medición", () => {
    expect(server).toContain('source = decision.use === "aproximada" ? "google_aprox" : "google";');
    expect(server).toContain('if (source === "google_aprox") return APPROX_COORDINATE_NOTE;');
    expect(APPROX_COORDINATE_NOTE).toBe("coordenada: dirección en Google (aproximada en la calle)");
    expect(server).toContain("await markApproxUsed(admin, row.order_id);");
  });

  it("los reintentos de Lima no la piden: siguen solo con el edificio", () => {
    const retry = read("lib/lima-retry-auto-server.ts");
    expect(retry).not.toContain("approxMode");
  });
});

describe("el panel Automatizaciones", () => {
  const entry = AUTOMATIONS.find((e) => e.key === CHATBY_APPROX_KEY)!;

  it("está en «Confirmación», junto a Chatby, con sus tres posiciones y fuera de la lista blanca de encendido/apagado", () => {
    expect(entry.group).toBe("confirmacion");
    expect(entry.control).toEqual({ kind: "org_mode", table: "chatby_auto_settings", column: "approx_mode" });
    const keys = AUTOMATIONS.map((e) => e.key);
    expect(keys.indexOf(CHATBY_APPROX_KEY)).toBe(keys.indexOf("chatby_auto_guide") + 1);
    expect(isSwitchable(entry)).toBe(false);
    expect(AUTOMATION_WRITE_WHITELIST.some((w) => w.column === "approx_mode")).toBe(false);
    expect(switchableEntry(CHATBY_APPROX_KEY, "org_table")).toBeNull();
  });

  it("el historial lo nombra y dice la posición en palabras", () => {
    expect(automationEventLabel(CHATBY_APPROX_KEY)).toBe("Aceptar ubicación aproximada en la calle correcta");
    expect(automationValueLabel(CHATBY_APPROX_KEY, "simulacion")).toBe("Simulación");
    expect(automationValueLabel(CHATBY_APPROX_KEY, "activo")).toBe("Activo");
  });

  it("la acción solo escribe la columna de la posición, de una fila que existe, y deja su historial", () => {
    const actions = read("app/dashboard/automatizaciones/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function setChatbyApproxMode("));
    expect(fn).toContain("if (!isApproxMode(mode))");
    expect(fn).toContain("const g = await gate(orgId);");
    expect(fn).toContain('.update({ approx_mode: mode, updated_by: g.actor, updated_at: new Date().toISOString() })');
    expect(fn).toContain('"Falta la migración 0316 en la base de datos."');
    expect(fn).toContain("automation: CHATBY_APPROX_KEY");
  });

  it("la fila usa el control de tres posiciones, Activo pide confirmación, y la prueba va al lado", () => {
    const panel = read("components/automations-panel.tsx");
    expect(panel).toContain('entry.control.kind === "org_mode" ? (');
    expect(panel).toContain("<ModeControl value={mode} label={entry.name}");
    expect(panel).toMatch(/next === "activo" &&\s*!window\.confirm\(\s*"¿Poner en Activo la ubicación aproximada\?/);
    expect(panel).toContain('{group.key === "confirmacion" && <ApproxTestCard view={org.chatbyApprox} />}');
    for (const head of ["Pedido", "Dirección", "Punto aproximado", "Dónde estuvo el motorizado", "Distancia"]) expect(panel).toContain(`>${head}</th>`);
    expect(panel).toContain("Aún no entregado");
    expect(panel).toContain('title="Prueba de ubicación aproximada"');
    expect(panel).toContain("href={`/dashboard/pedidos?abrir=${r.orderId}`}");
  });
});

describe("la migración 0316", () => {
  const sql = read("db/migrations/0316_chatby_approx_location.sql");
  it("la posición nace apagada y solo con sus tres valores", () => {
    expect(sql).toContain("add column if not exists approx_mode text not null default 'apagado'");
    expect(sql).toContain("check (approx_mode in ('apagado', 'simulacion', 'activo'))");
  });
  it("el punto aproximado va aparte del edificio, y solo con «calle»", () => {
    for (const col of ["approx_kind", "approx_latitude", "approx_longitude", "approx_mode", "approx_checked_at", "approx_used_at"]) {
      expect(sql).toContain(`add column if not exists ${col}`);
    }
    expect(sql).toContain("(approx_kind = 'calle' and approx_latitude is not null and approx_longitude is not null)");
    expect(read("scripts/verify-db.sh")).toContain("scripts/sql/chatby_approx_location_smoke.sql");
  });
});

describe("el MOM y DEPLOY", () => {
  const mom = flat(read("docs/mom/master-pedidos-v1.md"));
  const deploy = read("DEPLOY.md");

  it("el MOM la documenta como automatización con sus tres posiciones, sin estados nuevos", () => {
    expect(mom).toContain("**Aceptar ubicación aproximada en la calle correcta (owner, 08-11-2026; 0316).**");
    expect(mom).toContain("**Apagado** (nace así)");
    expect(mom).toContain("**Simulación**");
    expect(mom).toContain("**Activo**");
    expect(mom).toContain("«coordenada: dirección en Google (aproximada en la calle)»");
    expect(mom).toContain("No agrega estados ni subetapas");
  });

  it("DEPLOY la pone arriba, con la migración, qué mirar y la marcha atrás", () => {
    const title = "### 08-11-2026 · Confirmación por Chatby: prueba de ubicación aproximada (Apagado/Simulación/Activo) (0316, MOM §6.1 y §40)";
    // Arriba de la 0313: lo más nuevo primero (sin exigir que siga siendo la primera).
    expect(deploy.indexOf(title)).toBeGreaterThan(-1);
    expect(deploy.indexOf(title)).toBeLessThan(deploy.indexOf("### 08-11-2026 · «Llamar con Anura»"));
    const entry = deploy.slice(deploy.indexOf(title)).split(/\n### /)[0]!;
    expect(entry).toContain("`0316_chatby_approx_location.sql`");
    expect(entry).toContain("**Qué mirar después.**");
    expect(entry).toContain("**Marcha atrás.**");
  });
});
