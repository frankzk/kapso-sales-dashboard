// Conectar un agente de IA a Kapta con OAuth (MOM §42.8, 08-11-2026; 0319).
//
// POR QUÉ. Grok Bot no puede mandar el token de Kapta en la cabecera de un
// servidor MCP propio y pidió OAuth: se agrega el conector por su dirección y
// una persona aprueba el acceso en Kapta, sin copiar tokens. Esto es la
// autorización de MCP (especificación 2025-06-18), lo mínimo que piden los
// clientes MCP (Grok, Claude, ChatGPT, Cursor):
//
//   1. `/api/mcp` sin token → 401 con `WWW-Authenticate: Bearer
//      resource_metadata="…/.well-known/oauth-protected-resource/api/mcp"`.
//   2. Metadatos del recurso (RFC 9728): quién autoriza → este mismo sitio.
//   3. Metadatos del servidor de autorización (RFC 8414): dónde registrarse,
//      autorizar y canjear.
//   4. Registro dinámico (RFC 7591): el cliente da su nombre y sus redirect_uri;
//      recibe un `client_id` público (sin secreto). No da acceso a nada.
//   5. `/oauth/authorize`: la persona entra a Kapta, ve quién pide y adónde
//      vuelve, elige tiendas y herramientas y pulsa «Permitir» → un código de un
//      solo uso, 10 minutos, atado al cliente, a la redirect_uri y a un desafío
//      PKCE S256.
//   6. `/api/oauth/token`: el código + el verificador PKCE → un token de
//      `agent_tokens` (0314), el mismo que se crea a mano: ve lo que ve quien lo
//      aprobó, se revoca en Conector de IA y se registra igual.
//
// Sin refresh token: el token no vence; si se revoca, el cliente recibe 401 y
// vuelve a pedir permiso.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AGENT_SCOPES, type AgentScope } from "@/lib/agent-auth";

export const OAUTH_CLIENT_PREFIX = "kcli_";
export const OAUTH_CODE_TTL_MS = 10 * 60_000;
/** Registros nuevos por hora, entre todos: el registro es público por norma. */
export const OAUTH_REGISTRATIONS_PER_HOUR = 30;
export const OAUTH_MIGRATION_MISSING = "Falta aplicar la migración 0319 (OAuth del conector) en la base.";

/** Las herramientas que hoy se pueden dar por OAuth: las de lectura, como en la pantalla. */
export const OAUTH_SCOPES: AgentScope[] = (Object.keys(AGENT_SCOPES) as AgentScope[]).filter((s) => !AGENT_SCOPES[s].write);

export const MCP_PATH = "/api/mcp";

// ---------------------------------------------------------------------------
// Metadatos
// ---------------------------------------------------------------------------

/** El origen sin barra final. Se toma de la petición: el que el cliente usó. PURA. */
export function cleanOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/** Dónde están los metadatos del recurso, para el 401 de `/api/mcp`. PURA. */
export function protectedResourceMetadataUrl(origin: string): string {
  return `${cleanOrigin(origin)}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

/** RFC 9728. PURA. */
export function protectedResourceMetadata(origin: string) {
  const o = cleanOrigin(origin);
  return {
    resource: `${o}${MCP_PATH}`,
    authorization_servers: [o],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Kapta · Kenku y Aurela",
  };
}

/** RFC 8414. PURA. */
export function authorizationServerMetadata(origin: string) {
  const o = cleanOrigin(origin);
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/api/oauth/token`,
    registration_endpoint: `${o}/api/oauth/register`,
    scopes_supported: OAUTH_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}

/** Cabeceras de las respuestas OAuth: sin caché y legibles desde otro origen (los metadatos y el canje son públicos). */
export const OAUTH_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
};

// ---------------------------------------------------------------------------
// Registro (RFC 7591)
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Una redirect_uri aceptable: https, o http solo a la propia máquina del
 * cliente (aplicaciones de escritorio); sin fragmento, sin usuario ni clave,
 * hasta 500 caracteres. PURA.
 */
export function isValidRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 500) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

export type RegistrationParse =
  | { ok: true; clientName: string; redirectUris: string[] }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

/** El cuerpo de un registro, validado. PURA. */
export function parseRegistration(body: unknown): RegistrationParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_client_metadata", description: "El cuerpo debe ser un objeto JSON." };
  }
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10) {
    return { ok: false, error: "invalid_redirect_uri", description: "Indica de 1 a 10 redirect_uris." };
  }
  if (!uris.every(isValidRedirectUri)) {
    return { ok: false, error: "invalid_redirect_uri", description: "Cada redirect_uri debe ser https (o http a localhost), sin fragmento." };
  }
  const method = b.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    return { ok: false, error: "invalid_client_metadata", description: "Solo clientes públicos: token_endpoint_auth_method = none, con PKCE." };
  }
  const grants = b.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || !grants.includes("authorization_code"))) {
    return { ok: false, error: "invalid_client_metadata", description: "Se admite el grant authorization_code." };
  }
  const rawName = typeof b.client_name === "string" ? b.client_name.replace(/\s+/g, " ").trim() : "";
  const clientName = (rawName || "Agente de IA").slice(0, 100);
  return { ok: true, clientName, redirectUris: [...new Set(uris as string[])] };
}

export function generateClientId(): string {
  return `${OAUTH_CLIENT_PREFIX}${randomBytes(16).toString("base64url")}`;
}

// ---------------------------------------------------------------------------
// Autorización
// ---------------------------------------------------------------------------

export function generateAuthCode(): string {
  return randomBytes(32).toString("base64url");
}

export function hashAuthCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** PKCE S256 (RFC 7636): base64url(sha256(verificador)) == desafío, en tiempo constante. PURA. */
export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier) || !CHALLENGE_RE.test(challenge)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  /** Las herramientas que pidió el cliente, si pidió (si no, todas las de lectura). */
  requestedScopes: AgentScope[];
}

/**
 * Los parámetros de `/oauth/authorize`. Dos clases de error, como manda
 * RFC 6749 §4.1.2.1: si el cliente o la redirect_uri no valen, NO se redirige
 * (se muestra el error: podría ser una redirección a un sitio ajeno); lo demás
 * vuelve al cliente con `error=`. `registered` = las redirect_uris del cliente,
 * o null si el cliente no existe. PURA.
 */
export function parseAuthorizeRequest(
  params: Record<string, string | undefined>,
  registered: readonly string[] | null,
  origin: string,
):
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; fatal: true; message: string }
  | { ok: false; fatal: false; redirectUri: string; state: string | null; error: string; description: string } {
  const clientId = params.client_id ?? "";
  if (!registered) return { ok: false, fatal: true, message: "Este agente no está registrado en Kapta. Vuelve a conectarlo desde el agente." };
  const redirectUri = params.redirect_uri ?? (registered.length === 1 ? registered[0]! : "");
  if (!redirectUri || !registered.includes(redirectUri)) {
    return { ok: false, fatal: true, message: "La dirección de vuelta no es la que registró este agente." };
  }
  const state = params.state ? params.state.slice(0, 1000) : null;
  const back = (error: string, description: string) => ({ ok: false as const, fatal: false as const, redirectUri, state, error, description });
  if (params.response_type !== "code") return back("unsupported_response_type", "Solo response_type=code.");
  if (params.code_challenge_method !== "S256") return back("invalid_request", "PKCE con code_challenge_method=S256 es obligatorio.");
  const codeChallenge = params.code_challenge ?? "";
  if (!CHALLENGE_RE.test(codeChallenge)) return back("invalid_request", "code_challenge no es un S256 válido.");
  if (params.resource && !resourceBelongsHere(params.resource, origin)) {
    return back("invalid_target", "El recurso pedido no es este servidor.");
  }
  let requestedScopes: AgentScope[] = [...OAUTH_SCOPES];
  if (params.scope && params.scope.trim()) {
    const asked = params.scope.trim().split(/\s+/);
    requestedScopes = OAUTH_SCOPES.filter((s) => asked.includes(s));
    if (!requestedScopes.length) return back("invalid_scope", `Las herramientas disponibles son: ${OAUTH_SCOPES.join(" ")}.`);
  }
  return { ok: true, request: { clientId, redirectUri, codeChallenge, state, requestedScopes } };
}

/** RFC 8707: el recurso es este sitio (su origen, con o sin `/api/mcp`). PURA. */
export function resourceBelongsHere(resource: string, origin: string): boolean {
  try {
    return new URL(resource).origin === new URL(cleanOrigin(origin)).origin;
  } catch {
    return false;
  }
}

/** La vuelta al cliente: `?code=…&state=…` o `?error=…`. Conserva la query que ya tenía la redirect_uri. PURA. */
export function clientRedirect(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  return url.toString();
}

/** El dominio al que vuelve, para que la persona lo vea antes de permitir. PURA. */
export function redirectHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

/** «No existe» de Postgres/PostgREST, solo para las tablas de la 0319. PURA. */
export function isOAuthMigrationMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  if (e.code !== "42P01" && e.code !== "PGRST205" && e.code !== "42703" && e.code !== "PGRST204") return false;
  return [e.message, e.details, e.hint].some((t) => typeof t === "string" && /\bagent_oauth_(?:clients|codes)\b|\boauth_client_id\b/.test(t));
}

/** Un error OAuth (RFC 6749 §5.2) con su estado HTTP. PURA. */
export function oauthError(error: string, description: string) {
  return { error, error_description: description };
}
