/**
 * Reglas puras de la app de Shopify para tiendas cliente (MOM §29.15.1 y
 * §29.15.9). Sin IO: las rutas de /api/shopify/clientes/* las usan y las
 * pruebas las cubren en test/shopify-client-app.test.ts.
 *
 * El recorrido que exige la revisión de Shopify:
 *   1. el dueño instala la app desde su enlace (ficha oculta);
 *   2. Shopify abre la URL de la app (`entrada`) con `shop`, `timestamp` y
 *      `hmac`; Kapta pide permiso (OAuth) en el acto, sin pedir el dominio;
 *   3. `callback` cambia el código por el token. Si la tienda ya estaba en
 *      Kapta, se reconecta; si no, el token queda en una instalación pendiente;
 *   4. el dueño entra a Kapta y elige la organización donde se crea la tienda.
 */
import { isValidShopDomain, verifyShopifyOAuthHmac } from "@/lib/shopify";

/** Cookie que ata la instalación pendiente al navegador que hizo el OAuth. */
export const PENDING_INSTALL_COOKIE = "kapta_shopify_install";
/** Lo mismo que el `default` de `shopify_pending_installs.expires_at` (0240). */
export const PENDING_INSTALL_TTL_MINUTES = 30;
/** Cookie del `state` del OAuth (CSRF), propia de esta app. */
export const CLIENT_OAUTH_STATE_COOKIE = "shopify_client_oauth_state";

/** Antigüedad máxima aceptada del `timestamp` con que Shopify abre la app. */
export const LAUNCH_MAX_AGE_SECONDS = 24 * 60 * 60;

export type ShopifyLaunchCheck =
  | { ok: true; shop: string }
  | { ok: false; reason: "sin-config" | "shop-invalido" | "hmac-invalido" | "vencido" };

/**
 * Verifica que la apertura de la app venga de Shopify: dominio canónico,
 * firma con el secreto de la app de clientes y un `timestamp` reciente.
 */
export function verifyShopifyLaunch(
  params: URLSearchParams,
  secret: string,
  nowSeconds: number,
): ShopifyLaunchCheck {
  if (!secret) return { ok: false, reason: "sin-config" };
  const shop = (params.get("shop") ?? "").toLowerCase();
  if (!isValidShopDomain(shop)) return { ok: false, reason: "shop-invalido" };
  if (!verifyShopifyOAuthHmac(params, secret)) return { ok: false, reason: "hmac-invalido" };
  const ts = Number(params.get("timestamp"));
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > LAUNCH_MAX_AGE_SECONDS) {
    return { ok: false, reason: "vencido" };
  }
  return { ok: true, shop };
}

/** Los tres avisos de privacidad que Shopify exige atender (MOM §29.15.9). */
export const PRIVACY_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"] as const;
export type PrivacyTopic = (typeof PRIVACY_TOPICS)[number];

export function asPrivacyTopic(topic: string | null | undefined): PrivacyTopic | null {
  const t = (topic ?? "").trim().toLowerCase();
  return (PRIVACY_TOPICS as readonly string[]).includes(t) ? (t as PrivacyTopic) : null;
}

export interface ParsedPrivacyRequest {
  shopDomain: string;
  shopId: string | null;
  payload: Record<string, unknown>;
}

/** Lee el cuerpo de un aviso de privacidad; null si no trae una tienda válida. */
export function parsePrivacyPayload(rawBody: string): ParsedPrivacyRequest | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const payload = body as Record<string, unknown>;
  const shopDomain = String(payload.shop_domain ?? "").toLowerCase();
  if (!isValidShopDomain(shopDomain)) return null;
  const shopId = payload.shop_id == null ? null : String(payload.shop_id);
  return { shopDomain, shopId, payload };
}

/** Una instalación pendiente sirve si no venció y nadie la reclamó todavía. */
export function pendingInstallUsable(
  row: { expires_at: string; claimed_at: string | null },
  now: Date,
): boolean {
  if (row.claimed_at) return false;
  const expires = Date.parse(row.expires_at);
  return Number.isFinite(expires) && expires > now.getTime();
}

export interface StoreForShop {
  id: string;
  org_id: string;
  shopify_app: string | null;
}

export type ClientInstallDecision =
  | { kind: "reconnect"; storeId: string }
  | { kind: "pending" }
  | { kind: "conflict" };

/**
 * Qué hacer con un OAuth terminado de la app de clientes, según las tiendas de
 * Kapta que ya tienen ese dominio:
 *   - una conectada con la app de clientes → se reconecta (reinstalación);
 *   - una conectada con la app interna → conflicto: Aurela o Kenku no pasan a
 *     la app de clientes por instalarla (la app interna tiene otro secreto y
 *     otras reglas);
 *   - ninguna → instalación pendiente, a reclamar dentro de Kapta.
 */
export function decideClientInstall(stores: readonly StoreForShop[]): ClientInstallDecision {
  const client = stores.find((s) => s.shopify_app === "clientes");
  if (client) return { kind: "reconnect", storeId: client.id };
  if (stores.length > 0) return { kind: "conflict" };
  return { kind: "pending" };
}

/** Un nombre de tienda razonable a partir del dominio, editable al reclamar. */
export function storeNameFromShop(shop: string): string {
  const base = shop.toLowerCase().replace(/\.myshopify\.com$/, "");
  return base
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
