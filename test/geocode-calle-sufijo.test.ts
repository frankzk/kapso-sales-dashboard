// La reja de la calle acepta el sufijo (0325, MOM §6.1 y §38; owner,
// 09-11-2026): la clienta que no escribe el nombre de pila de la calle
// («Av. Quiñones» por «Avenida José Quiñones», #KP204099). Además: lo que
// dijo Google se guarda en la caché, el `otra_calle` de la reja vieja se
// vuelve a consultar una vez (solo desde la guía automática de Chatby), y la
// ficha dice qué encontró Google y por qué no se usó. Sin red ni base real.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  APPROX_STREET_RULE,
  approxStreetNameMatch,
  geocodeApproxStreet,
  orderStreetCore,
} from "@/lib/geocode-approx";
import { geocodeSafeguard, type GeocodeResult } from "@/lib/geocode-google";
import {
  chatbyAskExplanation,
  chatbyAskTitle,
  chatbyGoogleFindingText,
  googleLabelShort,
  type ChatbyGoogleFinding,
} from "@/lib/chatby-location-ask";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

/** Un resultado de Google con la cuadra, en la calle, el número y la provincia que se pidan. */
function google(o: { route: string; short?: string; number?: string; province: string; district?: string; region?: string; label?: string }): GeocodeResult {
  return {
    lat: -6.7714,
    lng: -79.8409,
    locationType: "RANGE_INTERPOLATED",
    partialMatch: false,
    formattedAddress: o.label,
    components: [
      { long_name: o.number ?? "546", short_name: o.number ?? "546", types: ["street_number"] },
      { long_name: o.route, short_name: o.short ?? o.route, types: ["route"] },
      { long_name: o.district ?? o.province, short_name: o.district ?? o.province, types: ["administrative_area_level_3", "political"] },
      { long_name: o.province, short_name: o.province, types: ["administrative_area_level_2", "political"] },
      { long_name: o.region ?? "Lambayeque", short_name: o.region ?? "Lambayeque", types: ["administrative_area_level_1", "political"] },
    ],
  };
}

/** Lo que Google devuelve para #KP204099: «Av. José Quiñones 546, Chiclayo 14001». */
const QUINONES = google({
  route: "Avenida José Quiñones",
  short: "Av. José Quiñones",
  number: "546",
  province: "Chiclayo",
  label: "Av. José Quiñones 546, Chiclayo 14001, Perú",
});
const KP204099 = {
  order_id: "ec68",
  store_id: "kenku",
  address: "Av. quiñones N° 546",
  district: "Chiclayo",
  province: "Chiclayo",
  region: "Lambayeque",
};

describe("el nombre de la calle que escribió la clienta", () => {
  it("sin el tipo de vía ni los rellenos, hasta el número o la coma", () => {
    expect(orderStreetCore("Av. quiñones N° 546")).toEqual(["quinones"]);
    expect(orderStreetCore("Av. quiñones N° 546, Lambayeque, Chiclayo")).toEqual(["quinones"]);
    expect(orderStreetCore("Av. Quiñones, Lambayeque")).toEqual(["quinones"]);
    expect(orderStreetCore("Jr. José Olaya Nro. 245 - 2do piso")).toEqual(["jose", "olaya"]);
    expect(orderStreetCore("Calle de la Merced 12")).toEqual(["merced"]);
    expect(orderStreetCore("Jr. Panana#745 el tambo")).toEqual(["panana"]);
  });

  it("si empieza por el número o no trae calle, queda vacío", () => {
    expect(orderStreetCore("229 jr billinghurst")).toEqual([]);
    expect(orderStreetCore("Jr. 28 de julio 134")).toEqual([]);
    expect(orderStreetCore("")).toEqual([]);
    expect(orderStreetCore(null)).toEqual([]);
  });
});

describe("el sufijo: la clienta no escribió el nombre de pila", () => {
  const route = (long: string, short = long) => ({ long_name: long, short_name: short });

  it.each([
    ["Av. Quiñones 546", "Avenida José Quiñones"],
    ["Av. Balta 123", "Avenida José Balta"],
    ["Av. Grau", "Avenida Miguel Grau"],
    ["Av. Leguía", "Avenida Augusto B. Leguía"],
  ])("«%s» es «%s»", (address, long) => {
    expect(approxStreetNameMatch(route(long), address)).toBe("sufijo");
  });

  it.each([
    ["Av. Perú 123", "Avenida Perú Libre"],
    ["Calle Lima 5", "Jirón Lima Norte"],
  ])("«%s» no es «%s» (no es el final del nombre)", (address, long) => {
    expect(approxStreetNameMatch(route(long), address)).toBeNull();
  });

  it("alguna palabra con 4 letras o más; una inicial no es el nombre; y lo de antes sigue igual", () => {
    // «Paz» solo tiene 3 letras: no basta para decir que es la misma calle.
    expect(approxStreetNameMatch(route("Avenida José Paz"), "Av. Paz 12")).toBeNull();
    // «J. Olaya» no es «José Olaya» (0316): ni todas las palabras ni el final.
    expect(approxStreetNameMatch(route("Jirón José Olaya"), "Jr. J. Olaya 245")).toBeNull();
    // El nombre entero sigue valiendo, en cualquier orden (0316).
    expect(approxStreetNameMatch(route("Jirón José Olaya"), "Jirón José Olaya 245")).toBe("todas");
    // Más palabras que las de Google no son un sufijo.
    expect(approxStreetNameMatch(route("Avenida Quiñones"), "Av. José Quiñones 546")).toBe("todas");
    // El nombre corto de Google también sirve.
    expect(approxStreetNameMatch(route("Avenida Coronel José Balta", "Av. José Balta"), "Av. Balta 1")).toBe("sufijo");
    expect(approxStreetNameMatch(null, "Av. Balta 1")).toBeNull();
  });

  it("#KP204099: «Av. quiñones N° 546» con «Av. José Quiñones 546, Chiclayo» pasa la reja entera", () => {
    expect(geocodeApproxStreet(QUINONES, KP204099)).toEqual({ ok: true });
  });

  it("el número y la provincia se siguen pidiendo exactos", () => {
    expect(geocodeApproxStreet(QUINONES, { address: "Av. quiñones N° 645", province: "Chiclayo" })).toEqual({ ok: false, reason: "otro_numero" });
    expect(geocodeApproxStreet(QUINONES, { address: "Av. quiñones", province: "Chiclayo" })).toEqual({ ok: false, reason: "otro_numero" });
    expect(geocodeApproxStreet(QUINONES, { address: "Av. quiñones N° 546", province: "Lambayeque" })).toEqual({ ok: false, reason: "otra_provincia" });
    const grau = google({ route: "Avenida Miguel Grau", number: "321", province: "Piura", region: "Piura" });
    expect(geocodeApproxStreet(grau, { address: "Av. Grau 321", province: "Piura" })).toEqual({ ok: true });
    const leguia = google({ route: "Avenida Augusto B. Leguía", number: "880", province: "Chiclayo" });
    expect(geocodeApproxStreet(leguia, { address: "Av. Leguía 880", province: "Chiclayo" })).toEqual({ ok: true });
    const balta = google({ route: "Avenida José Balta", number: "123", province: "Chiclayo" });
    expect(geocodeApproxStreet(balta, { address: "Av. Balta 123", province: "Chiclayo" })).toEqual({ ok: true });
  });

  it("los que no son el final del nombre se siguen rechazando como otra calle", () => {
    const libre = google({ route: "Avenida Perú Libre", number: "123", province: "Chiclayo" });
    expect(geocodeApproxStreet(libre, { address: "Av. Perú 123", province: "Chiclayo" })).toEqual({ ok: false, reason: "otra_calle" });
    const norte = google({ route: "Jirón Lima Norte", number: "5", province: "Chiclayo" });
    expect(geocodeApproxStreet(norte, { address: "Calle Lima 5", province: "Chiclayo" })).toEqual({ ok: false, reason: "otra_calle" });
  });

  it("el edificio (ROOFTOP) no tiene reja de la calle: el candado no mira el nombre", () => {
    const rooftop = { ...QUINONES, locationType: "ROOFTOP" };
    expect(geocodeSafeguard(rooftop, KP204099)).toMatchObject({ ok: true, precision: "ROOFTOP" });
    expect(read("lib/geocode-google.ts")).not.toContain('"route"');
  });
});

// ─── La caché ────────────────────────────────────────────────────────────────

function googleResponse(result: GeocodeResult) {
  return {
    status: "OK",
    results: [
      {
        address_components: result.components,
        formatted_address: result.formattedAddress,
        geometry: { location: { lat: result.lat, lng: result.lng }, location_type: result.locationType },
        partial_match: result.partialMatch,
      },
    ],
  };
}

/** Una caché de una fila. `missing`: columnas que la base todavía no tiene (falla el upsert que las trae). */
function cacheAdmin(initial: Record<string, unknown> | null, missing: string[] = []) {
  const state = { row: initial, upserts: [] as Record<string, unknown>[] };
  const client = {
    from() {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: state.row, error: null });
      chain.upsert = (row: Record<string, unknown>) => {
        state.upserts.push(row);
        const col = missing.find((c) => c in row);
        if (col) return Promise.resolve({ error: { code: "PGRST204", message: `Could not find the '${col}' column` } });
        state.row = row;
        return Promise.resolve({ error: null });
      };
      return chain;
    },
  };
  return { client: client as never, state };
}

const fetchOf = (result: GeocodeResult) => vi.fn(async () => new Response(JSON.stringify(googleResponse(result)), { status: 200 }));

describe("lo que dijo Google se guarda en cada consulta (0325)", () => {
  it("la etiqueta, la calle y el número de Google, con el veredicto y la versión de la reja", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const { client, state } = cacheAdmin(null);
    const geo = await geocodeOrderAddress(client, KP204099, { key: "k", fetchImpl: fetchOf(QUINONES) as never, approxMode: "activo" });
    expect(geo).toMatchObject({ kind: "rejected", precision: "RANGE_INTERPOLATED", approx: { lat: -6.7714, lng: -79.8409 } });
    expect(state.upserts).toHaveLength(1);
    expect(state.row).toMatchObject({
      reason: "no_es_edificio",
      approx_kind: "calle",
      approx_rule: APPROX_STREET_RULE,
      google_label: "Av. José Quiñones 546, Chiclayo 14001, Perú",
      google_route: "Avenida José Quiñones",
      google_number: "546",
    });
  });

  it("también sin pedir la ubicación aproximada (los reintentos de Lima), sin tocar lo de la 0316", async () => {
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const { client, state } = cacheAdmin(null);
    await geocodeOrderAddress(client, KP204099, { key: "k", fetchImpl: fetchOf(QUINONES) as never });
    expect(state.row).toMatchObject({ google_route: "Avenida José Quiñones", google_number: "546" });
    expect(Object.keys(state.row!).some((k) => k.startsWith("approx_"))).toBe(false);
  });

  it("sin resultado, las tres en null", async () => {
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const { client, state } = cacheAdmin(null);
    const none = vi.fn(async () => new Response(JSON.stringify({ status: "ZERO_RESULTS", results: [] }), { status: 200 }));
    await geocodeOrderAddress(client, KP204099, { key: "k", fetchImpl: none as never, approxMode: "activo" });
    expect(state.row).toMatchObject({ reason: "sin_resultado", google_label: null, google_route: null, google_number: null });
  });

  it("sin la 0325 guarda lo de la 0316; sin la 0316, lo de siempre: nunca se pierde la consulta", async () => {
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const no0325 = cacheAdmin(null, ["google_label"]);
    await geocodeOrderAddress(no0325.client, KP204099, { key: "k", fetchImpl: fetchOf(QUINONES) as never, approxMode: "activo" });
    expect(no0325.state.upserts).toHaveLength(2);
    expect(no0325.state.row).toMatchObject({ approx_kind: "calle" });
    expect(Object.keys(no0325.state.row!).some((k) => k.startsWith("google_") || k === "approx_rule")).toBe(false);

    const no0316 = cacheAdmin(null, ["google_label", "approx_kind"]);
    await geocodeOrderAddress(no0316.client, KP204099, { key: "k", fetchImpl: fetchOf(QUINONES) as never, approxMode: "activo" });
    expect(no0316.state.upserts).toHaveLength(3);
    expect(no0316.state.row).toMatchObject({ reason: "no_es_edificio" });
    expect(Object.keys(no0316.state.row!).some((k) => k.startsWith("approx_") || k.startsWith("google_"))).toBe(false);
  });
});

describe("el «otra calle» de la reja vieja se vuelve a consultar una vez (0325)", () => {
  /** La fila de #KP204099 en producción: otra_calle con la reja de la 0316 (sin versión). */
  async function oldRow(extra: Record<string, unknown>) {
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const first = cacheAdmin(null);
    await geocodeOrderAddress(first.client, KP204099, { key: "k", fetchImpl: fetchOf(QUINONES) as never, approxMode: "activo" });
    const { google_label: _l, google_route: _r, google_number: _n, approx_rule: _v, ...row } = first.state.row!;
    return { ...row, approx_kind: "otra_calle", approx_latitude: null, approx_longitude: null, ...extra };
  }

  it("con la 0325 aplicada: una consulta, pasa con el sufijo, y la siguiente pasada usa lo guardado", async () => {
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const { client, state } = cacheAdmin(await oldRow({ approx_rule: null, google_label: null, google_route: null, google_number: null }));
    const fetchImpl = fetchOf(QUINONES);
    const geo = await geocodeOrderAddress(client, KP204099, { key: "k", fetchImpl: fetchImpl as never, approxMode: "activo" });
    expect(geo).toMatchObject({ cached: false, approx: { lat: -6.7714, lng: -79.8409 } });
    expect(state.row).toMatchObject({ approx_kind: "calle", approx_rule: APPROX_STREET_RULE, google_route: "Avenida José Quiñones" });
    const again = await geocodeOrderAddress(client, KP204099, { key: "k", fetchImpl: fetchImpl as never, approxMode: "activo" });
    expect(again).toMatchObject({ cached: true, approx: { lat: -6.7714, lng: -79.8409 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("si sigue siendo otra calle con la reja nueva, no vuelve a consultar", async () => {
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const libre = google({ route: "Avenida Perú Libre", number: "546", province: "Chiclayo" });
    const { client, state } = cacheAdmin(await oldRow({ approx_rule: null }));
    const fetchImpl = fetchOf(libre);
    await geocodeOrderAddress(client, KP204099, { key: "k", fetchImpl: fetchImpl as never, approxMode: "simulacion" });
    expect(state.row).toMatchObject({ approx_kind: "otra_calle", approx_rule: APPROX_STREET_RULE });
    await geocodeOrderAddress(client, KP204099, { key: "k", fetchImpl: fetchImpl as never, approxMode: "simulacion" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sin la 0325 (la fila no trae `approx_rule`), sin pedir la ubicación aproximada, u otro motivo: no consulta", async () => {
    const { geocodeOrderAddress } = await import("@/lib/geocode-google-server");
    const fetchImpl = fetchOf(QUINONES);
    const legacy = cacheAdmin(await oldRow({}));
    expect(await geocodeOrderAddress(legacy.client, KP204099, { key: "k", fetchImpl: fetchImpl as never, approxMode: "activo" })).toMatchObject({
      cached: true,
      approx: null,
    });
    // Los reintentos de Lima no piden el punto aproximado: lo guardado, sin consultar.
    const lima = cacheAdmin(await oldRow({ approx_rule: null }));
    expect(await geocodeOrderAddress(lima.client, KP204099, { key: "k", fetchImpl: fetchImpl as never })).toMatchObject({ cached: true });
    // `otro_numero` ya pasó la calle: el sufijo no lo cambia.
    const numero = cacheAdmin(await oldRow({ approx_rule: null, approx_kind: "otro_numero" }));
    expect(await geocodeOrderAddress(numero.client, KP204099, { key: "k", fetchImpl: fetchImpl as never, approxMode: "activo" })).toMatchObject({
      cached: true,
      approx: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("la ficha dice qué encontró Google y por qué no se usó (0325)", () => {
  const finding = (f: Partial<ChatbyGoogleFinding>): ChatbyGoogleFinding => ({
    ok: false,
    precision: "RANGE_INTERPOLATED",
    reason: "no_es_edificio",
    approxKind: null,
    approxMode: null,
    label: "Av. José Quiñones 546, Chiclayo 14001, Perú",
    route: "Avenida José Quiñones",
    number: "546",
    ...f,
  });

  it("la etiqueta sin el código postal ni «Perú»", () => {
    expect(googleLabelShort("Av. José Quiñones 546, Chiclayo 14001, Perú")).toBe("Av. José Quiñones 546, Chiclayo");
    expect(googleLabelShort("Jr. José Olaya 245, Ayacucho 05001, Peru")).toBe("Jr. José Olaya 245, Ayacucho");
  });

  it("#KP204099 con la reja vieja: otra calle, con el nombre de Google", () => {
    expect(chatbyGoogleFindingText(finding({ approxKind: "otra_calle", approxMode: "activo" }))).toBe(
      "Google encontró: Av. José Quiñones 546, Chiclayo (punto de la cuadra). No se usó porque es el punto de la cuadra y el nombre de la calle de Google («Avenida José Quiñones») no es el de la dirección del pedido.",
    );
  });

  it("cada motivo, en palabras", () => {
    const off = chatbyGoogleFindingText(finding({}));
    expect(off).toContain("(punto de la cuadra). No se usó porque es el punto de la cuadra, no el edificio");
    expect(off).toContain("está apagada");
    expect(chatbyGoogleFindingText(finding({ approxKind: "calle", approxMode: "simulacion" }))).toContain("está en Simulación");
    expect(chatbyGoogleFindingText(finding({ approxKind: "otro_numero" }))).toContain("de otro número (546)");
    expect(chatbyGoogleFindingText(finding({ approxKind: "otra_provincia" }))).toContain("en otra provincia");
    expect(chatbyGoogleFindingText(finding({ approxKind: "sin_calle" }))).toContain("no dio la calle y el número");
    const imp = chatbyGoogleFindingText(finding({ precision: null, reason: "impreciso", label: "Jr. Piscobamba, Independencia, Perú" }));
    expect(imp).toBe(
      "Google encontró: Jr. Piscobamba, Independencia (solo el centro de la calle o de la zona). No se usó porque Google solo la ubica en el centro de la calle o de la zona, no en la puerta de la casa.",
    );
    expect(chatbyGoogleFindingText(finding({ precision: null, reason: "coincidencia_parcial" }))).toContain(
      "No se usó porque Google no reconoce la dirección completa",
    );
    expect(chatbyGoogleFindingText(finding({ precision: null, reason: "distrito_distinto" }))).toContain("en otro distrito, no en el del pedido");
  });

  it("filas de antes de la 0325 (sin etiqueta): igual dice qué y por qué", () => {
    expect(chatbyGoogleFindingText(finding({ label: null, route: null, number: null, approxKind: "otra_calle" }))).toBe(
      "Google encontró el punto de la cuadra. No se usó porque es el punto de la cuadra y el nombre de la calle de Google no es el de la dirección del pedido.",
    );
    expect(chatbyGoogleFindingText(finding({ label: null, precision: null, reason: "coincidencia_parcial" }))).toMatch(
      /^No se usó lo que encontró Google porque Google no reconoce/,
    );
  });

  it("sin resultado o sin fila: el aviso de siempre", () => {
    expect(chatbyGoogleFindingText(null)).toBeNull();
    expect(chatbyGoogleFindingText(finding({ precision: null, reason: "sin_resultado", label: null }))).toBeNull();
    expect(chatbyAskTitle("sin_ubicacion", null)).toBe("La clienta confirmó, pero Google no encuentra la dirección");
    expect(chatbyAskExplanation({ reason: "sin_ubicacion", ask: "ubicacion" })).toContain("Google no da el edificio");
  });

  it("con lo que encontró Google, el título y la explicación lo dicen", () => {
    const google = finding({ approxKind: "otra_calle" });
    expect(chatbyAskTitle("sin_ubicacion", google)).toBe("La clienta confirmó, pero no se pudo usar lo que encontró Google");
    const text = chatbyAskExplanation({ reason: "sin_ubicacion", ask: "ubicacion", google });
    expect(text).toMatch(/^Google encontró: Av\. José Quiñones 546, Chiclayo \(punto de la cuadra\)\. No se usó porque/);
    expect(text).toContain("Aliclik la exige para crear la guía.");
    expect(text).not.toContain("Google no da el edificio");
    expect(chatbyAskExplanation({ reason: "sin_ubicacion", ask: "ubicacion", google, corrected: true })).toMatch(
      /^La clienta completó la dirección por Chatby y Kapta la guardó\. Google encontró:/,
    );
    // La dirección incompleta no habla de Google.
    expect(chatbyAskTitle("direccion_incompleta", google)).toBe("La clienta confirmó, pero la dirección está incompleta");
  });

  it("la ficha lo lee de la caché de la dirección ACTUAL; con otra dirección, nada", async () => {
    const { geocodeOrderAddress, orderGeocodeFinding } = await import("@/lib/geocode-google-server");
    const { client } = cacheAdmin(null);
    await geocodeOrderAddress(client, KP204099, { key: "k", fetchImpl: fetchOf(QUINONES) as never, approxMode: "simulacion" });
    expect(await orderGeocodeFinding(client, KP204099)).toEqual({
      ok: false,
      precision: "RANGE_INTERPOLATED",
      reason: "no_es_edificio",
      approxKind: "calle",
      approxMode: "simulacion",
      label: "Av. José Quiñones 546, Chiclayo 14001, Perú",
      route: "Avenida José Quiñones",
      number: "546",
    });
    expect(await orderGeocodeFinding(client, { ...KP204099, address: "Av. Balta 123" })).toBeNull();
    const actions = read("app/dashboard/pedidos/actions.ts");
    expect(actions).toContain("await orderGeocodeFinding(createAdminSupabase(), {");
    expect(read("components/order-chatby-panel.tsx")).toContain("title={chatbyAskTitle(hold.reason, hold.google)}");
  });
});

describe("la migración 0325, el MOM y DEPLOY", () => {
  it("la migración agrega lo que dijo Google y la versión, sin reescribir filas", () => {
    const sql = read("db/migrations/0325_order_geocodes_google_said.sql");
    for (const col of ["google_label text", "google_route text", "google_number text", "approx_rule smallint"]) {
      expect(sql).toContain(`add column if not exists ${col}`);
    }
    expect(sql).not.toMatch(/^\s*update\s/im);
    expect(read("scripts/verify-db.sh")).toContain("scripts/sql/order_geocodes_google_said_smoke.sql");
    expect(APPROX_STREET_RULE).toBe(2);
  });

  it("el MOM dice la regla del sufijo y la nueva consulta; DEPLOY la pone arriba", () => {
    const mom = flat(read("docs/mom/master-pedidos-v1.md"));
    expect(mom).toContain("**El sufijo (owner, 09-11-2026; 0325).**");
    expect(mom).toContain("«Av. Quiñones» = «Avenida José Quiñones»");
    expect(mom).toContain("`google_label`, `google_route`, `google_number`");
    const deploy = read("DEPLOY.md");
    const top = deploy.indexOf("### ");
    expect(deploy.slice(top, top + 200)).toContain("0325");
  });
});
