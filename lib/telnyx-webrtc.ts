// Llamar desde la computadora (MOM §8.5) — el lado del servidor.
//
// El navegador habla con Telnyx por WebRTC y entra con un token que dura 24
// horas. El token sale de la «credencial de telefonía» de cada persona, que
// vive en Telnyx colgada de la conexión SIP de credenciales
// (`TELNYX_WEBRTC_CONNECTION_ID`). La conexión del Agente Telnyx es otra (Call
// Control) y no sirve para esto.
//
// La clave de la API nunca sale de aquí: el navegador solo recibe el token.
//
//   POST /v2/telephony_credentials              → la credencial (una vez por persona)
//   POST /v2/telephony_credentials/{id}/token   → el token, en texto plano
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { TELNYX_API_BASE } from "@/lib/telnyx";

export interface WebrtcConfig {
  apiKey: string;
  /** La conexión SIP de credenciales por la que salen las llamadas del navegador. */
  connectionId: string;
  /** El número que ve la clienta (E.164). */
  fromNumber: string;
}

/** La configuración, o null si falta algo: sin ella el botón no aparece. */
export function buildWebrtcConfig(values: { apiKey?: string; connectionId?: string; fromNumber?: string }): WebrtcConfig | null {
  const apiKey = (values.apiKey ?? "").trim();
  const connectionId = (values.connectionId ?? "").trim();
  const fromNumber = (values.fromNumber ?? "").trim();
  if (!apiKey || !connectionId || !fromNumber) return null;
  return { apiKey, connectionId, fromNumber };
}

export function webrtcConfigFromEnv(): WebrtcConfig | null {
  return buildWebrtcConfig({
    apiKey: process.env.TELNYX_API_KEY,
    connectionId: env.telnyxWebrtcConnectionId(),
    fromNumber: env.telnyxWebrtcFromNumber(),
  });
}

/** El nombre con que la credencial aparece en el portal de Telnyx. */
export function credentialName(userId: string): string {
  return `kapta-${userId}`;
}

/** El cuerpo para crear la credencial. Separado para probarlo sin red. */
export function credentialBody(cfg: Pick<WebrtcConfig, "connectionId">, userId: string): Record<string, unknown> {
  return { connection_id: cfg.connectionId, name: credentialName(userId), tag: "kapta-webrtc" };
}

/** ¿Parece un JWT? Tres trozos base64url separados por puntos. */
export function looksLikeJwt(text: string): boolean {
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(text);
}

interface TelnyxReply {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}

async function telnyxCall(cfg: Pick<WebrtcConfig, "apiKey">, path: string, body: Record<string, unknown> | null, fetchImpl: typeof fetch): Promise<TelnyxReply> {
  let res: Response;
  try {
    res = await fetchImpl(`${TELNYX_API_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { status: 0, text: `Telnyx no respondió: ${(err as Error).message}`, json: null };
  }
  const text = (await res.text().catch(() => "")).trim();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

function telnyxError(what: string, reply: TelnyxReply): string {
  if (reply.status === 0) return reply.text;
  const errors = (reply.json?.errors as { title?: string; detail?: string }[] | undefined) ?? [];
  const first = errors[0];
  const detail = first ? [first.title, first.detail].filter(Boolean).join(": ") : "";
  return `Telnyx rechazó ${what} (${reply.status})${detail ? `: ${detail}` : ""}`;
}

export async function createCredential(
  cfg: WebrtcConfig,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string } | { error: string }> {
  const reply = await telnyxCall(cfg, "/telephony_credentials", credentialBody(cfg, userId), fetchImpl);
  const id = (reply.json?.data as { id?: string } | undefined)?.id;
  if (reply.status >= 200 && reply.status < 300 && id) return { id };
  return { error: telnyxError("la credencial para llamar desde la computadora", reply) };
}

export async function requestToken(
  cfg: WebrtcConfig,
  credentialId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ token: string } | { error: string; status: number }> {
  const reply = await telnyxCall(cfg, `/telephony_credentials/${encodeURIComponent(credentialId)}/token`, null, fetchImpl);
  // Telnyx lo devuelve en texto plano; se acepta también envuelto en JSON por si
  // un día cambia.
  const wrapped = (reply.json?.data as { token?: string } | undefined)?.token ?? (reply.json?.token as string | undefined);
  const token = (typeof wrapped === "string" ? wrapped : reply.text).trim();
  if (reply.status >= 200 && reply.status < 300 && looksLikeJwt(token)) return { token };
  return { error: telnyxError("el acceso a la línea", reply), status: reply.status };
}

const TABLE = "telnyx_webrtc_credentials";

/**
 * El token de la persona. Crea su credencial la primera vez y la reutiliza
 * después; si en Telnyx la borraron (404) o es de otra conexión, crea otra una
 * sola vez.
 */
export async function webrtcLoginToken(
  admin: SupabaseClient,
  cfg: WebrtcConfig,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ token: string } | { error: string }> {
  const { data, error } = await admin.from(TABLE).select("credential_id, connection_id").eq("user_id", userId).maybeSingle();
  if (error) return { error: `No se pudo leer tu acceso a la línea: ${error.message}` };
  const row = data as { credential_id: string; connection_id: string } | null;
  let credentialId = row && row.connection_id === cfg.connectionId ? row.credential_id : null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!credentialId) {
      const created = await createCredential(cfg, userId, fetchImpl);
      if ("error" in created) return created;
      credentialId = created.id;
      const { error: saveError } = await admin.from(TABLE).upsert(
        { user_id: userId, credential_id: credentialId, connection_id: cfg.connectionId, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
      if (saveError) return { error: `No se pudo guardar tu acceso a la línea: ${saveError.message}` };
    }
    const token = await requestToken(cfg, credentialId, fetchImpl);
    if ("token" in token) return token;
    if (token.status === 404 && attempt === 0) {
      credentialId = null;
      continue;
    }
    return { error: token.error };
  }
  return { error: "No se pudo obtener el acceso a la línea." };
}
