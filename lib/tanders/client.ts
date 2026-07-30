// Cliente de la API de Tanders.
//
//   POST /auth/login          {email, password}   → par de tokens
//   POST /auth/refresh        {refreshToken}      → par de tokens
//   POST /orders              TandersOrderPayload → 201 con el pedido creado
//   GET  /orders/me/capacity                      → cupo del día
//   GET  /orders/{id}                             → detalle
//
// El access token dura 15 minutos (900 s entre `iat` y `exp`) y el refresh 7
// días. Con guías creadas de a una desde el Master, un token cacheado casi
// siempre estará vencido cuando llegue la siguiente: el cliente pide uno nuevo
// por login en vez de arrastrar un refresh token que habría que persistir y
// rotar. Menos estado, menos formas de romperse.
//
// SERVER-ONLY: recibe la contraseña de la tienda ya descifrada.

import type {
  TandersCapacity,
  TandersOrder,
  TandersOrderPayload,
  TandersTokens,
} from "./types";
import { TandersApiError } from "./types";

export const TANDERS_API_BASE = "https://tander-bakend-aa1aef07466e.herokuapp.com";

export interface TandersClientOpts {
  email: string;
  password: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Margen antes del `exp` para no mandar un token que vence en el viaje. */
const EXPIRY_SKEW_SECONDS = 30;

/** `exp` del JWT, en segundos. Null si el token no es legible. */
export function jwtExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

/**
 * Saca los tokens de la respuesta de auth. Los nombres exactos de los campos no
 * están confirmados (la API no tiene documentación), así que se prueban los
 * habituales antes de rendirse — y si ninguno aparece, el error dice qué claves
 * SÍ llegaron, que es lo que hace falta para arreglarlo sin adivinar otra vez.
 */
export function extractTokens(body: unknown): TandersTokens {
  const obj = (body ?? {}) as Record<string, unknown>;
  const nested = (obj.data ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = obj[k] ?? nested[k];
      if (typeof v === "string" && v) return v;
    }
    return null;
  };

  const accessToken = pick("accessToken", "access_token", "token", "jwt");
  if (!accessToken) {
    const keys = [...Object.keys(obj), ...Object.keys(nested)].join(", ") || "(ninguna)";
    throw new TandersApiError(
      `La respuesta de autenticación de Tanders no trae access token. Claves recibidas: ${keys}.`,
      200,
      body,
    );
  }
  return {
    accessToken,
    refreshToken: pick("refreshToken", "refresh_token"),
    expiresAt: jwtExpiry(accessToken),
  };
}

/** Mensaje de error legible: la API contesta a veces {message}, a veces texto. */
function errorMessage(status: number, body: unknown): string {
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  const obj = (body ?? {}) as Record<string, unknown>;
  const raw = obj.message ?? obj.error ?? obj.detail;
  if (Array.isArray(raw)) return raw.map(String).join("; ").slice(0, 300);
  if (typeof raw === "string" && raw) return raw.slice(0, 300);
  return `Tanders respondió ${status}.`;
}

export class TandersClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private tokens: TandersTokens | null = null;

  constructor(private readonly opts: TandersClientOpts) {
    this.base = (opts.baseUrl ?? TANDERS_API_BASE).replace(/\/$/, "");
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; token?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";

    const res = await this.doFetch(`${this.base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* se queda como texto: sirve igual para el mensaje de error */
    }
    if (!res.ok) throw new TandersApiError(errorMessage(res.status, parsed), res.status, parsed);
    return parsed as T;
  }

  /** Access token vigente: reusa el cacheado mientras le quede vida. */
  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.tokens && (this.tokens.expiresAt ?? 0) - EXPIRY_SKEW_SECONDS > now) {
      return this.tokens.accessToken;
    }
    const body = await this.request<unknown>("/auth/login", {
      method: "POST",
      body: { email: this.opts.email, password: this.opts.password },
    });
    this.tokens = extractTokens(body);
    return this.tokens.accessToken;
  }

  /** Valida las credenciales sin crear nada. Para el botón "Probar" de ajustes. */
  async verifyCredentials(): Promise<void> {
    await this.accessToken();
  }

  /**
   * Crea el pedido. Un 401 se reintenta UNA vez con token nuevo: el token dura
   * 15 minutos y puede vencer entre que se pide y que se usa.
   *
   * Deliberadamente sin reintento en ningún otro caso. Un timeout o un 500 puede
   * haber creado la guía igual, y reintentar a ciegas despacharía el mismo
   * paquete dos veces — que es peor que fallar y que un humano mire.
   */
  async createOrder(payload: TandersOrderPayload): Promise<TandersOrder> {
    const send = async (token: string) =>
      this.request<TandersOrder>("/orders", { method: "POST", body: payload, token });
    try {
      return await send(await this.accessToken());
    } catch (err) {
      if (err instanceof TandersApiError && err.status === 401) {
        this.tokens = null;
        return send(await this.accessToken());
      }
      throw err;
    }
  }

  async capacity(): Promise<TandersCapacity> {
    return this.request<TandersCapacity>("/orders/me/capacity", { token: await this.accessToken() });
  }

  /**
   * Marca el rótulo como generado, igual que su panel al descargar el PDF.
   *
   * Su interfaz muestra entonces "✓ Rótulo generado" con la opción de liberarlo.
   * Es el único guardarraíl contra imprimir dos etiquetas del mismo paquete, así
   * que se llama al componer el rótulo aunque el PDF lo armemos nosotros: si los
   * dos sistemas no coinciden, el guardarraíl no sirve para nada.
   *
   * Devuelve 204 sin cuerpo. Best-effort en la capa de arriba: el rótulo se
   * imprime igual si esto falla.
   */
  async markLabelGenerated(orderId: string): Promise<void> {
    await this.request<void>(`/orders/me/${encodeURIComponent(orderId)}/label`, {
      method: "PATCH",
      body: { generated: true },
      token: await this.accessToken(),
    });
  }

  /**
   * Evidencias del pedido: la foto de la entrega y el comprobante del pago.
   *
   * Devuelve la respuesta CRUDA. Separar una de otra es responsabilidad de
   * `extractPaymentEvidence`, que falla cerrada — ver el porqué allí.
   */
  async evidences(orderId: string): Promise<unknown> {
    return this.request<unknown>(`/orders/me/${encodeURIComponent(orderId)}/aliclik/evidences`, {
      token: await this.accessToken(),
    });
  }

  async getOrder(id: string): Promise<TandersOrder> {
    return this.request<TandersOrder>(`/orders/${encodeURIComponent(id)}`, {
      token: await this.accessToken(),
    });
  }
}

/**
 * Código con el que se identifica el envío en todos lados MENOS en su API: el
 * "N° SEGUIMIENTO" de su panel, que es lo que el equipo copia y lo que el
 * cliente recibe.
 *
 * Viene en `aliclikOrderNumber` porque Tanders sincroniza sus pedidos hacia
 * Aliclik y adopta el número que este le asigna. Si algún día llegara vacío
 * (sincronización pendiente), se cae al cuid: un código raro es mejor que una
 * guía creada que no se puede registrar.
 */
export function extractTrackingCode(order: TandersOrder | null | undefined): string | null {
  if (!order) return null;
  for (const key of ["aliclikOrderNumber", "trackingCode", "trackingNumber", "code"]) {
    const v = order[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const id = typeof order.id === "string" ? order.id.trim() : "";
  return id || null;
}

/**
 * URL de la etiqueta dentro de la respuesta. Al crear nunca viene —
 * `labelGeneratedAt` llega en null porque el PDF se genera después—, así que
 * esto solo encuentra algo al releer un pedido ya despachado.
 */
export function extractLabelUrl(order: TandersOrder | null | undefined): string | null {
  if (!order) return null;
  for (const key of ["labelUrl", "label_url", "pdfUrl", "pdf_url", "labelPdf", "ticketUrl"]) {
    const v = order[key];
    if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
  }
  return null;
}

/** Una constancia de pago localizada dentro de la respuesta de evidencias. */
export interface TandersPaymentEvidence {
  imageUrl: string;
  /** Lo que Tanders dice del pago; no reemplaza la lectura de la imagen. */
  status?: string | null;
  amount?: number | null;
  method?: string | null;
  at?: string | null;
}

const PAYMENT_KEYS = ["payments", "pagos", "paymentEvidences"];
/** Tanders guarda las constancias de PAGO bajo esta carpeta; la foto de la
 *  entrega va en otra. Es el discriminante fiable, y no depende de cómo se
 *  llamen las claves de su JSON. */
const PAYMENT_PATH = "files_payment";
const IMAGE_KEYS = ["imageUrl", "image_url", "url", "photoUrl", "photo", "evidenceUrl", "file"];

function firstUrl(obj: Record<string, unknown>): string | null {
  for (const k of IMAGE_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
  }
  return null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Saca SOLO las constancias de pago de la respuesta de evidencias.
 *
 * Falla cerrada a propósito. Tanders devuelve dos clases de evidencia —la foto
 * del paquete entregado y el comprobante del pago— y confundirlas significaría
 * pasar una foto de un paquete por el lector de comprobantes y decidir un cobro
 * con el resultado. Así que solo se acepta lo que está bajo una clave que dice
 * "pagos" de forma inequívoca: si su API cambia de forma, esto devuelve vacío y
 * la comprobación queda PENDIENTE (que bloquea sin acusar), en vez de adivinar.
 */
export function extractPaymentEvidence(body: unknown): TandersPaymentEvidence[] {
  const root = (body ?? {}) as Record<string, unknown>;
  const scopes = [root, (root.data ?? {}) as Record<string, unknown>];

  // 1) Por la RUTA de la imagen. Tanders sube las constancias de pago a
  //    `files_payment/<N° seguimiento>/…` y la foto de la entrega a otra
  //    carpeta, así que esto separa las dos sin depender de la forma del JSON.
  //    Se busca en todo el árbol: da igual bajo qué clave vengan.
  const byPath: TandersPaymentEvidence[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth = 0) => {
    if (depth > 6 || !node) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const url = firstUrl(obj);
    if (url && url.includes(PAYMENT_PATH) && !seen.has(url)) {
      seen.add(url);
      byPath.push({
        imageUrl: url,
        status: typeof obj.status === "string" ? obj.status : null,
        amount: num(obj.amount ?? obj.monto),
        method: typeof obj.method === "string" ? obj.method : null,
        at: typeof obj.createdAt === "string" ? obj.createdAt : null,
      });
    }
    for (const v of Object.values(obj)) walk(v, depth + 1);
  };
  walk(root);
  if (byPath.length) return byPath;

  // 2) Respaldo: bajo una clave que diga "pagos" de forma inequívoca.
  for (const scope of scopes) {
    for (const key of PAYMENT_KEYS) {
      const list = scope[key];
      if (!Array.isArray(list)) continue;
      const found: TandersPaymentEvidence[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const imageUrl = firstUrl(obj);
        if (!imageUrl) continue;
        found.push({
          imageUrl,
          status: typeof obj.status === "string" ? obj.status : null,
          amount: num(obj.amount ?? obj.monto),
          method: typeof obj.method === "string" ? obj.method : null,
          at: typeof obj.createdAt === "string" ? obj.createdAt : null,
        });
      }
      if (found.length) return found;
    }
  }
  return [];
}
