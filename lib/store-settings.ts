// Pure helper for building a store-update patch from the settings form.
// Secret fields are only included when a new value is provided (blank = keep
// existing), and are encrypted on the way in. Unit-tested.

import { encrypt } from "@/lib/crypto";

export const STORE_STATUSES = ["active", "paused", "disabled"] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

export interface StoreSettingsInput {
  name?: string;
  currency?: string;
  timezone?: string;
  whatsapp_phone_number_id?: string;
  kapso_project_id?: string;
  status?: string;
  // Browse-abandonment WhatsApp template (plain, non-secret).
  browse_template_enabled?: string | boolean;
  browse_template_name?: string;
  browse_template_language?: string;
  // Winback (recuperación 60 días) WhatsApp template (plain, non-secret).
  winback_template_enabled?: string | boolean;
  winback_template_name?: string;
  winback_template_language?: string;
  // Drip de seguimiento (no contesta) WhatsApp template (plain, non-secret).
  drip_template_enabled?: string | boolean;
  drip_template_name?: string;
  drip_template_language?: string;
  // Secuencia de carritos abandonados (2 plantillas + horas, plain).
  cart_seq_enabled?: string | boolean;
  cart_seq_template_1_name?: string;
  cart_seq_template_1_language?: string;
  cart_seq_template_2_name?: string;
  cart_seq_template_2_language?: string;
  cart_seq_hours_1?: string;
  cart_seq_hours_2?: string;
  cart_seq_hour_start?: string;
  cart_seq_hour_end?: string;
  // Telegram daily summary: chat id is plain, token is a secret.
  telegram_chat_id?: string;
  // Secrets — only applied when non-empty.
  shopify_token?: string;
  shopify_webhook_secret?: string;
  kapso_api_key?: string;
  flow_webhook_secret?: string;
  kapso_webhook_secret?: string;
  telegram_bot_token?: string;
  meta_access_token?: string;
}

function clean(v: string | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Build the column patch. Encrypts any provided secret; omits blank fields. */
export function buildStoreUpdate(
  input: StoreSettingsInput,
  keyOverride?: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const k of ["name", "currency", "timezone", "whatsapp_phone_number_id", "kapso_project_id"] as const) {
    const v = clean(input[k]);
    if (v !== null) patch[k] = v;
  }

  const status = clean(input.status);
  if (status && (STORE_STATUSES as readonly string[]).includes(status)) {
    patch.status = status;
  }

  // Browse-abandonment template config (plain). The enabled flag is a real
  // boolean toggle (so it can be turned OFF); name/language follow the
  // blank = keep-existing convention of the other plain fields.
  if (input.browse_template_enabled !== undefined) {
    patch.browse_template_enabled =
      input.browse_template_enabled === true || input.browse_template_enabled === "true";
  }
  const tplName = clean(typeof input.browse_template_name === "string" ? input.browse_template_name : undefined);
  if (tplName !== null) patch.browse_template_name = tplName;
  const tplLang = clean(typeof input.browse_template_language === "string" ? input.browse_template_language : undefined);
  if (tplLang !== null) patch.browse_template_language = tplLang;

  // Winback template config (plain) — same conventions as the browse trio.
  if (input.winback_template_enabled !== undefined) {
    patch.winback_template_enabled =
      input.winback_template_enabled === true || input.winback_template_enabled === "true";
  }
  const wbName = clean(typeof input.winback_template_name === "string" ? input.winback_template_name : undefined);
  if (wbName !== null) patch.winback_template_name = wbName;
  const wbLang = clean(typeof input.winback_template_language === "string" ? input.winback_template_language : undefined);
  if (wbLang !== null) patch.winback_template_language = wbLang;

  // Drip de seguimiento template config (plain) — same conventions again.
  if (input.drip_template_enabled !== undefined) {
    patch.drip_template_enabled =
      input.drip_template_enabled === true || input.drip_template_enabled === "true";
  }
  const drName = clean(typeof input.drip_template_name === "string" ? input.drip_template_name : undefined);
  if (drName !== null) patch.drip_template_name = drName;
  const drLang = clean(typeof input.drip_template_language === "string" ? input.drip_template_language : undefined);
  if (drLang !== null) patch.drip_template_language = drLang;

  // Secuencia de carritos — mismo trío x2 + horas. Las horas solo se aplican
  // cuando parsean a un entero en rango; un valor inválido conserva el actual.
  if (input.cart_seq_enabled !== undefined) {
    patch.cart_seq_enabled =
      input.cart_seq_enabled === true || input.cart_seq_enabled === "true";
  }
  for (const k of [
    "cart_seq_template_1_name",
    "cart_seq_template_1_language",
    "cart_seq_template_2_name",
    "cart_seq_template_2_language",
  ] as const) {
    const v = clean(input[k]);
    if (v !== null) patch[k] = v;
  }
  const intField = (raw: string | undefined, min: number, max: number): number | null => {
    const v = clean(raw);
    if (v === null) return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  const h1 = intField(input.cart_seq_hours_1, 1, 168);
  if (h1 !== null) patch.cart_seq_hours_1 = h1;
  const h2 = intField(input.cart_seq_hours_2, 1, 336);
  if (h2 !== null) patch.cart_seq_hours_2 = h2;
  const hs = intField(input.cart_seq_hour_start, 0, 23);
  if (hs !== null) patch.cart_seq_hour_start = hs;
  const he = intField(input.cart_seq_hour_end, 1, 24);
  if (he !== null) patch.cart_seq_hour_end = he;

  const tgChat = clean(input.telegram_chat_id);
  if (tgChat !== null) patch.telegram_chat_id = tgChat;

  const token = clean(input.shopify_token);
  if (token) patch.shopify_token_enc = encrypt(token, keyOverride);
  const secret = clean(input.shopify_webhook_secret);
  if (secret) patch.shopify_webhook_secret_enc = encrypt(secret, keyOverride);
  const kapso = clean(input.kapso_api_key);
  if (kapso) patch.kapso_api_key_enc = encrypt(kapso, keyOverride);
  const flow = clean(input.flow_webhook_secret);
  if (flow) patch.flow_webhook_secret_enc = encrypt(flow, keyOverride);
  const kapsoWebhook = clean(input.kapso_webhook_secret);
  if (kapsoWebhook) patch.kapso_webhook_secret_enc = encrypt(kapsoWebhook, keyOverride);
  const tgToken = clean(input.telegram_bot_token);
  if (tgToken) patch.telegram_bot_token_enc = encrypt(tgToken, keyOverride);
  const metaTok = clean(input.meta_access_token);
  if (metaTok) patch.meta_access_token_enc = encrypt(metaTok, keyOverride);

  return patch;
}
