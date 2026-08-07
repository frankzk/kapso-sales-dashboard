// Ingesta del "Live Chat Webhook" de Chatby (white-label de uChat).
//
// Chatby lo configura en Ajustes → Integrations → Live Chat Support → Webhook,
// con dos campos: la URL y UNA cabecera personalizada. Su propio placeholder
// sugiere `Authorization: Bearer XXXXXX`, así que se aceptan las dos formas
// habituales — `X-Webhook-Secret: <secreto>` y `Authorization: Bearer <secreto>`.
// No se acepta el secreto por query string: hay cabecera disponible, y un
// secreto en la URL termina en los logs de acceso.
//
// El contrato del webhook, según su propia pantalla:
//   "Incoming messages will be sent to the webhook url via POST when the bot is
//    paused."
// O sea: solo entrantes, y solo con la automatización pausada.
//
// ESTE MÓDULO NO INTERPRETA NADA. Autentica y guarda el JSON crudo. El formato
// del payload no está documentado y no se puede pedir el histórico, así que la
// prioridad es no perder ninguna entrega mientras se aprende la forma. Cualquier
// intento de mapear a leads acá sería adivinanza, y adivinar de qué tienda es un
// mensaje (el webhook es por cuenta, compartido entre Aurela y Kenku) haría que
// una conversación aparezca en la tienda equivocada.
//
// Separado de la ruta para poder testearlo sin HTTP, igual que
// processKapsoWebhook (lib/ingest.ts) y processSwaypWebhook (lib/swayp-ingest.ts).

import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";

export type ChatbyWebhookResult =
  /**
   * Los tres motivos responden 401 pero se distinguen a propósito, por lo mismo
   * que en Swayp: quien configura el webhook está del otro lado de una pantalla
   * de ajustes y no ve nuestras variables de entorno. Un 401 opaco no distingue
   * "todavía no cargamos el secreto" de "la cabecera está mal escrita", y eso
   * cuesta una tarde. No filtra nada: que el endpoint no esté configurado, o que
   * falte la cabecera, no son secretos.
   */
  | { status: "unauthorized"; reason: "not_configured" | "missing_secret" | "bad_secret" }
  | { status: "stored"; id: string | null; userNs: string | null; parsed: boolean }
  | { status: "error"; reason: string };

/** ¿Está cargado el secreto del webhook? Para el health-check, sin revelarlo. */
export function chatbyWebhookConfigured(): boolean {
  return Boolean(env.chatbyWebhookSecret());
}

/** Constant-time compare with an equal-length gate (mirrors lib/ingest.ts). */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Saca el secreto de las cabeceras. Se recorta el valor por lo mismo que en
 * Shalom y Swayp: el secreto viaja copiado y pegado a mano entre dos paneles, y
 * un blanco al borde da 401 SIEMPRE — indistinguible de haberlo copiado mal.
 */
export function readChatbySecret(headers: Record<string, string | null | undefined>): string {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") lower[k.toLowerCase()] = v;
  }
  const direct = lower["x-webhook-secret"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const auth = lower["authorization"];
  if (typeof auth === "string" && auth.trim()) {
    // `Bearer xxx`, `bearer xxx` o el valor pelado: Chatby no valida el formato
    // de la cabecera personalizada, así que se acepta lo que razonablemente
    // pueda haber tecleado una persona.
    return auth.trim().replace(/^bearer\s+/i, "").trim();
  }
  return "";
}

/**
 * Busca `user_ns` en el payload, a cualquier profundidad razonable.
 *
 * No es adivinar el formato: `user_ns` es la clave del subscriber en la API de
 * Chatby (está en el modelo `Subscriber` y la exigen `send-content`,
 * `send-text`, `agent-activity-log` y `conversations/data`). Sirve para agrupar
 * las entregas por conversación mientras se diseña la tabla definitiva. Si no
 * viene, se guarda null y listo — nunca se rechaza la entrega por esto.
 */
export function findUserNs(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUserNs(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  const direct = obj.user_ns;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const nested of Object.values(obj)) {
    const found = findUserNs(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Autentica una entrega y la guarda entera.
 *
 * Nunca falla por el contenido: un cuerpo que no es JSON se guarda como
 * `{"_raw": "..."}` en vez de descartarse, y un JSON que no es objeto se envuelve
 * en `{"_payload": ...}` para que la columna jsonb siempre reciba un objeto. La
 * razón es que este webhook es la ÚNICA fuente del texto de las conversaciones y
 * no hay endpoint para pedir lo perdido: una entrega descartada es historia que
 * no vuelve.
 */
export async function processChatbyWebhook(input: {
  headers: Record<string, string | null | undefined>;
  rawBody: string;
  admin?: SupabaseClient;
}): Promise<ChatbyWebhookResult> {
  const expected = env.chatbyWebhookSecret();
  // Sin secreto configurado no se puede autenticar a nadie: cerrado por defecto.
  if (!expected) return { status: "unauthorized", reason: "not_configured" };

  const provided = readChatbySecret(input.headers);
  if (!provided) return { status: "unauthorized", reason: "missing_secret" };
  if (!constantTimeEquals(provided, expected)) {
    return { status: "unauthorized", reason: "bad_secret" };
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

  // Solo los NOMBRES. Un valor podría ser nuestro propio secreto; además así se
  // descubre si Chatby manda alguna firma o id de idempotencia aprovechable.
  const headerNames = Object.entries(input.headers)
    .filter(([, v]) => typeof v === "string")
    .map(([k]) => k.toLowerCase())
    .sort();

  const admin = input.admin ?? createAdminSupabase();
  const { data, error } = await admin
    .from("chatby_webhook_log")
    .insert({
      user_ns: findUserNs(payload),
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
    userNs: findUserNs(payload),
    parsed,
  };
}
