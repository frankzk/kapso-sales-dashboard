// Cliente de la API de Integraciones de Aliclik.
// Base: https://api.aliclik-dev.com (configurable — ver env.aliclikApiBase()).
//
// Endpoints cubiertos (documentación oficial, módulo /integration):
//   GET  /integration/product/public          — catálogo con stock por almacén
//   GET  /integration/order/shipping/cost     — couriers y costo para un destino
//   POST /integration/order                   — crear pedido contraentrega
//   GET  /integration/order                   — listar / consultar estado
//   POST /integration/order/cancel            — cancelar contraentrega
//   GET  /integration/order/agencies          — directorio de agencias Shalom
//   GET  /integration/order/package-sizes     — tamaños de paquete
//   POST /integration/order/agency            — crear pedido por agencia
//   POST /integration/order/agency/cancel     — anular pedido por agencia
//
// CONVENCIONES DE ESTE CLIENTE
//
// 1. Nunca lanza. Devuelve `AliclikResult<T>` = {ok:true,data} | {ok:false,…},
//    como los emisores de lib/telegram.ts y lib/kapso.ts. Una integración con un
//    courier no puede tumbar el render de un panel.
//
// 2. Los errores 400 de Aliclik traen `message` en español y accionable — su
//    documentación dice explícitamente que se puede mostrar al usuario. Así que
//    se extrae y se propaga tal cual, en vez de traducirlo o inventar uno.
//
// 3. `timedOut` se distingue del resto de fallos a propósito. En una creación,
//    un timeout NO significa "no se creó": Aliclik pudo haber creado el pedido y
//    haberse perdido la respuesta. Quien llama tiene que poder tratarlo distinto
//    (ver lib/aliclik-orders.ts y el cron de reconciliación).

import { env } from "@/lib/env";

/**
 * Por dónde sale la petición hacia Aliclik.
 *
 *  - `direct` — desde la función Node, es decir desde AWS. Lo natural.
 *  - `edge`   — a través de una ruta interna en el runtime Edge de Vercel, que
 *               corre en otra red. Existe porque Cloudflare desafía nuestras
 *               peticiones directas (403) y la clase de IP es la hipótesis que
 *               queda por descartar. Ver app/api/internal/aliclik-egress/route.ts.
 */
export type AliclikEgress = "direct" | "edge";

export interface AliclikClientOpts {
  apiToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Milisegundos antes de abortar. Por defecto 20 s. */
  timeoutMs?: number;
  /** Por defecto, lo que diga `env.aliclikEgress()`. */
  egress?: AliclikEgress;
  /** URL propia, para construir la llamada interna en modo `edge`. */
  siteUrl?: string;
  /** Secreto interno del proxy Edge. Por defecto `env.cronSecret()`. */
  internalSecret?: string;
}

export type AliclikResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number | null; timedOut?: boolean };

// ---------------------------------------------------------------------------
// Tipos de respuesta (los campos que consumimos; la API puede traer más)
// ---------------------------------------------------------------------------

export interface AliclikSku {
  sku?: string | null;
  ean?: string | null;
  name?: string | null;
  regularPrice?: number | null;
  stockVirtual?: number | null;
  dropPrice?: number | null;
  warehouseId?: number | null;
  warehouseName?: string | null;
  /** Solo con isAgency=true: hora de corte del almacén ("13:00"). */
  formatTimeAgency?: string | null;
  /** Solo con isAgency=true: agencia Shalom de origen configurada. */
  shalomOriginIn?: string | null;
}

export interface AliclikProduct {
  id?: number | null;
  name?: string | null;
  shortDescription?: string | null;
  urlImage?: string | null;
  category?: string | null;
  skus?: AliclikSku[] | null;
}

export interface AliclikProductPage {
  count: number;
  page: number;
  result: AliclikProduct[];
}

/** Bloque `courier` de la cotización. Se reenvía VERBATIM al crear el pedido. */
export interface AliclikCourierQuote {
  id?: number | null;
  addDays: number;
  deliveryCost: number;
  returnCost: number;
  transportId: number;
  transportName?: string | null;
  transportUrlImage?: string | null;
  flagDeliveryExpress: boolean;
  schedule?: string | null;
  scheduleExpressStart?: string | null;
  scheduleExpressEnd?: string | null;
}

export interface AliclikShippingCost {
  ubigeo?: {
    department?: { name?: string | null } | null;
    province?: { name?: string | null } | null;
    district?: { name?: string | null } | null;
  } | null;
  couriers: AliclikCourierQuote[];
}

export interface AliclikOrderProduct {
  ean: string;
  quantity: number;
  price: number;
}

export interface AliclikCreateOrderInput {
  note?: string;
  channel?: string;
  /** Costo total de envío cobrado al cliente. Obligatorio. */
  delivery: number;
  customer: {
    name: string;
    lastName?: string;
    /** Con código de país y SIN "+". */
    phone: string;
    email?: string;
    address?: string;
  };
  shipping: {
    address1: string;
    address2?: string;
    /** String decimal, p. ej. "-12.04318". */
    lat: string;
    lng: string;
    reference?: string;
  };
  products: AliclikOrderProduct[];
  courier: AliclikCourierQuote;
}

export interface AliclikCreateOrderResult {
  message?: string | null;
  orderNumber?: string | null;
}

export interface AliclikOrderShipping {
  address1?: string | null;
  address2?: string | null;
  reference?: string | null;
  lat?: string | null;
  lng?: string | null;
  departmentName?: string | null;
  provinceName?: string | null;
  districtName?: string | null;
}

export interface AliclikOrder {
  orderNumber: string;
  total?: number | null;
  callStatus?: string | null;
  status?: string | null;
  dispatchStatus?: string | null;
  channel?: string | null;
  productDetail?: string | null;
  note?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  customer?: {
    name?: string | null;
    lastName?: string | null;
    phone?: string | null;
    email?: string | null;
  } | null;
  shipping?: AliclikOrderShipping | null;
  products?: { skuId?: number | null; quantity?: number | null; price?: number | null; subtotal?: number | null }[] | null;
}

export interface AliclikOrderPage {
  data: AliclikOrder[];
  pagination?: {
    total?: number | null;
    page?: number | null;
    limit?: number | null;
    totalPages?: number | null;
  } | null;
}

export interface AliclikAgency {
  id?: number | string | null;
  name?: string | null;
  address?: string | null;
  department?: string | null;
  province?: string | null;
  district?: string | null;
}

export interface AliclikPackageSize {
  title?: string | null;
}

export interface AliclikAgencyOrderInput {
  note?: string;
  paymentType?: string;
  customer: {
    firstName: string;
    firstLastName: string;
    secondLastName: string;
    senderPhone: string;
    senderDocumentType: string;
    senderContact: string;
  };
  shipping: {
    agencyName: string;
    agencyAddress: string;
    reference?: string;
    keyCode: string;
    merchandiseShalom: string;
    /** YYYY-MM-DD estricto. */
    scheduleDate: string;
    shalomAgency: string;
    shalomAgencyId: string;
  };
  products: AliclikOrderProduct[];
}

export interface AliclikMessageResult {
  message?: string | null;
}

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 20_000;

function baseFor(opts: AliclikClientOpts): string {
  return (opts.baseUrl ?? env.aliclikApiBase()).replace(/\/$/, "");
}

/**
 * Cabeceras que Aliclik exige en TODOS los endpoints. `x-aliclik-origin` no es
 * opcional aunque lo parezca: sin ella la API rechaza la petición.
 */
function headersFor(opts: AliclikClientOpts): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.apiToken}`,
    "Content-Type": "application/json",
    "x-aliclik-origin": "aliclik-web",
    Accept: "application/json",
    // `fetch` de Node no manda User-Agent, y una petición sin él es de las
    // primeras que Cloudflare marca como bot. No garantiza pasar el desafío
    // —eso depende de la configuración del WAF de Aliclik— pero quita el motivo
    // más tonto para que nos bloqueen.
    "User-Agent": "kapso-sales-dashboard/1.0 (+integracion-aliclik)",
  };
}

/**
 * ¿La respuesta es una página de desafío anti-bot en vez de la API?
 *
 * `api.aliclik-dev.com` está detrás de Cloudflare, y Cloudflare puede
 * interponer un desafío ("Just a moment…") a las peticiones que vienen de
 * centros de datos — que es exactamente lo que somos desde Vercel. Cuando eso
 * pasa la API nunca llega a ver la petición: da igual que el token sea correcto.
 *
 * Detectarlo importa porque el síntoma es engañoso. Sin esto, el HTML del
 * desafío se cuela como "mensaje de error de Aliclik" y parece un problema de
 * credenciales o de payload, cuando es de red.
 */
export function isBotChallenge(body: unknown, contentType?: string | null): boolean {
  if (contentType?.toLowerCase().includes("text/html")) return true;
  if (typeof body !== "string") return false;
  const s = body.slice(0, 2000).toLowerCase();
  return (
    s.includes("<!doctype html") ||
    s.includes("just a moment") ||
    s.includes("cf-browser-verification") ||
    s.includes("attention required") ||
    s.includes("cloudflare")
  );
}

/**
 * Saca el Ray ID del cuerpo del desafío. Cloudflare lo imprime al pie de su
 * página ("Ray ID: 8f1a2b3c4d5e6f70") además de mandarlo en la cabecera
 * `cf-ray`, y de las dos fuentes la cabecera es la fiable — esta es el respaldo.
 */
export function extractRayId(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const m = body.match(/ray\s*id[":\s]*([0-9a-f]{8,}(?:-[a-z0-9]+)?)/i);
  return m?.[1] ?? null;
}

/**
 * Mensaje legible a partir de una respuesta de error. Aliclik responde
 * `{ statusCode, message, error }` y en los 400 el `message` está en español y
 * es accionable — se propaga literal. `message` también puede llegar como array
 * (validaciones de NestJS), en cuyo caso se juntan.
 */
export function aliclikErrorMessage(
  status: number,
  body: unknown,
  contentType?: string | null,
  rayId?: string | null,
): string {
  // Antes que nada: si esto es un muro de Cloudflare, decirlo con todas las
  // letras. Enseñar el HTML mandaría al equipo a revisar el token, que está bien.
  if (isBotChallenge(body, contentType)) {
    const ray = rayId ?? extractRayId(body);
    return (
      `Cloudflare está bloqueando la conexión con Aliclik (HTTP ${status}): devolvió una página de ` +
      "verificación en vez de la API, así que la petición nunca llegó a su servidor. " +
      "No es el token. Aliclik tiene que permitir el tráfico de nuestro servidor en su WAF." +
      // El Ray ID es lo que permite a Aliclik encontrar ESTE bloqueo concreto en
      // su panel de Cloudflare. Sin él, el reporte es "a veces nos bloquea" y se
      // eterniza; con él, su sysadmin ve la regla que disparó en segundos.
      (ray ? ` · Ray ID de Cloudflare para reportarlo: ${ray} (UTC ${new Date().toISOString()})` : "")
    );
  }
  // Un 5xx es un fallo DE ELLOS, y su mensaje suele venir en inglés y genérico
  // ("Internal server error"). Enseñarlo pelado hace que se lea como un fallo
  // nuestro y manda al equipo a revisar el dashboard, que está bien. Se atribuye
  // siempre. Los 4xx se dejan tal cual: ésos sí son accionables y su texto es la
  // información útil ("El número de pedido … ya existe").
  const attribute = (msg: string) =>
    status >= 500
      ? `Aliclik respondió HTTP ${status}: «${msg}». Es un fallo en el servidor de Aliclik, no en el ` +
        "dashboard. Reintenta en unos minutos; si sigue igual, repórtaselo."
      : msg;

  if (body && typeof body === "object") {
    const msg = (body as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return attribute(msg.trim());
    if (Array.isArray(msg)) {
      const joined = msg.filter((m) => typeof m === "string").join("; ").trim();
      if (joined) return attribute(joined);
    }
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string" && err.trim()) return attribute(err.trim());
  }
  if (typeof body === "string" && body.trim()) return attribute(body.trim().slice(0, 300));
  if (status === 401) return "Token de Aliclik inválido o ausente.";
  if (status === 404) return "Aliclik no encontró el recurso.";
  if (status === 502) return "Aliclik no pudo consultar el origen (Shalom). Reintenta más tarde.";
  return `Aliclik respondió HTTP ${status}.`;
}

// Fallos PASAJEROS de Aliclik. Su API devuelve 500 ("Internal server error")
// de forma intermitente: medido en producción, tres 500 en tres horas sobre
// cotizaciones idénticas a otras que sí funcionaron minutos antes. Sin
// reintento, la vendedora ve un error rojo y tiene que volver a intentarlo a
// mano con la clienta esperando al teléfono.
//
// Los 4xx NO se reintentan: un token malo, un EAN inexistente o un pedido
// duplicado no mejoran solos, y repetirlos solo alarga la espera.
const ALICLIK_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const ALICLIK_MAX_ATTEMPTS = 3;
const ALICLIK_RETRY_BASE_MS = 400; // 400ms, 800ms → ≤1,2s extra en el peor caso

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request<T>(
  opts: AliclikClientOpts,
  method: "GET" | "POST",
  path: string,
  init: { params?: Record<string, unknown>; body?: unknown; retry?: boolean } = {},
): Promise<AliclikResult<T>> {
  let url: URL;
  try {
    url = new URL(baseFor(opts) + path);
  } catch {
    return { ok: false, error: "URL base de Aliclik inválida.", status: null };
  }
  if (init.params) {
    for (const [k, v] of Object.entries(init.params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const egress = opts.egress ?? env.aliclikEgress();
  const serialized = init.body === undefined ? undefined : JSON.stringify(init.body);

  // Solo se reintenta lo que quien llama declara SEGURO de repetir. Crear un
  // pedido no lo es: Aliclik no tiene idempotency key, así que un reintento
  // puede dejar dos guías reales para el mismo paquete.
  const attempts = init.retry ? ALICLIK_MAX_ATTEMPTS : 1;
  let last: AliclikResult<T> | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(ALICLIK_RETRY_BASE_MS * 2 ** (attempt - 1));
    const out = await attemptRequest<T>(opts, method, url, {
      doFetch,
      egress,
      serialized,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (out.ok) return out;
    last = out;
    // `status: null` es corte de red o timeout: también pasajero.
    const transient = out.status == null || ALICLIK_RETRY_STATUSES.has(out.status);
    if (!transient) return out;
  }
  return last ?? { ok: false, status: null, error: "Aliclik no respondió." };
}

/** Un intento suelto. Separado para que el reintento no duplique la lógica. */
async function attemptRequest<T>(
  opts: AliclikClientOpts,
  method: "GET" | "POST",
  url: URL,
  ctx: {
    doFetch: typeof fetch;
    egress: AliclikEgress;
    serialized: string | undefined;
    timeoutMs: number;
  },
): Promise<AliclikResult<T>> {
  const { doFetch, egress, serialized } = ctx;
  let res: Response;
  try {
    if (egress === "edge") {
      // Se manda la ruta CON su query string; el proxy le antepone el host de
      // la configuración. Nunca viaja el host en la petición: ver la cabecera
      // de app/api/internal/aliclik-egress/route.ts.
      const site = (opts.siteUrl ?? env.siteUrl()).replace(/\/$/, "");
      res = await doFetch(`${site}/api/internal/aliclik-egress`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": opts.internalSecret ?? env.cronSecret(),
          // El token de Aliclik va en una cabecera propia para no confundirlo
          // con la autenticación de esta ruta interna.
          "x-aliclik-authorization": `Bearer ${opts.apiToken}`,
        },
        body: JSON.stringify({
          path: url.pathname + url.search,
          method,
          body: serialized ?? null,
        }),
        signal: AbortSignal.timeout(ctx.timeoutMs),
      });
    } else {
      res = await doFetch(url.toString(), {
        method,
        headers: headersFor(opts),
        body: serialized,
        signal: AbortSignal.timeout(ctx.timeoutMs),
      });
    }
  } catch (e) {
    // Un timeout NO es "no se creó". Quien llama debe poder distinguirlo.
    const timedOut =
      e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false,
      status: null,
      timedOut,
      error: timedOut
        ? "Aliclik no respondió a tiempo."
        : `No se pudo contactar con Aliclik: ${e instanceof Error ? e.message : "error de red"}`,
    };
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  const contentType = res.headers.get("content-type");
  const rayId = res.headers.get("cf-ray");

  // Un fallo del PROXY no es un fallo de Aliclik. Distinguirlo evita el peor
  // desenlace de este experimento: creer que Aliclik rechaza algo cuando en
  // realidad la petición nunca salió de nuestra propia infraestructura.
  if (parsed && typeof parsed === "object" && "egressError" in parsed) {
    return {
      ok: false,
      status: res.status,
      error: `Salida por Edge no disponible: ${String((parsed as { egressError: unknown }).egressError)}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: aliclikErrorMessage(res.status, parsed, contentType, rayId),
      status: res.status,
    };
  }

  // Un 200 con HTML tampoco es la API: Cloudflare sirve algunos desafíos con
  // código 200, y tratarlo como éxito produciría un catálogo vacío "correcto".
  if (isBotChallenge(parsed, contentType)) {
    return {
      ok: false,
      error: aliclikErrorMessage(res.status, parsed, contentType, rayId),
      status: res.status,
    };
  }

  return { ok: true, data: (parsed ?? {}) as T };
}

// ---------------------------------------------------------------------------
// Catálogo (compartido entre ambas modalidades)
// ---------------------------------------------------------------------------

export interface ListProductsParams {
  page?: number;
  /** Máx. 100; la API recorta por encima, pero mejor no pedirlo. */
  limit?: number;
  search?: string;
  categoryId?: number;
  /** true = solo SKUs despachables por agencia Shalom, con campos extra. */
  isAgency?: boolean;
}

export function listProducts(
  opts: AliclikClientOpts,
  p: ListProductsParams = {},
): Promise<AliclikResult<AliclikProductPage>> {
  return request<AliclikProductPage>(opts, "GET", "/integration/product/public", {
    retry: true,
    params: {
      page: Math.max(1, p.page ?? 1),
      limit: Math.min(100, Math.max(1, p.limit ?? 100)),
      search: p.search,
      categoryId: p.categoryId,
      isAgency: p.isAgency ? "true" : undefined,
    },
  });
}

/**
 * Recorre todas las páginas del catálogo. `maxPages` es un tope de seguridad:
 * un `count` inconsistente no debe convertirse en un bucle infinito contra la
 * API de un tercero.
 */
export async function listAllProducts(
  opts: AliclikClientOpts,
  p: Omit<ListProductsParams, "page"> = {},
  maxPages = 100,
): Promise<AliclikResult<AliclikProduct[]>> {
  const out: AliclikProduct[] = [];
  const limit = Math.min(100, Math.max(1, p.limit ?? 100));
  for (let page = 1; page <= maxPages; page++) {
    const res = await listProducts(opts, { ...p, page, limit });
    if (!res.ok) return res;
    const batch = res.data.result ?? [];
    out.push(...batch);
    // Se para por página corta (la señal fiable) o al cubrir el total anunciado.
    if (batch.length < limit) break;
    if (typeof res.data.count === "number" && out.length >= res.data.count) break;
  }
  return { ok: true, data: out };
}

// ---------------------------------------------------------------------------
// Contraentrega
// ---------------------------------------------------------------------------

/**
 * Cotiza el envío. Los tres parámetros son obligatorios para Aliclik.
 * `lat`/`lng` van como STRING decimal — ver toAliclikCoord() en lib/aliclik-geo.ts.
 *
 * Sin cobertura la API responde 200 con `couriers: []`, no un error.
 */
export function quoteShippingCost(
  opts: AliclikClientOpts,
  p: { warehouseId: number; lat: string; lng: string },
): Promise<AliclikResult<AliclikShippingCost>> {
  return request<AliclikShippingCost>(opts, "GET", "/integration/order/shipping/cost", {
    retry: true,
    params: { warehouseId: p.warehouseId, lat: p.lat, lng: p.lng },
  });
}

export function createOrder(
  opts: AliclikClientOpts,
  body: AliclikCreateOrderInput,
): Promise<AliclikResult<AliclikCreateOrderResult>> {
  return request<AliclikCreateOrderResult>(opts, "POST", "/integration/order", { body });
}

export interface ListOrdersParams {
  page?: number;
  limit?: number;
  /** Búsqueda parcial (contains), no igualdad. */
  orderNumber?: string;
  callStatus?: string;
  status?: string;
  dispatchStatus?: string;
  startDate?: string;
  endDate?: string;
}

export function listOrders(
  opts: AliclikClientOpts,
  p: ListOrdersParams = {},
): Promise<AliclikResult<AliclikOrderPage>> {
  return request<AliclikOrderPage>(opts, "GET", "/integration/order", {
    retry: true,
    params: {
      page: Math.max(1, p.page ?? 1),
      limit: Math.min(100, Math.max(1, p.limit ?? 100)),
      orderNumber: p.orderNumber,
      callStatus: p.callStatus,
      status: p.status,
      dispatchStatus: p.dispatchStatus,
      startDate: p.startDate,
      endDate: p.endDate,
    },
  });
}

/**
 * Un pedido concreto. `orderNumber` en la API es búsqueda PARCIAL, así que hay
 * que filtrar por igualdad exacta al recibir: pedir "ALC1" podría devolver
 * "ALC12". Devuelve null cuando no existe.
 */
export async function getOrder(
  opts: AliclikClientOpts,
  orderNumber: string,
): Promise<AliclikResult<AliclikOrder | null>> {
  const res = await listOrders(opts, { orderNumber, limit: 100 });
  if (!res.ok) return res;
  const exact = (res.data.data ?? []).find((o) => o.orderNumber === orderNumber) ?? null;
  return { ok: true, data: exact };
}

export function cancelOrder(
  opts: AliclikClientOpts,
  orderNumber: string,
): Promise<AliclikResult<AliclikMessageResult>> {
  return request<AliclikMessageResult>(opts, "POST", "/integration/order/cancel", {
    body: { orderNumber },
  });
}

// ---------------------------------------------------------------------------
// Agencia (Shalom)
// ---------------------------------------------------------------------------

export function listAgencies(
  opts: AliclikClientOpts,
): Promise<AliclikResult<AliclikAgency[]>> {
  return request<AliclikAgency[]>(opts, "GET", "/integration/order/agencies", { retry: true });
}

export function listPackageSizes(
  opts: AliclikClientOpts,
): Promise<AliclikResult<AliclikPackageSize[]>> {
  return request<AliclikPackageSize[]>(opts, "GET", "/integration/order/package-sizes", { retry: true });
}

export function createAgencyOrder(
  opts: AliclikClientOpts,
  body: AliclikAgencyOrderInput,
): Promise<AliclikResult<AliclikCreateOrderResult>> {
  return request<AliclikCreateOrderResult>(opts, "POST", "/integration/order/agency", { body });
}

export function cancelAgencyOrder(
  opts: AliclikClientOpts,
  orderNumber: string,
): Promise<AliclikResult<AliclikMessageResult>> {
  return request<AliclikMessageResult>(opts, "POST", "/integration/order/agency/cancel", {
    body: { orderNumber },
  });
}

// ---------------------------------------------------------------------------
// Interpretación de la cancelación
// ---------------------------------------------------------------------------

export type CancelOutcome = "cancelled" | "not_confirmed" | "unknown";

/**
 * TRAMPA DOCUMENTADA: `POST /integration/order/cancel` responde 201 aunque NO
 * haya cancelado. Si el pedido no está confirmado (callStatus ≠ CONFIRMED),
 * Aliclik se limita a añadirle la nota "Cancelar pedido." y contesta
 * `{"message": "Pedido no confirmado."}` — con el mismo 201 que un éxito.
 *
 * Mirar el código HTTP y dar por cancelado sería mentirle al equipo: el pedido
 * sigue vivo y va a salir a reparto. Por eso el resultado se decide leyendo el
 * mensaje, y por eso esta función es pura y está testeada.
 */
export function interpretCancelResponse(message: string | null | undefined): CancelOutcome {
  const m = (message ?? "").toLowerCase();
  if (!m) return "unknown";
  if (m.includes("no confirmado")) return "not_confirmed";
  if (m.includes("cancelado") || m.includes("anulado")) return "cancelled";
  return "unknown";
}
