// Sonda de los webhooks de página de Facebook y de Instagram.
//
// QUÉ HACE: autentica la entrega, la guarda entera y NO interpreta nada más allá
// del sobre. Ver la cabecera de db/migrations/0124_meta_social_webhook_log.sql
// para el porqué — en corto: antes de construir la bandeja de comentarios hay
// que saber si los comentarios sobre ANUNCIOS llegan siquiera, y eso solo lo
// contestan entregas reales.
//
// DOS DIFERENCIAS CON EL RECEPTOR DE CHATBY, y las dos vienen de Meta:
//
//   1. La autenticación es una FIRMA, no un secreto compartido: Meta manda
//      `X-Hub-Signature-256: sha256=<hex>`, que es el HMAC-SHA256 del cuerpo
//      EXACTO con el app secret. Por eso el cuerpo se lee como texto y se firma
//      tal cual llegó: parsear y volver a serializar cambia un espacio y tira la
//      firma al suelo. Una firma, además, prueba que el cuerpo no se tocó por el
//      camino — un secreto en cabecera solo prueba quién llama.
//
//   2. Hay un APRETÓN DE MANOS por GET. Meta no empieza a mandar nada hasta que
//      la URL le devuelve el `hub.challenge` que ella misma propone, y solo si el
//      `hub.verify_token` coincide con el que se tecleó en su panel.
//
// Separado de la ruta para poder probarlo sin HTTP, igual que
// processChatbyWebhook, processKapsoWebhook y processSwaypWebhook.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";

export type MetaSocialWebhookResult =
  /**
   * Los motivos responden 401 pero se distinguen, por lo mismo que en Chatby y
   * Swayp: quien configura esto está del otro lado del panel de Meta y no ve
   * nuestras variables de entorno. Un 401 opaco no distingue "todavía no
   * cargamos el app secret" de "la firma no cuadra", y eso cuesta una tarde. No
   * filtra nada: que falte configuración no es un secreto.
   */
  | { status: "unauthorized"; reason: "not_configured" | "missing_signature" | "bad_signature" }
  | {
      status: "stored";
      id: string | null;
      objectType: string | null;
      entryIds: string[];
      fields: string[];
      parsed: boolean;
    }
  | { status: "error"; reason: string };

/** ¿Está cargado el app secret? Para el health-check, sin revelarlo. */
export function metaSocialConfigured(): boolean {
  return Boolean(env.metaAppSecret());
}

/** ¿Y el token del apretón de manos? Son dos cosas distintas y se olvida una. */
export function metaSocialVerifyConfigured(): boolean {
  return Boolean(env.metaWebhookVerifyToken());
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * El apretón de manos de verificación.
 *
 * Meta llama por GET con `hub.mode=subscribe`, su `hub.verify_token` y un
 * `hub.challenge`. Hay que devolver el challenge TAL CUAL y en texto plano; si
 * el token no coincide, no se devuelve nada — devolverlo igualmente convertiría
 * la URL en un verificador para cualquiera.
 */
export function verifyChallenge(params: {
  mode: string | null;
  token: string | null;
  challenge: string | null;
}): { ok: true; challenge: string } | { ok: false; reason: string } {
  const expected = env.metaWebhookVerifyToken();
  if (!expected) return { ok: false, reason: "not_configured" };
  if (params.mode !== "subscribe") return { ok: false, reason: "bad_mode" };
  if (!params.token) return { ok: false, reason: "missing_token" };
  if (!constantTimeEquals(params.token, expected)) return { ok: false, reason: "bad_token" };
  if (!params.challenge) return { ok: false, reason: "missing_challenge" };
  return { ok: true, challenge: params.challenge };
}

/**
 * ¿La firma corresponde a este cuerpo?
 *
 * `rawBody` tiene que ser el cuerpo TAL COMO LLEGÓ. Es la trampa clásica de este
 * webhook: cualquier normalización —parsear y re-serializar, recortar blancos,
 * reordenar claves— produce un HMAC distinto y un 401 que parece un secreto mal
 * copiado cuando en realidad el secreto está bien.
 */
export function signatureMatches(rawBody: string, header: string | null, secret: string): boolean {
  if (!secret) return false;
  const provided = (header ?? "").trim();
  if (!provided.toLowerCase().startsWith("sha256=")) return false;
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return constantTimeEquals(provided.slice("sha256=".length).toLowerCase(), digest);
}

/**
 * El SOBRE de la entrega: lo único que se interpreta.
 *
 * `object`, `entry[].id` y el `field` de cada cambio están documentados por Meta
 * y son iguales en todos sus webhooks, así que leerlos no es adivinar un formato
 * — es usar su vocabulario. Sirven para contestar «cuántas entregas, de qué
 * cuenta y por qué campo» con una consulta en vez de rebuscando en el jsonb.
 *
 * Todo lo demás (el comentario, su autor, el post, el anuncio) se queda crudo a
 * propósito: interpretarlo es justo lo que la sonda viene a evitar hasta tener
 * payloads reales delante.
 */
export function readEnvelope(payload: unknown): {
  objectType: string | null;
  entryIds: string[];
  fields: string[];
} {
  const empty = { objectType: null, entryIds: [] as string[], fields: [] as string[] };
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return empty;

  const root = payload as Record<string, unknown>;
  const objectType = typeof root.object === "string" && root.object.trim() ? root.object.trim() : null;

  const entryIds = new Set<string>();
  const fields = new Set<string>();
  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    // El id llega como string, pero Meta ha mandado números en otros webhooks:
    // se acepta el número y se guarda como texto, que es lo que la columna es.
    if (typeof e.id === "string" && e.id.trim()) entryIds.add(e.id.trim());
    else if (typeof e.id === "number") entryIds.add(String(e.id));

    const changes = Array.isArray(e.changes) ? e.changes : [];
    for (const change of changes) {
      if (change === null || typeof change !== "object") continue;
      const field = (change as Record<string, unknown>).field;
      if (typeof field === "string" && field.trim()) fields.add(field.trim());
    }
    // Los mensajes directos no vienen en `changes` sino en `messaging`. Aunque la
    // sonda mire comentarios, distinguirlos importa: si un día la bandeja recibe
    // DMs por este mismo sobre, hay que saberlo desde los datos y no de golpe.
    if (Array.isArray(e.messaging) && e.messaging.length) fields.add("messaging");
  }

  return { objectType, entryIds: [...entryIds], fields: [...fields] };
}

/**
 * Autentica una entrega y la guarda entera.
 *
 * Nunca falla por el CONTENIDO: un cuerpo que no es JSON se guarda como
 * `{"_raw": "…"}` y un JSON que no es objeto se envuelve en `{"_payload": …}`,
 * para que la columna jsonb siempre reciba un objeto. Sí falla por la FIRMA, y
 * ahí no se guarda nada: sin esa puerta, cualquiera que descubra la URL escribe
 * en nuestra base.
 */
export async function processMetaSocialWebhook(input: {
  headers: Record<string, string | null | undefined>;
  rawBody: string;
  admin?: SupabaseClient;
}): Promise<MetaSocialWebhookResult> {
  const secret = env.metaAppSecret();
  // Sin app secret no se puede verificar a nadie: cerrado por defecto.
  if (!secret) return { status: "unauthorized", reason: "not_configured" };

  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    if (typeof v === "string") lower[k.toLowerCase()] = v;
  }
  const signature = lower["x-hub-signature-256"] ?? null;
  if (!signature) return { status: "unauthorized", reason: "missing_signature" };
  if (!signatureMatches(input.rawBody, signature, secret)) {
    return { status: "unauthorized", reason: "bad_signature" };
  }

  let payload: unknown;
  let parsed = true;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    payload = { _raw: input.rawBody };
    parsed = false;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    payload = { _payload: payload };
  }

  const envelope = readEnvelope(payload);

  // Solo los NOMBRES: uno de los valores es la firma, derivada de nuestro app
  // secret. Y así se descubre qué manda Meta de verdad — id de entrega,
  // reintentos — sin guardar nada que no debamos.
  const headerNames = Object.keys(lower).sort();

  const admin = input.admin ?? createAdminSupabase();
  const { data, error } = await admin
    .from("meta_social_webhook_log")
    .insert({
      object_type: envelope.objectType,
      entry_ids: envelope.entryIds,
      fields: envelope.fields,
      header_names: headerNames,
      parsed,
      payload,
    })
    .select("id")
    .maybeSingle();

  if (error) return { status: "error", reason: error.message };

  const row = data as { id: string } | null;
  return {
    status: "stored",
    id: row?.id ?? null,
    objectType: envelope.objectType,
    entryIds: envelope.entryIds,
    fields: envelope.fields,
    parsed,
  };
}
