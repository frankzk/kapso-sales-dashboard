// Cliente de LECTURA del inventario de Swayp — el API interno que usa su panel
// (ce.swayp.co), no el API público de guías (api.swayp.co, en lib/swayp.ts).
//
// POR QUÉ EXISTE. `fenix_stock` se carga hoy subiendo a mano el Excel «Stock →
// Inventario» de Swayp, una bodega por archivo. Ese Excel sale de estos mismos
// endpoints: leerlos directo elimina el paso manual y cubre TODAS las bodegas de
// una vez. El cruce contra nuestra tabla no cambia — lo hace `planearImportacion`
// (lib/swayp-inventario.ts), que recibe las mismas `EntradaSwayp` que produce el
// Excel. Este módulo sólo cambia la FUENTE de esas entradas.
//
// EL CONTRATO SE OBTUVO DEL BUNDLE DEL PANEL Y DE PETICIONES REALES CAPTURADAS
// (28-09-2026). No está documentado por Swayp, así que es reversado, no oficial.
// TODO va a UN SOLO host —cloudfunctions— con el token del panel:
//   · warehouses/byCompany  → POST {API_URL}v1/warehouses/byCompany  {idCompany}
//   · inventory/search      → POST {API_URL}v1/inventory/go/inventory/search?includeReturns=true
//                             body {warehouse, codbar:"", idCompany}
//   Auth: Bearer <token del panel> + headers email/user/x-country + headers de
//   navegador (Origin/Referer/UA). El token es el del LOGIN del panel, no el de
//   integración del API de guías (otro emisor), por eso no se usa `swaypOptsFromEnv`.
//
// OJO: el `environment` del bundle declara un `API_INVENTORY_URL` a un host
// `run.app`, pero NINGÚN código lo usa —es config muerta—. Apuntar ahí devuelve
// «Invalid or missing API Key» (es otro servicio, con otra auth). El inventario
// que muestra el panel sale de `v1/inventory/go/inventory/search` en
// cloudfunctions, con el mismo Bearer que las bodegas. Confirmado el 28-09-2026:
// contra run.app daba 401; contra cloudfunctions, bodegas y bags daban 200.
//
// Este módulo es PURO respecto a la base: sólo habla con la red (con un
// `fetchImpl` inyectable para las pruebas) y normaliza. No lee ni escribe Supabase.

import { ciudadDeBodega } from "@/lib/swayp-inventario";
import type { EntradaSwayp } from "@/lib/swayp-inventario";
import { UBIGEO_BY_CITY } from "@/lib/ubigeo";

/** Host del API del panel. Todo el inventario vive acá. Del `environment` del bundle. */
export const SWAYP_PANEL_API_URL =
  process.env.SWAYP_PANEL_API_URL?.trim() ||
  "https://us-central1-swayp-co.cloudfunctions.net/api/";

const DEFAULT_TIMEOUT_MS = 20_000;

/** Lo que hace falta para autenticar contra el panel de Swayp. */
export interface SwaypInventoryCreds {
  /** Token del panel (JWT del login, o de integración si Swayp lo habilita). */
  token: string;
  /** Correo de la cuenta; viaja en el header `email`, como en el panel. */
  email: string;
  /** RUC de la empresa; viaja en el header `user`. */
  user: string;
  /** Id de la empresa en Swayp (companyId). Va en el cuerpo, no en el header. */
  idCompany: string;
  country?: "PE" | "CO";
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class SwaypInventoryError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Swayp inventory API ${status}: ${body.slice(0, 300)}`);
    this.name = "SwaypInventoryError";
  }
}

/** true cuando el fallo es de credencial (token vencido, sin permiso). */
export function isInventoryAuthError(err: unknown): boolean {
  return err instanceof SwaypInventoryError && (err.status === 401 || err.status === 403);
}

/**
 * Los headers que el panel adjunta a cada llamada. NUNCA se registran: el token
 * es un secreto de vida corta y no tiene por qué aparecer en un log.
 */
// El User-Agent del panel (una petición real capturada). Sin un UA de navegador,
// el host de inventario (Cloud Run) puede responder 403 aunque el token sea
// válido — que es justo lo que pasó: bags (cloudfunctions) daba 200 y
// inventory/search (run.app) daba 403 con el mismo token.
const PANEL_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";
const PANEL_ORIGIN = "https://ce.swayp.co";

/**
 * Los headers que el panel adjunta a cada llamada, replicados TAL CUAL. Además
 * de la credencial (Authorization + email/user/x-country), incluye los que un
 * navegador manda solo —Origin, Referer, User-Agent— porque el host de
 * inventario los exige: sin ellos devuelve 403 pese a un token bueno.
 */
function headersFor(creds: SwaypInventoryCreds): Record<string, string> {
  return {
    Authorization: `Bearer ${creds.token}`,
    email: creds.email,
    user: creds.user,
    "x-country": creds.country ?? "PE",
    "Content-Type": "application/json",
    Accept: "application/json",
    "Access-Control-Allow-Origin": "*",
    Origin: PANEL_ORIGIN,
    Referer: `${PANEL_ORIGIN}/`,
    "User-Agent": PANEL_USER_AGENT,
  };
}

async function post<T>(
  creds: SwaypInventoryCreds,
  url: string,
  body: unknown,
): Promise<T> {
  const doFetch = creds.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: "POST",
    headers: headersFor(creds),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(creds.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SwaypInventoryError(res.status, text);
  }
  return (await res.json()) as T;
}

/**
 * Resultado de una llamada de diagnóstico: qué endpoint, contra qué host, con
 * qué status, y un pedazo del cuerpo. NUNCA lleva el token. Sirve para saber,
 * ante un 401/403, si el problema es la credencial o el contrato (host/ruta).
 */
export interface SwaypProbe {
  label: string;
  host: string;
  method: "GET" | "POST";
  status: number;
  ok: boolean;
  /** Primeros caracteres de la respuesta: el mensaje de error de Swayp suele venir acá. */
  body: string;
}

async function probeOnce(
  creds: SwaypInventoryCreds,
  label: string,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<SwaypProbe> {
  const doFetch = creds.fetchImpl ?? fetch;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  try {
    const res = await doFetch(url, {
      method,
      headers: headersFor(creds),
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(creds.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    return { label, host, method, status: res.status, ok: res.ok, body: text.slice(0, 240) };
  } catch (e) {
    return {
      label,
      host,
      method,
      status: 0,
      ok: false,
      body: e instanceof Error ? e.message : "error de red",
    };
  }
}

/** URL del inventario, en cloudfunctions (NO run.app). Ver nota de arriba. */
const INVENTORY_SEARCH_URL = `${SWAYP_PANEL_API_URL}v1/inventory/go/inventory/search?includeReturns=true`;

/**
 * Dos llamadas de diagnóstico para aislar un fallo, cada una con su host y su
 * status por separado y sin lanzar. La de bodegas es el control (Bearer válido →
 * 200); la de inventario es la que importa. Antes había una tercera contra
 * run.app, que se quitó al confirmar que ese host es config muerta.
 */
export async function diagnoseInventoryAccess(creds: SwaypInventoryCreds): Promise<SwaypProbe[]> {
  return Promise.all([
    probeOnce(creds, "warehouses/byCompany (cloudfunctions)", "POST", `${SWAYP_PANEL_API_URL}v1/warehouses/byCompany`, {
      idCompany: creds.idCompany,
      company: creds.idCompany,
      nit: creds.user,
    }),
    probeOnce(creds, "inventory/search (cloudfunctions)", "POST", INVENTORY_SEARCH_URL, {
      warehouse: "",
      codbar: "",
      idCompany: creds.idCompany,
    }),
  ]);
}

// Código INEI de cada ciudad (su cercado) → nuestra clave de ciudad. Se usa para
// resolver la bodega cuando su `nombre` viene vacío pero trae `ciudad` (ubigeo).
// Puno y Juliaca comparten bodega: ambos códigos caen en `juliaca`, como en el
// importador de Excel.
const INEI_A_CIUDAD: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [city, table] of Object.entries(UBIGEO_BY_CITY)) {
    const cercado = table[city];
    if (cercado) map[cercado] = city;
  }
  map["210101"] = "juliaca"; // Puno cercado → se sirve desde Juliaca
  return map;
})();

/** Las ciudades que sabemos mapear, para buscarlas dentro de una dirección. */
const CIUDADES_CONOCIDAS = Object.keys(UBIGEO_BY_CITY);

/**
 * A qué ciudad nuestra corresponde una bodega. Tres intentos, del más fiable al
 * menos: el NOMBRE (por si trae «BODEGA TRUJILLO»), el código INEI de `ciudad`
 * (exacto), y por último rastrear una ciudad conocida dentro de la `direccion`
 * («Av. Ejército 1015, Cayma, Arequipa» → arequipa). null si ninguno acierta.
 */
export function ciudadDeWarehouse(w: {
  name?: string | null;
  ciudad?: string | null;
  direccion?: string | null;
}): string | null {
  const porNombre = ciudadDeBodega(w.name);
  if (porNombre) return porNombre;

  const inei = String(w.ciudad ?? "").trim();
  if (inei && INEI_A_CIUDAD[inei]) return INEI_A_CIUDAD[inei];

  const dir = (w.direccion ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (dir) {
    for (const ciudad of CIUDADES_CONOCIDAS) {
      if (dir.includes(ciudad)) return ciudad === "puno" ? "juliaca" : ciudad;
    }
  }
  return null;
}

/** Una bodega de Swayp, con su ciudad ya resuelta (o null si no la conocemos). */
export interface SwaypWarehouse {
  id: string;
  name: string;
  city: string | null;
  /** Lo que dijo Swayp, para poder mostrarlo cuando la ciudad no resuelve. */
  ciudadInei: string;
  direccion: string;
}

/**
 * Lista las bodegas de la empresa, con su ciudad resuelta. El panel devuelve el
 * id como `idBodega` (a veces `id`/`_id`), el `nombre` PUEDE venir vacío, y la
 * ciudad llega como código INEI en `ciudad` más el texto en `direccion` — por
 * eso `ciudadDeWarehouse` mira los tres.
 */
export async function listWarehouses(creds: SwaypInventoryCreds): Promise<SwaypWarehouse[]> {
  const raw = await post<unknown>(creds, `${SWAYP_PANEL_API_URL}v1/warehouses/byCompany`, {
    idCompany: creds.idCompany,
    company: creds.idCompany,
    nit: creds.user,
  });
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown })?.data)
      ? (raw as { data: unknown[] }).data
      : [];
  const out: SwaypWarehouse[] = [];
  for (const w of arr as Record<string, unknown>[]) {
    const id = String(w.idBodega ?? w.id ?? w._id ?? w.idWarehouse ?? "").trim();
    if (!id) continue;
    const name = String(w.nombre ?? w.name ?? w.warehouse ?? "").trim();
    const ciudadInei = String(w.ciudad ?? "").trim();
    const direccion = String(w.direccion ?? "").trim();
    out.push({ id, name, ciudadInei, direccion, city: ciudadDeWarehouse({ name, ciudad: ciudadInei, direccion }) });
  }
  return out;
}

/** Una fila cruda del inventario, con los campos que devuelve `inventory/search`. */
export interface SwaypInventoryRowRaw {
  id?: string;
  name?: string;
  barCode?: string;
  idCompany?: string;
  idWarehouse?: string;
  totalAmount?: number | string;
  availableAmount?: number | string;
  reservedAmount?: number | string;
  inTransitAmount?: number | string;
  returnAmount?: number | string;
  [k: string]: unknown;
}

/** Fila normalizada: lo mismo que el panel calcula en su columna «Disponible». */
export interface SwaypInventoryRow {
  codbar: string;
  nombre: string;
  idWarehouse: string;
  /** Lo que se puede prometer HOY. La MISMA semántica que `EntradaSwayp.disponible`. */
  disponible: number;
  enBodega: number;
  reservado: number;
  enTransito: number;
  enDevolucion: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normaliza una fila cruda igual que el panel: «Disponible» es `availableAmount`
 * si viene, y si no `totalAmount - reservedAmount`. Esa resta importa —el saldo
 * total incluye lo ya reservado para guías emitidas, que no se puede volver a
 * prometer— y es exactamente lo que la reja de stock necesita.
 */
export function normalizeInventoryRow(r: SwaypInventoryRowRaw): SwaypInventoryRow {
  const total = num(r.totalAmount);
  const reservado = num(r.reservedAmount);
  const disponible = r.availableAmount != null ? num(r.availableAmount) : total - reservado;
  return {
    codbar: String(r.barCode ?? "").trim().toUpperCase(),
    nombre: String(r.name ?? "").trim(),
    idWarehouse: String(r.idWarehouse ?? "").trim(),
    disponible,
    enBodega: total,
    reservado,
    enTransito: num(r.inTransitAmount),
    enDevolucion: num(r.returnAmount),
  };
}

/**
 * Trae el inventario. Con `warehouse` vacío devuelve el de TODAS las bodegas en
 * una sola llamada, y cada fila trae su `idWarehouse`. Es la forma probada en
 * producción (28-09-2026): la llamada por bodega, en serie, fallaba o se comía
 * el tiempo de la función; la de todas juntas respondía 200.
 */
export async function searchInventory(
  creds: SwaypInventoryCreds,
  opts: { warehouse?: string } = {},
): Promise<SwaypInventoryRow[]> {
  const raw = await post<unknown>(creds, INVENTORY_SEARCH_URL, {
    warehouse: opts.warehouse ?? "",
    codbar: "",
    idCompany: creds.idCompany,
  });
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown })?.data) ? (raw as { data: unknown[] }).data : [];
  return (arr as SwaypInventoryRowRaw[]).map(normalizeInventoryRow).filter((r) => r.codbar);
}

/** Filas cuyo `idWarehouse` no cae en una bodega de ciudad conocida. */
export interface SwaypFilasSinCiudad {
  idWarehouse: string;
  /** Lo que Swayp dice de esa bodega, si vino en la lista; vacío si no vino. */
  nombre: string;
  ciudadInei: string;
  direccion: string;
  filas: number;
}

/**
 * Reparte un inventario leído de una sola vez entre nuestras ciudades, usando el
 * `idWarehouse` de cada fila contra el `id` de la lista de bodegas. Pura: no
 * toca la red. Las filas de bodegas cuya ciudad no conocemos —Cusco, Huancayo,
 * Ica, Chimbote— o con un `idWarehouse` que no está en la lista se apartan y se
 * informan, en vez de mezclarse en una ciudad equivocada. Un mismo codbar
 * repetido en una ciudad (lotes) se suma, igual que el importador de Excel.
 */
export function groupInventoryByCity(
  rows: SwaypInventoryRow[],
  warehouses: SwaypWarehouse[],
): {
  porCiudad: Map<string, EntradaSwayp[]>;
  sinCiudad: SwaypFilasSinCiudad[];
} {
  const bodegaPorId = new Map(warehouses.map((w) => [w.id, w]));
  const porCiudad = new Map<string, Map<string, EntradaSwayp>>();
  const sinCiudad = new Map<string, SwaypFilasSinCiudad>();

  for (const r of rows) {
    const w = bodegaPorId.get(r.idWarehouse);
    if (!w?.city) {
      const previa = sinCiudad.get(r.idWarehouse);
      if (previa) previa.filas += 1;
      else
        sinCiudad.set(r.idWarehouse, {
          idWarehouse: r.idWarehouse,
          nombre: w?.name ?? "",
          ciudadInei: w?.ciudadInei ?? "",
          direccion: w?.direccion ?? "",
          filas: 1,
        });
      continue;
    }
    const delaCiudad = porCiudad.get(w.city) ?? new Map<string, EntradaSwayp>();
    const previa = delaCiudad.get(r.codbar);
    if (previa) previa.disponible += r.disponible;
    else
      delaCiudad.set(r.codbar, {
        codbar: r.codbar,
        nombre: r.nombre,
        bodega: w.name || w.city,
        disponible: r.disponible,
      });
    porCiudad.set(w.city, delaCiudad);
  }

  return {
    porCiudad: new Map([...porCiudad].map(([c, m]) => [c, [...m.values()]])),
    sinCiudad: [...sinCiudad.values()],
  };
}

/**
 * Lee el inventario de TODAS las bodegas en una llamada y lo reparte por ciudad
 * (ver `groupInventoryByCity`), que es lo que `planearImportacion` consume.
 * Devuelve también una muestra cruda para verificar los campos con cada corrida.
 */
export async function fetchInventoryByCity(
  creds: SwaypInventoryCreds,
  warehouses: SwaypWarehouse[],
): Promise<{
  porCiudad: Map<string, EntradaSwayp[]>;
  sinCiudad: SwaypFilasSinCiudad[];
  totalFilas: number;
  muestra: SwaypInventoryRow[];
}> {
  const rows = await searchInventory(creds);
  return { ...groupInventoryByCity(rows, warehouses), totalFilas: rows.length, muestra: rows.slice(0, 3) };
}
