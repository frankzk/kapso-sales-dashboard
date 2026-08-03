// Cliente de la API de Shalom (api.shalom-api-peru.com).
//
//   POST /v1/shalom/sessions   {email,password}  → ssk_… (TTL 2 h)
//   GET  /v1/agencies/search   ?q=               → agencias (solo API key)
//   GET  /v1/products                            → catálogo de cajas de la cuenta
//   GET  /v1/persons/search    ?document&type    → autocompletar destinatario
//   POST /v1/tariff/calculate                    → cotizar sin comprometer
//   POST /v1/orders                              → crear la guía real
//   GET  /v1/orders            ?page&per_page    → verificar tras un timeout
//   GET  /v1/orders/{ose}/label                  → rótulo PDF
//
// Dos cosas mandan sobre el diseño de este cliente:
//
//  1. LA PRIMERA LLAMADA DE CADA CUENTA TARDA ~90 s (hasta 2 min): el wrapper
//     hace un login real contra pro.shalom.pe. Por eso el token de sesión se
//     saca aparte y se guarda en la tienda (0061): `POST /v1/shalom/sessions`
//     es una LECTURA, reintentable sin riesgo, y concentra ahí toda la lentitud.
//
//  2. `POST /v1/orders` NO ES IDEMPOTENTE y crea una guía real y cobrable. No
//     se reintenta nunca a ciegas — ni siquiera con un 401. Ante un corte se va
//     a buscar la guía con `GET /v1/orders` (findCreatedOrder), porque un
//     reintento a ciegas despacharía dos veces el mismo paquete.
//
// SERVER-ONLY: recibe la API key y el token de sesión ya descifrados.

import {
  ShalomApiError,
  ShalomTimeoutError,
  SHALOM_API_BASE,
  type ShalomAccountOrder,
  type ShalomAgency,
  type ShalomOrderPayload,
  type ShalomOrderResult,
  type ShalomPerson,
  type ShalomProduct,
  type ShalomTrackResult,
  type ShalomSession,
  type ShalomTariff,
} from "./types";

/** Para las llamadas que pueden pagar el login real. La documentación pide ≥150 s. */
export const SLOW_TIMEOUT_MS = 170_000;
/** Para las llamadas con la sesión ya caliente. */
export const FAST_TIMEOUT_MS = 45_000;
/**
 * Crear la orden con la sesión caliente es rápido, pero un margen corto de más
 * es exactamente el error que la documentación advierte: el cliente se corta,
 * la guía se crea igual, y nadie se entera.
 */
export const CREATE_TIMEOUT_MS = 120_000;

export interface ShalomClientOpts {
  apiKey: string;
  /** Token `ssk_…` vigente. Tiene precedencia sobre email/password. */
  sessionToken?: string | null;
  /** Alternativa directa: el password viaja en cada llamada. Solo para la sonda. */
  email?: string | null;
  password?: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface RequestInitLike {
  method?: string;
  body?: unknown;
  /** ¿Esta ruta necesita credenciales de Shalom Pro, o basta la API key? */
  shalomAuth?: boolean;
  timeoutMs?: number;
  /** Devuelve el cuerpo crudo (para el PDF del rótulo). */
  raw?: boolean;
}

/** Cupo restante del rate limit, leído de las cabeceras de CUALQUIER respuesta. */
export interface ShalomRateLimit {
  limit: number | null;
  remaining: number | null;
  resetAt: number | null;
}

function readRateLimit(headers: Headers): ShalomRateLimit {
  const num = (h: string): number | null => {
    const v = headers.get(h);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    limit: num("x-ratelimit-limit"),
    remaining: num("x-ratelimit-remaining"),
    resetAt: num("x-ratelimit-reset"),
  };
}

/**
 * Mensaje y código del envelope `{error:{code,message,request_id}}`. El
 * `request_id` se conserva en el mensaje: es lo único que el proveedor puede
 * buscar en sus logs cuando haya que reclamarle una guía.
 */
function parseError(status: number, body: unknown): { message: string; code: string | null } {
  if (typeof body === "string" && body.trim()) {
    return { message: body.trim().slice(0, 300), code: null };
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const err = (obj.error ?? {}) as Record<string, unknown>;
  const code = typeof err.code === "string" ? err.code : null;
  const base = typeof err.message === "string" && err.message ? err.message : `Shalom respondió ${status}.`;
  const reqId = typeof err.request_id === "string" ? err.request_id : null;

  // Las filas malas del carga masiva vienen fuera del envelope de error.
  const rows = Array.isArray(obj.rows) ? obj.rows : null;
  const rowDetail = rows
    ? " " +
      rows
        .slice(0, 5)
        .map((r) => {
          const row = r as { row?: unknown; errors?: unknown };
          const errs = Array.isArray(row.errors) ? row.errors.join(", ") : "";
          return `fila ${row.row}: ${errs}`;
        })
        .join("; ")
    : "";

  return {
    message: `${base.slice(0, 300)}${rowDetail}${reqId ? ` (request_id ${reqId})` : ""}`,
    code,
  };
}

export class ShalomClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  /** Última lectura del rate limit. Sirve para avisar antes de chocar con el 429. */
  rateLimit: ShalomRateLimit = { limit: null, remaining: null, resetAt: null };

  constructor(private readonly opts: ShalomClientOpts) {
    this.base = (opts.baseUrl ?? SHALOM_API_BASE).replace(/\/$/, "");
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /** Cabeceras de credenciales del cliente. El token gana si están los dos. */
  private shalomHeaders(): Record<string, string> {
    if (this.opts.sessionToken) return { "X-Shalom-Session": this.opts.sessionToken };
    if (this.opts.email && this.opts.password) {
      return { "X-Shalom-Email": this.opts.email, "X-Shalom-Password": this.opts.password };
    }
    throw new ShalomApiError(
      "Falta la sesión de Shalom Pro. Conéctate antes de crear la guía.",
      401,
      "shalom_auth_failed",
    );
  }

  private async request<T>(path: string, init: RequestInitLike = {}): Promise<T> {
    const headers: Record<string, string> = {
      accept: init.raw ? "application/pdf" : "application/json",
      "X-API-Key": this.opts.apiKey,
    };
    if (init.shalomAuth) Object.assign(headers, this.shalomHeaders());
    if (init.body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? FAST_TIMEOUT_MS),
      });
    } catch (err) {
      // Un abort o un fallo de red son indistinguibles desde acá, y para la
      // creación de órdenes ambos significan lo mismo: no se sabe si se creó.
      const reason = err instanceof Error ? err.message : String(err);
      throw new ShalomTimeoutError(`No hubo respuesta de Shalom (${reason}).`);
    }

    this.rateLimit = readRateLimit(res.headers);

    if (init.raw) {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          /* se queda como texto */
        }
        const { message, code } = parseError(res.status, parsed);
        throw new ShalomApiError(message, res.status, code, parsed);
      }
      return (await res.arrayBuffer()) as unknown as T;
    }

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* se queda como texto: sirve igual para el mensaje de error */
    }
    if (!res.ok) {
      const { message, code } = parseError(res.status, parsed);
      throw new ShalomApiError(message, res.status, code, parsed);
    }
    return parsed as T;
  }

  // ── Sesión ────────────────────────────────────────────────────────────────

  /**
   * Canjea email + password por un `ssk_…` de 2 horas. ESTA es la llamada lenta
   * (~90 s a 2 min): es una lectura, así que reintentarla no crea nada.
   */
  async createSession(email: string, password: string): Promise<ShalomSession> {
    // Reintento acotado para los fallos PASAJEROS del propio proveedor: el 502
    // «login-service: el worker no está listo (bootstrap pendiente)» sale de su
    // contenedor de login arrancando, no de las credenciales ni de la llamada.
    // El mensaje ya decía «se puede reintentar» y no lo hacía nadie: lo tenía
    // que pulsar la operadora a mano.
    //
    // Reintentar acá es seguro: si no hubo token, no hay nada que duplicar ni
    // que invalidar. Y sale barato porque un 502 vuelve enseguida, a diferencia
    // del login bueno, que tarda ~90 s.
    for (let attempt = 0; ; attempt++) {
      try {
        const body = await this.request<ShalomSession>("/v1/shalom/sessions", {
          method: "POST",
          body: { email, password },
          timeoutMs: SLOW_TIMEOUT_MS,
        });
        if (!body?.session_token) {
          throw new ShalomApiError("Shalom no devolvió token de sesión.", 200, null, body);
        }
        return body;
      } catch (err) {
        const wait = shalomRetryDelay(err, attempt);
        if (wait === null) throw err;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  /** Revoca el token. Idempotente del lado de la API. */
  async revokeSession(): Promise<void> {
    await this.request("/v1/shalom/sessions", { method: "DELETE", shalomAuth: true });
  }

  // ── Catálogos ─────────────────────────────────────────────────────────────

  /** Agencias. Solo pide API key, así que responde rápido y sin sesión. */
  async searchAgencies(params: {
    q?: string;
    departamento?: string;
    provincia?: string;
  }): Promise<ShalomAgency[]> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    const body = await this.request<{ items?: ShalomAgency[] } | ShalomAgency[]>(
      `/v1/agencies/search?${qs.toString()}`,
    );
    // La documentación muestra `items` en /v1/agencies; /search se lee de las
    // dos formas para no depender de cuál de las dos devuelve.
    return Array.isArray(body) ? body : (body?.items ?? []);
  }

  async getAgency(id: number): Promise<ShalomAgency> {
    return this.request<ShalomAgency>(`/v1/agencies/${id}`);
  }

  /** Catálogo de cajas de la cuenta. Necesita credenciales de Shalom Pro. */
  async products(): Promise<ShalomProduct[]> {
    const body = await this.request<{ products?: ShalomProduct[] }>("/v1/products", {
      shalomAuth: true,
      // Puede ser la primera llamada de la cuenta si la sesión se emitió en otro
      // proceso: se le da el margen largo.
      timeoutMs: SLOW_TIMEOUT_MS,
    });
    return body?.products ?? [];
  }

  /** Resuelve un documento a una persona ya registrada. 404 = no existe. */
  async findPerson(document: string, type: string): Promise<ShalomPerson | null> {
    try {
      return await this.request<ShalomPerson>(
        `/v1/persons/search?document=${encodeURIComponent(document)}&type=${encodeURIComponent(type)}`,
        { shalomAuth: true },
      );
    } catch (err) {
      // Que no exista es información, no un fallo: se registra al crear la orden.
      if (err instanceof ShalomApiError && err.status === 404) return null;
      throw err;
    }
  }

  async tariff(body: {
    origin_terminal_id: number;
    destiny_terminal_id: number;
    product_id?: number;
    dimensions?: { weight_kg: number; height_m: number; length_m: number; width_m: number };
  }): Promise<ShalomTariff> {
    return this.request<ShalomTariff>("/v1/tariff/calculate", {
      method: "POST",
      body,
      shalomAuth: true,
    });
  }

  // ── Órdenes ───────────────────────────────────────────────────────────────

  /**
   * Crea la guía. UNA sola llamada, sin reintentos de ningún tipo — ni siquiera
   * con un 401, a diferencia del cliente de Tanders. Acá un reintento no es
   * gratis: si el primer POST llegó a Shalom, el segundo emite una guía real y
   * cobrable más. Un corte sale como ShalomTimeoutError para que quien llama
   * vaya a `findCreatedOrder` en vez de repetir.
   */
  async createOrder(payload: ShalomOrderPayload): Promise<ShalomOrderResult> {
    return this.request<ShalomOrderResult>("/v1/orders", {
      method: "POST",
      body: payload,
      shalomAuth: true,
      timeoutMs: CREATE_TIMEOUT_MS,
    });
  }

  /**
   * ¿Existe esta guía en la cuenta de Shalom Pro? `null` si no aparece.
   *
   * Contesta la pregunta que el rastreo deja abierta: un `not_found` del
   * rastreo puede ser "la borraron", "nunca se emitió" o "el rastreo no la ve
   * todavía", y son cosas muy distintas. Acá se mira el listado de la CUENTA,
   * que es lo mismo que haría una persona entrando a pro.shalom.pe.
   *
   * Usa el filtro `guia` del propio endpoint —match exacto— en vez de traerse
   * las órdenes y buscar en memoria: una cuenta con miles pesa megabytes.
   */
  async findOrderByGuia(guia: string): Promise<ShalomAccountOrder | null> {
    const body = await this.request<{ orders?: ShalomAccountOrder[] }>(
      `/v1/orders?guia=${encodeURIComponent(guia)}&per_page=5`,
      { shalomAuth: true, timeoutMs: SLOW_TIMEOUT_MS },
    );
    return body?.orders?.[0] ?? null;
  }

  /** Últimas órdenes de la cuenta. Paginado SIEMPRE: sin `per_page` una cuenta
   *  grande devuelve megabytes (la documentación avisa: ~3 KB por orden). */
  async recentOrders(perPage = 50): Promise<ShalomAccountOrder[]> {
    const body = await this.request<{ orders?: ShalomAccountOrder[] }>(
      `/v1/orders?page=1&per_page=${perPage}`,
      { shalomAuth: true, timeoutMs: SLOW_TIMEOUT_MS },
    );
    return body?.orders ?? [];
  }

  /**
   * Rastrea UNA guía. Mismo «modo estado» que el batch: le basta la API key.
   *
   * Existe aparte del batch para poder comparar los dos caminos con la misma
   * guía, que es como se encontró que el rastreo pide DOS identificadores.
   */
  async track(numero: string): Promise<unknown> {
    return this.trackBy("numero", numero);
  }

  /**
   * Rastrea por los identificadores que se le pasen.
   *
   * `numero` Y `codigo` VAN JUNTOS. Se comprobó contra la API: pedir solo el
   * número devuelve «Ingrese un código de orden», y pedir solo el código
   * devuelve «Ingrese un número de orden». Se reclaman el uno al otro, y ninguno
   * de los dos mensajes deja adivinar eso por separado — parecen «no existe».
   *
   * `ose_id` sí resuelve él solo.
   */
  async trackBy(
    field: "numero" | "codigo" | "ose_id",
    value: string,
    codigo?: string | null,
  ): Promise<unknown> {
    const qs = new URLSearchParams({ [field]: value });
    if (field === "numero" && codigo) qs.set("codigo", codigo);
    return this.request(`/v1/tracking?${qs.toString()}`);
  }

  /**
   * Rastrea hasta 50 guías de una vez.
   *
   * NO pide `shalomAuth`, y eso es lo que la hace viable en un cron: el «modo
   * estado» del rastreo se contenta con la API key global, así que no hay que
   * pagar el login de ~90 s ni tener credenciales de ninguna tienda. El modo
   * detallado añadiría `order`, pero sus bloques útiles llegan vacíos desde julio
   * de 2026 — no hay razón para pedirlo.
   *
   * CADA ITEM NECESITA `numero` + `codigo`, o bien `ose_id`. Mandar solo el
   * número devuelve `upstream_rejected: Ingrese un código de orden` en el 100 %
   * de los items, con HTTP 200 y sin que nada más falle: es lo que tuvo 93 guías
   * paradas sin que se notara.
   *
   * `ose_id` VA COMO STRING, aunque en nuestra base sea un bigint. Mandarlo como
   * número devuelve `400 body JSON inválido`, y ese 400 tumba el LOTE ENTERO —no
   * el item—, así que un tipo mal puesto deja sin rastrear a las 50 guías de la
   * tanda. Por eso el tipo lo pide string: que no compile es más barato que
   * descubrirlo en producción.
   *
   * Un item que falla NO tumba el batch: viene con `ok:false` y su error, y el
   * HTTP sigue siendo 200. Por eso el llamador itera resultados en vez de
   * confiar en que la ausencia de excepción signifique que todo salió bien.
   */
  async trackBatch(
    items: { custom_id: string; numero?: string; codigo?: string; ose_id?: string }[],
  ): Promise<ShalomTrackResult[]> {
    const body = await this.request<{ results?: ShalomTrackResult[] }>("/v1/tracking/batch", {
      method: "POST",
      body: { items },
    });
    return body?.results ?? [];
  }

  async deleteOrder(id: number): Promise<void> {
    await this.request(`/v1/orders/${id}`, { method: "DELETE", shalomAuth: true });
  }

  /** Rótulo PDF. `ose_id`, no `guia` ni `id` — ver Identificadores. */
  async label(oseId: number): Promise<ArrayBuffer> {
    return this.request<ArrayBuffer>(`/v1/orders/${oseId}/label`, { shalomAuth: true, raw: true });
  }
}

/**
 * Busca en las órdenes recientes la que acabamos de intentar crear. Es la
 * respuesta al único escenario verdaderamente peligroso de esta integración: el
 * POST se cortó y no sabemos si la guía existe.
 *
 * Se casa por documento del destinatario + clave de recojo. Ninguno de los dos
 * es único por sí solo (la clave son 4 dígitos), pero juntos y acotados a las
 * órdenes recientes identifican la guía sin ambigüedad práctica. Si hay más de
 * una coincidencia se devuelve null: es mejor que un humano mire a que el
 * sistema adopte la guía equivocada.
 */
export function findCreatedOrder(
  orders: readonly ShalomAccountOrder[],
  match: { document: string; pickupCode: string },
): ShalomAccountOrder | null {
  const hits = orders.filter((o) => {
    const doc = (o.receiver?.document ?? "").trim();
    const code = (o.pickup_code ?? "").trim();
    return doc === match.document && code === match.pickupCode;
  });
  return hits.length === 1 ? (hits[0] as ShalomAccountOrder) : null;
}

/** ¿El token de sesión sigue vivo? Con margen, para no mandarlo justo al vencer. */
export function sessionIsFresh(expiresAt: string | null | undefined, skewMs = 120_000): boolean {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) && ms - skewMs > Date.now();
}

/**
 * Por qué falló la prueba de la API key global, que es la primera mitad de
 * «Probar conexión».
 *
 * Va aparte de `describeShalomError` porque acá un **404 no dice nada de la
 * key**: si la ruta no existe, Shalom ni siquiera llegó a mirar la cabecera de
 * autenticación. Llamarlo «la API key no funciona» —que es lo que hacía— manda
 * a pedir una key nueva al proveedor cuando lo que está mal es la URL base del
 * despliegue, y eso puede costar días de ida y vuelta por WhatsApp.
 *
 * Por eso el mensaje incluye la URL exacta que se intentó: con verla al lado del
 * host correcto, el `/v1` de más salta a la vista.
 */
export function describeShalomProbeFailure(err: unknown, baseUrl: string): string {
  if (err instanceof ShalomApiError && err.status === 404) {
    return (
      `La URL base de Shalom no responde donde se espera (404): se intentó ` +
      `${baseUrl}/v1/agencies/search.\n\n` +
      `La ruta es correcta, así que lo que sobra o falta está en la base. Revisa ` +
      `SHALOM_API_BASE en las variables del despliegue: tiene que ser el host a ` +
      `secas — https://api.shalom-api-peru.com — sin /v1 ni ninguna otra ruta ` +
      `detrás, porque el cliente ya la añade. Si la variable no existe, el valor ` +
      `por defecto ya es el bueno: borrarla también arregla esto.`
    );
  }
  if (err instanceof ShalomApiError && (err.status === 401 || err.status === 403)) {
    return `La API key del wrapper fue rechazada (${err.status}): ${describeShalomError(err)}`;
  }
  return `No se pudo probar la API key contra ${baseUrl}: ${describeShalomError(err)}`;
}

/** Espera antes del siguiente intento, o `null` si no hay que reintentar. */
const SESSION_RETRY_WAITS_MS = [2_000, 5_000];

/**
 * ¿Merece la pena reintentar este fallo al pedir la sesión?
 *
 * Solo los 5xx de PASO: son del proveedor y se arreglan solos en segundos —
 * típicamente su `login-service` terminando de arrancar. Todo lo demás se
 * propaga tal cual: un 401 es una credencial mala y reintentarla no la mejora,
 * y un 429 con el cupo agotado solo empeoraría gastando más.
 *
 * NUNCA se reintenta un timeout. Ese ya se comió los ~170 s de presupuesto de la
 * petición, y encadenar otro se llevaría por delante el `maxDuration` de la
 * página, cambiando un error explicado por una pantalla colgada.
 */
export function shalomRetryDelay(err: unknown, attempt: number): number | null {
  if (!(err instanceof ShalomApiError)) return null;
  if (err.status !== 502 && err.status !== 503 && err.status !== 504) return null;
  return SESSION_RETRY_WAITS_MS[attempt] ?? null;
}

/**
 * Traduce un fallo de la API a algo accionable para el operador. Los códigos
 * salen de la tabla de errores de la documentación.
 */
export function describeShalomError(err: unknown): string {
  if (err instanceof ShalomTimeoutError) return err.message;
  if (!(err instanceof ShalomApiError)) {
    return err instanceof Error ? err.message : "Error desconocido de Shalom.";
  }
  const hint =
    err.code === "shalom_auth_failed"
      ? " Vuelve a conectar la cuenta de Shalom Pro: el token dura 2 horas."
      : err.code === "unauthorized"
        ? // El `unauthorized` es SIEMPRE de la API key global del wrapper: las
          // credenciales de la tienda fallan con `shalom_auth_failed`, que es el
          // caso de arriba. Decía «revísala en Ajustes → Tienda» y ahí no está
          // ni puede estar — es de la cuenta de Kapso y sirve para todas las
          // tiendas. Mandar a un administrador a buscarla en una pantalla donde
          // no existe es peor que no dar pista ninguna.
          " Es la API key global del wrapper (SHALOM_API_KEY), que vive en las variables de entorno del despliegue, NO en los ajustes de la tienda. Si se pegó cortada o vencida, hay que corregirla ahí y volver a desplegar."
        : err.code === "rate_limited"
          ? // El cupo es de la API key, que es una sola para TODAS las tiendas:
            // se puede agotar sin que esta tienda haya hecho nada.
            " Se superaron las 60 llamadas por minuto de la API key, que es compartida por todas las tiendas: espera un momento."
          : err.code === "upstream_rejected"
            ? " Es una regla de negocio de Shalom (cuenta sin servicio de cobranza, producto restringido para esa ruta, etc.)."
            : err.code === "conflict"
              ? " Ya hay una persona registrada con ese documento con otros datos."
              : // Un 5xx que menciona su `login-service` es SU contenedor de
                // inicio de sesión caído o arrancando. No es la cuenta de la
                // tienda ni la API key ni el despliegue, y decir solo «no
                // respondió» manda a revisar credenciales que están bien —el
                // mismo error que ya costó tiempo con el 404 y con el 401.
                /login-service|bootstrap/i.test(err.message) &&
                  (err.status === 502 || err.status === 503 || err.status === 504)
                ? " ES UN FALLO DEL PROVEEDOR, no de tus credenciales ni de la configuración: su servicio de inicio de sesión está caído o arrancando. Ya se reintentó solo; si sigue, avísales con el request_id y usa pro.shalom.pe mientras tanto."
                : err.status === 502 || err.status === 503 || err.status === 504
                  ? " Shalom Pro no respondió; ya se reintentó solo y se puede volver a intentar."
                  : "";
  return `Shalom rechazó la solicitud (${err.status}): ${err.message}.${hint}`;
}
