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
 * True when the failure means "our credential no longer works" — the token is
 * static and cannot be renewed programmatically, so this needs a human to ask
 * Swayp for a new one. Worth alerting on rather than retrying.
 */
export function isSwaypAuthError(err: unknown): boolean {
  if (!(err instanceof SwaypError)) return false;
  if (err.status === 401) return true;
  // A bare 403 is NOT enough: any intermediary (corporate proxy, egress
  // gateway, WAF) answers 403 too, and treating that as a dead credential
  // would page someone over a network policy. Match Swayp's own wording.
  return /token expired|no tienes autorizaci|no tienes permisos/i.test(err.body);
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

/** Responde una novedad de tipo Gestión. */
export function solveNovelty(
  opts: SwaypClientOpts,
  input: SwaypNoveltySolution,
): Promise<{ success?: boolean; [k: string]: unknown }> {
  return swaypFetch(opts, "POST", "/v2/guias/setNoveltySolution", input);
}

// ── Estados ──────────────────────────────────────────────────────────────────

export const SWAYP_STATES: Record<number, string> = {
  1: "Generada",
  2: "Preparada",
  3: "Por recolectar",
  4: "Asignada",
  5: "Reparto",
  6: "Novedad",
  7: "Entregada",
  8: "Revisión",
  9: "Cancelación",
  10: "Cancelada",
  11: "Indemnizada",
  12: "Devolución confirmada",
};

/**
 * Swayp state → this app's `delivery_status` (see DELIVERY_STATUSES in
 * lib/shipments.ts). The app models 5 statuses and none of them means
 * "returning", so the mapping is deliberately lossy and the raw Swayp state is
 * stored alongside it:
 *
 *   1·2·3 aún en bodega        → pendiente
 *   4·5   en manos del mensajero → en_ruta
 *   6     novedad: la entrega falló y necesita gestión telefónica → pendiente
 *   8     el mensajero marcó devolución; todavía se puede gestionar → pendiente
 *   7     entregada            → entregado
 *   10·11·12 cerradas sin entrega → anulado
 *
 * Returns null for an unknown code so the caller leaves the row untouched
 * rather than writing a wrong status.
 */
export function mapSwaypState(idEstado: number | string): string | null {
  const id = Number(idEstado);
  if (!Number.isFinite(id)) return null;
  if (id === 1 || id === 2 || id === 3 || id === 6 || id === 8) return "pendiente";
  if (id === 4 || id === 5) return "en_ruta";
  if (id === 7) return "entregado";
  if (id === 9 || id === 10 || id === 11 || id === 12) return "anulado";
  return null;
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
