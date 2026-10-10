// Swayp (ex-Fenix) last-mile API client.
// Docs: https://www.swayp.co/co/docs/ — panel: https://ce.swayp.co
//
// Everything below was verified against the staging API, not just read off the
// docs:
//
//   POST /v2/guias/quotation          — tarifa; no crea nada (200 / 400)
//   POST /v2/guias                    — crear guía → { success, data:{ guia, estado, idEstado } }
//   POST /v2/guias/updateMassiveGuides— idEstado "3" pedir recogida · "10" cancelar
//   GET  /v2/guias/{guia}             — consultar
//   POST /v2/guias/setNoveltySolution — resolver novedad (1 reintentar · 2 devolver · 3 reprogramar)
//
// Notes that shaped this client:
//   · Auth is THREE headers — Bearer + `email` (identifies the account) +
//     `x-country`. x-country defaults to CO on their side, so PE is explicit.
//   · There is NO login endpoint. The token is issued by hand per integrator,
//     so there is nothing to refresh: on a 401 we surface a clear error and the
//     caller alerts a human. See `isSwaypAuthError`.
//   · GET of a non-existent guide answers 200 with `{}`, not 404 — `getGuide`
//     turns that into null.
//   · Addresses must be ≥ 5 characters or the API 400s.
//   · Creation is NOT idempotent and takes no idempotency key: a retried POST
//     /v2/guias yields a second guide and a second package. Only reads and
//     quotes are retried here.
//   · Swayp only serves intra-city pairs (Arequipa→Arequipa ok, Arequipa→Cusco
//     rejected). Use `warehouseUbigeo` from lib/ubigeo.ts for the origin.

import { env } from "@/lib/env";
import { SWAYP_STATES } from "@/lib/swayp-states";

export interface SwaypClientOpts {
  token: string;
  email: string;
  baseUrl?: string;
  /** Operation country. Swayp defaults to "CO" when the header is absent. */
  country?: "PE" | "CO";
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Error carrying the HTTP status so callers can tell auth from validation. */
export class SwaypError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Swayp API HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "SwaypError";
    this.status = status;
    this.body = body;
  }
}

/**
 * True when the failure means "our credential no longer works" — el token no se
 * renueva por código, así que esto necesita que una persona actúe. Vale alertar
 * en vez de reintentar.
 *
 * OJO con `token expired`: Swayp lo devuelve TAMBIÉN cuando el token es
 * perfectamente válido pero el header `email` no corresponde al del token
 * —verificado contra su API: el mismo token da 200 con su email y 403
 * «Token expired» con cualquier otro—. Sigue siendo un problema de credencial,
 * y por eso sigue clasificando acá; lo que no se puede es decirle a alguien que
 * pida un token nuevo sin más. Para eso está `swaypAuthErrorHint()`.
 */
export function isSwaypAuthError(err: unknown): boolean {
  if (!(err instanceof SwaypError)) return false;
  if (err.status === 401) return true;
  // A bare 403 is NOT enough: any intermediary (corporate proxy, egress
  // gateway, WAF) answers 403 too, and treating that as a dead credential
  // would page someone over a network policy. Match Swayp's own wording.
  return /token expired|no tienes autorizaci|no tienes permisos/i.test(err.body);
}

/** Formato de un JWT: tres segmentos base64url. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * El `sub` del token, cuando es un JWT y lo trae en forma de email. Devuelve
 * null si no se puede saber —token opaco, JWT sin `sub`, base64 corrupto—, para
 * que quien llame no invente un diagnóstico sobre una suposición.
 *
 * No valida la firma ni la expiración: no es autenticación, es sólo leer a
 * nombre de quién se emitió para poder explicar un 403.
 */
export function swaypTokenSubject(token: string): string | null {
  const raw = token.trim();
  if (!JWT_SHAPE.test(raw)) return null;
  const payload = raw.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub.includes("@") ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Qué decirle a la persona que va a leer el aviso cuando la credencial falla.
 *
 * Distingue el caso que la API NO distingue: si el token declara un `sub` y
 * `SWAYP_EMAIL` no coincide, el problema es la configuración —gratis de
 * arreglar— y no hay ningún token que pedir. Sin esta comprobación, el mensaje
 * manda a alguien a solicitar credenciales nuevas por un email mal escrito.
 */
export function swaypAuthErrorHint(opts: Pick<SwaypClientOpts, "token" | "email">): string {
  const sub = swaypTokenSubject(opts.token);
  const email = opts.email.trim();
  if (sub && sub.toLowerCase() !== email.toLowerCase()) {
    return (
      `SWAYP_EMAIL es «${email}» pero el token fue emitido para «${sub}». ` +
      `Swayp rechaza esa combinación diciendo «Token expired», que es engañoso: ` +
      `el token está bien, el email no. El token va atado a UN usuario, no a la ` +
      `organización, así que hay dos salidas: poner «${sub}» en SWAYP_EMAIL, o ` +
      `pedirle a Swayp un token emitido para «${email}».`
    );
  }
  return "La credencial de Swayp ya no es válida; hay que pedirle un token nuevo a Swayp.";
}

function baseFor(opts: SwaypClientOpts): string {
  return (opts.baseUrl ?? env.swaypApiBase()).replace(/\/$/, "");
}

function headersFor(opts: SwaypClientOpts): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.token}`,
    email: opts.email,
    "x-country": opts.country ?? "PE",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Single transport. `retry` is opt-in and only ever passed by reads/quotes —
 * never by guide creation, which would duplicate the shipment.
 */
async function swaypFetch<T>(
  opts: SwaypClientOpts,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  { retry = false }: { retry?: boolean } = {},
): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = baseFor(opts) + path;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastErr: unknown;
  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
    try {
      const res = await doFetch(url, {
        method,
        headers: headersFor(opts),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new SwaypError(res.status, text);
        // 5xx is worth one more shot; 4xx never is (it won't fix itself).
        if (retry && res.status >= 500 && attempt === 0) {
          lastErr = err;
          continue;
        }
        throw err;
      }
      return (await res.json()) as T;
    } catch (e) {
      // network/timeout — retry once when the call is safe to repeat
      if (retry && attempt === 0 && !(e instanceof SwaypError)) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Swayp API: unreachable");
}

// ── Cotización ───────────────────────────────────────────────────────────────

export interface SwaypQuoteInput {
  ciudadRemitente: string;
  direccionRemitente: string;
  ciudadDestinatario: string;
  direccionDestinatario: string;
  adicionalDireccion?: string;
  nitRemitente?: string | null;
  nitDestinatario?: string | null;
  idWarehouse?: number;
  peso: string;
  largo: string;
  alto: string;
  ancho: string;
  valorDeclarado: string;
  valorRecaudo: string;
  isExpress?: boolean;
}

export interface SwaypQuote {
  valorFlete: number;
  valorFleteTrayecto: number;
  valorFleteRecaudo: number;
  valorFleteSeguro: number;
  zona: string;
  distancia?: number | null;
}

/** Tarifa de un envío. No crea guía ni cambia estados — seguro de reintentar. */
export function quote(opts: SwaypClientOpts, input: SwaypQuoteInput): Promise<SwaypQuote> {
  return swaypFetch<SwaypQuote>(opts, "POST", "/v2/guias/quotation", input, { retry: true });
}

// ── Crear guía ───────────────────────────────────────────────────────────────

export interface SwaypCreateGuideInput {
  // remitente · origen
  nombreRemitente: string;
  nitRemitente: string;
  direccionRemitente: string;
  telefonoRemitente: string;
  telefonoRecogida: string;
  emailRemitente: string;
  ciudadRemitente: string;
  // destinatario · destino
  nombreDestinatario: string;
  nitDestinatario: string;
  direccionDestinatario: string;
  adicionalDireccion?: string;
  telefonoDestinatario: string;
  emailDestinatario: string;
  ciudadDestinatario: string;
  // pedido
  contenido: string;
  /**
   * Los productos como arreglo estructurado, que es como Swayp descuenta el
   * stock por CÓDIGO y no buscando por nombre.
   *
   * Estuvo sin mandarse un tiempo: no figura en su documentación, y al
   * preguntar por el catálogo su desarrollador respondió que «esa
   * funcionalidad no está disponible para consumir por API» —una frase sobre el
   * endpoint de LECTURA que dejaba la duda abierta sobre este campo—. Mandar un
   * campo que quizá no procesan podía devolver 400 y dejar al envío sin guía.
   *
   * El 14-09-2026 mandaron un `curl` de ejemplo, suyo, que lo incluye:
   * `"productos": [ { "codbar": "ABC123", "cantidad": 1, "nombre": "…" } ]`.
   * Con eso deja de ser una apuesta y se manda siempre que el pedido esté
   * vinculado en Catálogo de productos.
   *
   * `contenido` sigue viajando con los mismos códigos («2 x AURE001»): es
   * obligatorio y es lo que el mensajero lee.
   */
  productos?: Array<{ codbar: string; cantidad: number; nombre: string }>;
  idBusiness?: number;
  idWarehouse?: number;
  observaciones?: string;
  /** ISO 8601, sólo para entrega programada. */
  fechaEntrega?: string;
  isExpress?: boolean;
  // paquete
  peso: string;
  largo: string;
  alto: string;
  ancho: string;
  valorDeclarado: string;
  valorRecaudo: string;
}

export interface SwaypCreatedGuide {
  /** Número de guía de Swayp — el identificador permanente del envío. */
  guia: number;
  estado: string;
  idEstado: number;
}

/**
 * La respuesta real de POST /v2/guias NO es la documentada. La doc promete
 * `{success:true, data:{guia, estado, idEstado}}`; el servidor devuelve el
 * objeto de la guía plano (`{guia, guide, idRemitente, …}`) y con `idEstado`
 * como string. Aceptamos las dos formas: si Swayp alinea la API con su doc,
 * esto sigue funcionando.
 *
 * Importa acertarle: leer mal la respuesta hace creer que la creación falló
 * cuando la guía SÍ existe — y el fallback crearía una segunda.
 */
function normalizeCreated(res: unknown): SwaypCreatedGuide | null {
  const root = (res ?? {}) as Record<string, unknown>;
  const payload = (root.data ?? root) as Record<string, unknown>;
  const raw = payload.guia ?? payload.guide;
  const guia = Number(raw);
  if (!Number.isFinite(guia) || guia <= 0) return null;
  const idEstado = Number(payload.idEstado);
  return {
    guia,
    estado: typeof payload.estado === "string" ? payload.estado : "",
    idEstado: Number.isFinite(idEstado) ? idEstado : 1,
  };
}

/**
 * Crea la guía. Nace en estado 1 (Generada) o 2 (Preparada) según cómo esté
 * configurada la cuenta; NO despacha a nadie hasta llamar `requestPickup`.
 *
 * Sin reintento a propósito: la API no acepta clave de idempotencia, así que
 * repetir un POST que dio timeout crea una segunda guía y un segundo paquete.
 * Ante un fallo de red el llamador debe caer al alta manual, no reintentar.
 */
export async function createGuide(
  opts: SwaypClientOpts,
  input: SwaypCreateGuideInput,
): Promise<SwaypCreatedGuide> {
  const res = await swaypFetch<unknown>(opts, "POST", "/v2/guias", input);
  const created = normalizeCreated(res);
  if (!created) {
    const err = (res as { error?: string } | null)?.error;
    throw new SwaypError(200, err ?? JSON.stringify(res ?? {}));
  }
  return created;
}

// ── Cambios de estado en lote ────────────────────────────────────────────────

export interface SwaypBulkOutcome {
  guia: string;
  ok: boolean;
  message: string;
}

/**
 * updateMassiveGuides tampoco responde lo que dice la doc: no es
 * `{results:[{guia, success, estado}]}` sino un ARRAY pelado de
 * `{guia, exito, msg}` (verificado cancelando una guía real). Se normaliza acá
 * para que el llamador no dependa de la forma cruda.
 */
function normalizeBulk(res: unknown): SwaypBulkOutcome[] {
  const rows = Array.isArray(res)
    ? res
    : Array.isArray((res as { results?: unknown } | null)?.results)
      ? ((res as { results: unknown[] }).results)
      : [];
  return rows.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    const message = String(row.exito ?? row.msg ?? row.estado ?? row.error ?? "");
    return {
      guia: String(row.guia ?? ""),
      // `exito` presente (y sin `error`) es la señal de éxito de esta API.
      ok: row.success === true || (row.exito !== undefined && row.error === undefined),
      message,
    };
  });
}

async function updateMassive(
  opts: SwaypClientOpts,
  guias: string[],
  idEstado: "3" | "10",
): Promise<SwaypBulkOutcome[]> {
  const res = await swaypFetch<unknown>(opts, "POST", "/v2/guias/updateMassiveGuides", {
    guias,
    idEstado,
  });
  return normalizeBulk(res);
}

/** Pide la recogida (estado 3). Es lo que dispara la notificación al mensajero. */
export function requestPickup(opts: SwaypClientOpts, guias: string[]): Promise<SwaypBulkOutcome[]> {
  return updateMassive(opts, guias, "3");
}

/** Cancela guías. Sólo posible en estado 1 (Generada); después va devolución. */
export function cancelGuides(opts: SwaypClientOpts, guias: string[]): Promise<SwaypBulkOutcome[]> {
  return updateMassive(opts, guias, "10");
}

// ── Consulta ─────────────────────────────────────────────────────────────────

export interface SwaypGuide {
  guia?: number | string;
  estado?: string;
  idEstado?: number | string;
  [k: string]: unknown;
}

/**
 * Consulta una guía. La API responde 200 con `{}` cuando la guía no existe o no
 * pertenece a la cuenta, así que eso se traduce a null en vez de a un objeto
 * vacío que el llamador confundiría con datos.
 *
 * OJO: en el entorno de pruebas este endpoint **reventaba con 500 cuando la
 * guía estaba en novedad** —`TypeError: Cannot read properties of undefined
 * (reading 'novedadFoto')`—. Es un fallo del lado de Swayp. Lanza excepción,
 * que es lo correcto; el barrido de estados (lib/swayp-status-sweep.ts) la
 * cuenta con su motivo y reintenta en la pasada siguiente, así que si pasa en
 * producción se ve en su reporte en vez de perderse.
 *
 * Desde el 29-09-2026 es la fuente del estado: el webhook de Swayp solo ha
 * mandado entregas (7), nunca una novedad ni una devolución.
 */
export async function getGuide(
  opts: SwaypClientOpts,
  guia: string | number,
): Promise<SwaypGuide | null> {
  const res = await swaypFetch<SwaypGuide>(
    opts,
    "GET",
    `/v2/guias/${encodeURIComponent(String(guia))}`,
    undefined,
    { retry: true },
  );
  if (!res || Object.keys(res).length === 0) return null;
  return res;
}

// ── Productos (API de integraciones) ─────────────────────────────────────────

/**
 * GET /v1/integrations/products — los productos de la cuenta en la API de
 * integraciones, con la MISMA credencial que las guías. No está en la doc
 * pública (sólo /v2/guias); lo indicó la operación el 29-09-2026 como la vía
 * para leer el inventario. La forma de la respuesta todavía no se conoce: se
 * devuelve cruda y la pantalla de Stock Swayp la muestra para fijar el mapeo.
 */
export async function listIntegrationProducts(
  opts: SwaypClientOpts,
  query: Record<string, string> = {},
): Promise<unknown> {
  const qs = new URLSearchParams(query).toString();
  return swaypFetch<unknown>(opts, "GET", `/v1/integrations/products${qs ? `?${qs}` : ""}`, undefined, {
    retry: true,
  });
}

// ── Novedades ────────────────────────────────────────────────────────────────

export interface SwaypNoveltySolution {
  guia: string;
  /** "1" volver a ofrecer · "2" devolver al remitente · "3" reprogramar */
  accion: "1" | "2" | "3";
  comentario: string;
  /** Sólo para accion "3"; se ignora en el resto. ISO 8601. */
  fechaEntrega?: string;
  photo?: string[];
  geoReferencia?: { url?: string; coords?: { lat: number; lon: number } };
}

/**
 * Lo que contesta `setNoveltySolution`, verificado sobre una novedad real —no
 * es lo que sugería la documentación, que no publica la respuesta—:
 *
 *   {"status":200,"msg":"Actualizado Con Exito!","guia":50000004102,
 *    "accion":{"codigo":"3","tipo":"Reprogramar"},
 *    "cambios":{"estado":"Solucionado","codigoEstado":"5",
 *               "fechaSolucionado":"…","fechaReprogramada":"…",
 *               "partnerNotificado":false}}
 *
 * `cambios.codigoEstado` es el estado al que queda la guía: reprogramar la
 * devuelve a 5 (Reparto), no a un estado propio de «reprogramada». Se tipa pero
 * NO se usa para escribir `delivery_status`: el estado sigue llegando por el
 * webhook, que es la única fuente que también cubre lo que pasa después.
 */
export interface SwaypNoveltyResult {
  status?: number;
  msg?: string;
  guia?: number | string;
  accion?: { codigo?: string; tipo?: string };
  cambios?: {
    estado?: string;
    codigoEstado?: string;
    fechaSolucionado?: string;
    fechaReprogramada?: string;
    /** Falso en pruebas; conviene confirmar con Swayp qué implica en producción. */
    partnerNotificado?: boolean;
  };
  [k: string]: unknown;
}

/** Responde una novedad de tipo Gestión. */
export function solveNovelty(
  opts: SwaypClientOpts,
  input: SwaypNoveltySolution,
): Promise<SwaypNoveltyResult> {
  return swaypFetch(opts, "POST", "/v2/guias/setNoveltySolution", input);
}

// ── Estados ──────────────────────────────────────────────────────────────────

// Vive en lib/swayp-states.ts para que el navegador pueda nombrar un estado
// sin cargar este cliente, que lee la credencial del entorno.
export { SWAYP_STATES };

/**
 * Swayp state → this app's `delivery_status` (see DELIVERY_STATUSES in
 * lib/shipments.ts). The app models 5 statuses and none of them means
 * "returning", so the mapping is deliberately lossy and the raw Swayp state is
 * stored alongside it:
 *
 *   1·2·3 aún en bodega                                  → pendiente
 *   4·5   en manos del mensajero                         → en_ruta
 *   6     novedad: el mensajero lo tiene y espera instrucción → en_ruta
 *   8     devolución: el paquete vuelve; aún se puede revertir → en_ruta
 *   7     entregada                                      → entregado
 *   9·12  devolución confirmada: la guía terminó sin entregar → anulado
 *   10·11 cancelada / indemnizada                        → anulado
 *
 * 6 y 8 eran `pendiente` hasta el 29-09-2026. Nunca se notaba porque el webhook
 * de Swayp solo ha mandado entregas, pero al leerlos de la API el Master los
 * habría leído como «todavía no salió» y el pedido habría vuelto a «Por armar»
 * con el paquete en la calle. El paquete está con el mensajero, igual que el
 * `RETURNING` de Tanders; qué espera lo dice `swayp_state`.
 *
 * Returns null for an unknown code so the caller leaves the row untouched
 * rather than writing a wrong status.
 */
export function mapSwaypState(idEstado: number | string): string | null {
  const id = Number(idEstado);
  if (!Number.isFinite(id)) return null;
  if (id === 1 || id === 2 || id === 3) return "pendiente";
  if (id === 4 || id === 5 || id === 6 || id === 8) return "en_ruta";
  if (id === 7) return "entregado";
  if (id === 9 || id === 10 || id === 11 || id === 12) return "anulado";
  return null;
}

/**
 * Los estados en los que Swayp NO ENTREGÓ y el paquete vuelve o ya volvió al
 * origen: Devolución (8), Devolución confirmada (9) y con cobro (12). Son el
 * `RETURNING`/`RETURNED` de Swayp, y abren la recuperación del pedido igual que
 * los de Tanders (lib/reproprovincia.ts). 10 (Cancelada) no: no dice que el
 * paquete saliera.
 */
export const SWAYP_RETURN_STATES: ReadonlySet<number> = new Set([8, 9, 12]);

/**
 * Dónde está el paquete según el estado de Swayp, en el escalafón de custodia
 * del MOM. `null` = el estado no lo dice (en bodega de Swayp, cancelada,
 * entregada): no se toca.
 *
 * 9 y 12 se quedan en `retorno`, no en `devuelto`: «Devolución confirmada» es
 * que llegó a la bodega de SWAYP, y el MOM §9.4 dice que la caja se recoge cada
 * semana o cada quince días y que la salida sigue abierta hasta recibirla. El
 * `devuelto` lo pone quien la recibe.
 */
export function swaypCustodyFor(idEstado: number): "courier" | "retorno" | null {
  if (idEstado === 4 || idEstado === 5 || idEstado === 6) return "courier";
  if (SWAYP_RETURN_STATES.has(idEstado)) return "retorno";
  return null;
}

function normalizeLabel(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * El texto de `estado` → su código. Los nombres son los que Swayp escribe en la
 * guía (vistos el 29-09-2026), sin tildes ni mayúsculas. «Solucionado» es el
 * Reparto al que vuelve una novedad resuelta.
 */
const STATE_BY_LABEL: Record<string, number> = {
  generada: 1,
  preparada: 2,
  "por recolectar": 3,
  asignada: 4,
  reparto: 5,
  "en reparto": 5,
  solucionado: 5,
  novedad: 6,
  entregada: 7,
  entregado: 7,
  devolucion: 8,
  "devolucion confirmada": 9,
  cancelada: 10,
  indemnizada: 11,
  "devolucion confirmada con cobro": 12,
};

/** Código del texto de un estado de Swayp, o null si no lo conocemos. */
export function swaypStateFromLabel(label: string | null | undefined): number | null {
  if (typeof label !== "string") return null;
  return STATE_BY_LABEL[normalizeLabel(label)] ?? null;
}

/** Lo que se sabe de una guía leída con `GET /v2/guias/{guia}`. */
export interface SwaypGuideReading {
  /** Código 1..12, o null si el `estado` no se pudo traducir. */
  state: number | null;
  /** El `estado` tal cual vino, para aprender de lo que no se tradujo. */
  label: string | null;
  /** Cuándo salió a reparto, si Swayp lo dice. */
  departedAt: string | null;
  /** Cuándo entró al estado actual, si Swayp lo dice. */
  changedAt: string | null;
  /** La última novedad del historial (id del catálogo de Swayp y nombre), si hubo. */
  novelty: { id: number | null; name: string | null } | null;
}

/**
 * Las novedades de Swayp que son un RECHAZO EN LA PUERTA: el mensajero llegó y
 * el destinatario no quiso el producto. Del catálogo público de Swayp
 * («Catálogo completo de novedades», 29-09-2026): 16 «Destinatario ya no desea
 * el producto» y 15 «Destinatario no ha comprado ningún producto». Son el
 * `REFUSED` de Aliclik: a quien lo rechazó teniéndolo delante no lo llama el
 * agente de voz (MOM §11.8). «Pedido diferente al solicitado» (12) no está: ahí
 * el error es nuestro y la clienta sí puede quererlo.
 */
export const SWAYP_REJECTION_NOVELTIES: ReadonlySet<number> = new Set([15, 16]);

/** Prefijo de la etiqueta que Kapta guarda para una novedad de Swayp. */
const SWAYP_LABEL_PREFIX = "Swayp · ";

/**
 * La etiqueta cruda del courier para una guía Swayp (`shipments.reported_status`):
 * «Swayp · Destinatario ya no desea el producto (16)». Lleva el nombre para
 * leerla en Envíos y el id para decidir sin depender de cómo se escriba.
 */
export function swaypNoveltyLabel(novelty: { id: number | null; name: string | null }): string {
  const name = novelty.name?.trim() || "Novedad";
  return `${SWAYP_LABEL_PREFIX}${name}${novelty.id != null ? ` (${novelty.id})` : ""}`;
}

/** ¿La etiqueta de una guía Swayp dice que la rechazaron en la puerta? */
export function swaypLabelSaysRejection(label: string | null | undefined): boolean {
  if (!label || !label.startsWith(SWAYP_LABEL_PREFIX)) return false;
  const id = /\((\d+)\)\s*$/.exec(label)?.[1];
  if (id) return SWAYP_REJECTION_NOVELTIES.has(Number(id));
  return /ya no desea|no ha comprado/i.test(label);
}

/**
 * La novedad 20 de Swayp, «Bodega no despachó mercancía»: el paquete NUNCA
 * salió de la bodega. Es lo contrario de lo que dice el estado 6 en el resto de
 * las novedades —el mensajero tiene el paquete—, y por eso se mira aparte
 * (#KP138099, 03-10-2026).
 */
export const SWAYP_UNDISPATCHED_NOVELTY = 20;

/** ¿La etiqueta de una guía Swayp dice que su bodega no despachó el paquete? */
export function swaypLabelSaysUndispatched(label: string | null | undefined): boolean {
  if (!label || !label.startsWith(SWAYP_LABEL_PREFIX)) return false;
  const id = /\((\d+)\)\s*$/.exec(label)?.[1];
  if (id) return Number(id) === SWAYP_UNDISPATCHED_NOVELTY;
  return /bodega no despach/i.test(normalizeLabel(label));
}

/**
 * Novedades de Swayp que son una falla de SWAYP, no de la clienta: 18 «Falta
 * inventario», 20 «Bodega no despachó mercancía» y 21 «Sin cobertura». Nadie
 * fue a la puerta, así que no dicen nada de si la clienta lo quiere.
 */
export const SWAYP_OWN_FAILURE_NOVELTIES: ReadonlySet<number> = new Set([18, 20, 21]);

/** ¿La etiqueta de una guía Swayp dice que falló Swayp y no la entrega? */
export function swaypLabelSaysOwnFailure(label: string | null | undefined): boolean {
  if (!label || !label.startsWith(SWAYP_LABEL_PREFIX)) return false;
  const id = /\((\d+)\)\s*$/.exec(label)?.[1];
  return id ? SWAYP_OWN_FAILURE_NOVELTIES.has(Number(id)) : false;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function codeOf(value: unknown): number | null {
  if (typeof value === "number" || (typeof value === "string" && /^\s*\d+\s*$/.test(value))) {
    const n = Number(value);
    return SWAYP_STATES[n] ? n : null;
  }
  return null;
}

/** Id de novedad del catálogo de Swayp (1..30), o null. */
function codeOfNovelty(value: unknown): number | null {
  if (typeof value === "number" || (typeof value === "string" && /^\s*\d+\s*$/.test(value))) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 && n < 100 ? n : null;
  }
  return null;
}

/** Fecha de un campo `fecha…` para el estado actual, cuando no hay historial. */
const DATE_FIELD_BY_STATE: Record<number, string> = {
  5: "fechaReparto",
  6: "fechaNovedad",
  7: "fechaEntregada",
  9: "fechaDevolucion",
  10: "fechaCancelado",
  12: "fechaDevolucion",
};

/**
 * El historial de la guía. En el tracking público se llama `notas`; la
 * respuesta de la API no está documentada («su estado actual y el historial de
 * cambios»), y el 29-09-2026 NO traía `notas`: todas las fechas de salida
 * quedaron con la hora del barrido. Se busca también bajo los nombres
 * probables; lo que venga lo dice `swaypResponseShape` en el log del barrido.
 */
function historyOf(guide: Record<string, unknown>): Record<string, unknown>[] {
  const preferred = ["notas", "historial", "historico", "history", "tracking", "estados", "seguimiento", "movimientos"];
  const keys = [...preferred.filter((k) => k in guide), ...Object.keys(guide).filter((k) => !preferred.includes(k))];
  for (const key of keys) {
    const value = guide[key];
    if (!Array.isArray(value) || !value.length) continue;
    const items = value.map(asRecord).filter((x): x is Record<string, unknown> => x != null);
    const looksLikeHistory = items.some(
      (n) => ("fecha" in n || "date" in n || "createdAt" in n || "fechaCreacion" in n) && ("estado" in n || "codigoEstado" in n || "idEstado" in n),
    );
    if (looksLikeHistory) return items;
  }
  return [];
}

/**
 * La FORMA de una respuesta, sin sus datos, para el log del barrido: las claves
 * de primer nivel y los valores crudos de `estado`/`idEstado`, que son nombres
 * y códigos de estado. Es lo que dijo el 29-09-2026 que una Devolución
 * confirmada llega como 10.
 */
export function swaypResponseShape(body: unknown): { keys: string[]; estado: string; historial: string | null; historialClaves: string[] } {
  const root = asRecord(Array.isArray(body) ? body[0] : body);
  const guide = asRecord(root?.data) ?? root;
  if (!guide) return { keys: [], estado: "(vacía)", historial: null, historialClaves: [] };
  const estado = guide.estado;
  const raw = (v: unknown) => (v == null ? "-" : typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 40));
  const history = historyOf(guide);
  const historyKey = history.length
    ? Object.keys(guide).find((k) => Array.isArray(guide[k]) && (guide[k] as unknown[]).length === history.length) ?? null
    : null;
  // Las claves de los elementos del historial —no sus valores—: dicen si la
  // novedad viene como `idNovedad`/`nombreNovedad`, como en el tracking.
  const historyKeys = new Set<string>();
  for (const item of history) for (const k of Object.keys(item)) if (historyKeys.size < 30) historyKeys.add(k);
  return {
    keys: Object.keys(guide).sort(),
    estado: `${raw(estado)}|${raw(guide.idEstado)}`,
    historial: historyKey,
    historialClaves: [...historyKeys].sort(),
  };
}

/**
 * Lee el estado de una guía de la respuesta de `GET /v2/guias/{guia}`.
 *
 * Lo que manda es `estado` —así lo indicó la operación el 29-09-2026: «buscas
 * "estado" dentro del body de respuesta»—. Viene como TEXTO («Devolucion»), igual
 * que en la guía que muestra el tracking público; si llegara como número o como
 * objeto `{codigo, nombre}` también se lee, y a falta de él se prueba
 * `idEstado`/`codigoEstado`. Un texto que no conocemos NO se adivina: `state`
 * queda null y el barrido lo cuenta con su texto, igual que Tanders.
 *
 * La forma completa de la respuesta no está documentada; lo demás (el
 * historial `notas`, las `fecha…`) se aprovecha si viene y se ignora si no.
 */
export function readSwaypGuide(body: unknown): SwaypGuideReading {
  const root = asRecord(Array.isArray(body) ? body[0] : body);
  const guide = asRecord(root?.data) ?? root;
  if (!guide) return { state: null, label: null, departedAt: null, changedAt: null, novelty: null };

  let state: number | null = null;
  let label: string | null = null;
  const estado = guide.estado;
  const estadoObj = asRecord(estado);
  if (typeof estado === "string" && !/^\s*\d+\s*$/.test(estado)) {
    label = estado.trim() || null;
    state = swaypStateFromLabel(estado);
  } else if (estadoObj) {
    const nombre = [estadoObj.nombre, estadoObj.name, estadoObj.descripcion, estadoObj.estado].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    label = nombre?.trim() ?? null;
    state =
      swaypStateFromLabel(nombre) ??
      codeOf(estadoObj.codigo) ??
      codeOf(estadoObj.id) ??
      codeOf(estadoObj.idEstado) ??
      codeOf(estadoObj.codigoEstado);
  } else {
    state = codeOf(estado);
    if (state != null) label = String(estado).trim();
  }
  if (state == null) state = codeOf(guide.idEstado) ?? codeOf(guide.codigoEstado);

  // El historial, cuando viene, da las fechas reales: la primera salida a
  // reparto y la entrada al estado actual.
  let departedAt: string | null = null;
  let changedAt: string | null = null;
  let novelty: SwaypGuideReading["novelty"] = null;
  let noveltyAt = "";
  for (const nota of historyOf(guide)) {
    const at = isoOrNull(nota.fecha) ?? isoOrNull(nota.date) ?? isoOrNull(nota.createdAt) ?? isoOrNull(nota.fechaCreacion);
    if (!at) continue;
    // La novedad que cuenta es la ÚLTIMA: si primero no contestó y después dijo
    // que ya no lo quiere, lo que vale es cómo terminó (igual que Aliclik).
    const noveltyId = codeOfNovelty(nota.idNovedad ?? nota.novedadId ?? nota.id_novedad);
    const noveltyName = [nota.nombreNovedad, nota.nombre_novedad, typeof nota.novedad === "string" ? nota.novedad : null].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    if ((noveltyId != null || noveltyName) && at >= noveltyAt) {
      novelty = { id: noveltyId, name: noveltyName?.trim() ?? null };
      noveltyAt = at;
    }
    const code =
      codeOf(nota.codigoEstado) ??
      codeOf(nota.idEstado) ??
      (typeof nota.estado === "string" ? swaypStateFromLabel(nota.estado) : codeOf(nota.estado));
    if ((code === 4 || code === 5) && (!departedAt || at < departedAt)) departedAt = at;
    if (state != null && code === state && (!changedAt || at > changedAt)) changedAt = at;
  }
  departedAt ??= isoOrNull(guide.fechaReparto) ?? isoOrNull(guide.fechaTransito);
  if (!changedAt && state != null && DATE_FIELD_BY_STATE[state]) {
    changedAt = isoOrNull(guide[DATE_FIELD_BY_STATE[state]!]);
  }

  return { state, label, departedAt, changedAt, novelty };
}

/** URL de tracking pública, para mandarle al cliente final. No requiere auth. */
export function trackingUrl(guia: string | number): string {
  return `https://www.swayp.co/tracking/${encodeURIComponent(String(guia))}`;
}

/** Client options from the environment. Throws if the integration isn't configured. */
export function swaypOptsFromEnv(overrides: Partial<SwaypClientOpts> = {}): SwaypClientOpts {
  return {
    token: env.swaypToken(),
    email: env.swaypEmail(),
    country: "PE",
    ...overrides,
  };
}
