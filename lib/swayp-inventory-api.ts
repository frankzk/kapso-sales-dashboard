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
// EL CONTRATO SE OBTUVO DEL BUNDLE DEL PANEL Y DE UNA PETICIÓN REAL CAPTURADA
// (28-09-2026). No está documentado por Swayp, así que es reversado, no oficial:
//   · warehouses/byCompany  → POST {API_URL}v1/warehouses/byCompany  {idCompany}
//   · inventory/search      → POST {API_INVENTORY_URL}inventory/search?includeReturns=true
//                             body {warehouse, codbar:"", idCompany}
//   Son DOS HOSTS distintos (bodegas en cloudfunctions, inventario en run.app).
//   Auth: Bearer <token del panel> + headers email/user/x-country, igual que las
//   demás llamadas del panel. Por eso este módulo NO usa `swaypOptsFromEnv`: ese
//   token es el de integración del API de guías, y el de inventario es el del
//   login del panel (otro emisor). La Fase 1 (dry run) recibe el token pegado a
//   mano y no lo guarda; la fuente definitiva del token se decide después.
//
// Este módulo es PURO respecto a la base: sólo habla con la red (con un
// `fetchImpl` inyectable para las pruebas) y normaliza. No lee ni escribe Supabase.

import { ciudadDeBodega } from "@/lib/swayp-inventario";
import type { EntradaSwayp } from "@/lib/swayp-inventario";

/** Host del API general del panel (bodegas, login). Del `environment` del bundle. */
export const SWAYP_PANEL_API_URL =
  process.env.SWAYP_PANEL_API_URL?.trim() ||
  "https://us-central1-swayp-co.cloudfunctions.net/api/";

/** Host del API de inventario. Distinto del anterior — ver nota de arriba. */
export const SWAYP_INVENTORY_API_URL =
  process.env.SWAYP_INVENTORY_API_URL?.trim() ||
  "https://swayp-inventory-95701915666.us-central1.run.app/api/v1/";

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
function headersFor(creds: SwaypInventoryCreds): Record<string, string> {
  return {
    Authorization: `Bearer ${creds.token}`,
    email: creds.email,
    user: creds.user,
    "x-country": creds.country ?? "PE",
    "Content-Type": "application/json",
    Accept: "application/json",
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

/** Una bodega de Swayp, ya normalizada a lo único que nos importa. */
export interface SwaypWarehouse {
  id: string;
  name: string;
}

/**
 * Lista las bodegas de la empresa. Necesaria porque las filas de inventario
 * traen `idWarehouse` (un id) y no el nombre, y la ciudad se deduce del NOMBRE
 * («BODEGA TRUJILLO» → trujillo). Se lee defensivamente: el panel devuelve el id
 * como `id`/`_id`/`idWarehouse` según la vista, y el nombre como `name`/`nombre`.
 *
 * El cuerpo manda un superconjunto (`idCompany`/`company`/`nit`) porque el bundle
 * arma el body desde una variable y no se ve el nombre exacto de la clave;
 * mandar las tres es inofensivo y evita fallar por una diferencia de nombre.
 */
export async function listWarehouses(creds: SwaypInventoryCreds): Promise<SwaypWarehouse[]> {
  const raw = await post<unknown>(creds, `${SWAYP_PANEL_API_URL}v1/warehouses/byCompany`, {
    idCompany: creds.idCompany,
    company: creds.idCompany,
    nit: creds.user,
  });
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown })?.data) ? (raw as { data: unknown[] }).data : [];
  const out: SwaypWarehouse[] = [];
  for (const w of arr as Record<string, unknown>[]) {
    const id = String(w.id ?? w._id ?? w.idWarehouse ?? "").trim();
    const name = String(w.name ?? w.nombre ?? w.warehouse ?? "").trim();
    if (id && name) out.push({ id, name });
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
 * Trae el inventario. Con `warehouse` vacío devuelve TODAS las bodegas en una
 * sola llamada (cada fila trae su `idWarehouse`), que es como conviene para el
 * sync. Se puede acotar a una bodega pasando su id.
 */
export async function searchInventory(
  creds: SwaypInventoryCreds,
  opts: { warehouse?: string } = {},
): Promise<SwaypInventoryRow[]> {
  const raw = await post<unknown>(
    creds,
    `${SWAYP_INVENTORY_API_URL}inventory/search?includeReturns=true`,
    { warehouse: opts.warehouse ?? "", codbar: "", idCompany: creds.idCompany },
  );
  const arr = Array.isArray(raw) ? raw : [];
  return (arr as SwaypInventoryRowRaw[])
    .map(normalizeInventoryRow)
    .filter((r) => r.codbar);
}

/**
 * Agrupa las filas de inventario en `EntradaSwayp[]` por CIUDAD, que es lo que
 * `planearImportacion` consume. Traduce `idWarehouse` → nombre (con la lista de
 * bodegas) → ciudad (con `ciudadDeBodega`). Las bodegas cuya ciudad no
 * conocemos —Cusco, Huancayo, Ica, Chimbote— se saltan y se cuentan aparte, en
 * vez de mezclarse en una ciudad equivocada.
 */
export function inventoryToEntradasByCity(
  rows: SwaypInventoryRow[],
  warehouses: SwaypWarehouse[],
): { porCiudad: Map<string, EntradaSwayp[]>; sinCiudad: { idWarehouse: string; nombre: string; filas: number }[] } {
  const nombrePorId = new Map(warehouses.map((w) => [w.id, w.name]));
  const porCiudad = new Map<string, EntradaSwayp[]>();
  const sinCiudadPorWh = new Map<string, { nombre: string; filas: number }>();

  for (const r of rows) {
    const nombreBodega = nombrePorId.get(r.idWarehouse) ?? "";
    const ciudad = ciudadDeBodega(nombreBodega);
    if (!ciudad) {
      const prev = sinCiudadPorWh.get(r.idWarehouse) ?? { nombre: nombreBodega, filas: 0 };
      prev.filas += 1;
      sinCiudadPorWh.set(r.idWarehouse, prev);
      continue;
    }
    const lista = porCiudad.get(ciudad) ?? [];
    lista.push({
      codbar: r.codbar,
      nombre: r.nombre,
      bodega: nombreBodega,
      disponible: r.disponible,
    });
    porCiudad.set(ciudad, lista);
  }

  const sinCiudad = [...sinCiudadPorWh.entries()].map(([idWarehouse, v]) => ({
    idWarehouse,
    nombre: v.nombre,
    filas: v.filas,
  }));
  return { porCiudad, sinCiudad };
}
