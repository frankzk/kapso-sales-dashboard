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
  // Secrets — only applied when non-empty.
  shopify_token?: string;
  shopify_webhook_secret?: string;
  kapso_api_key?: string;
  flow_webhook_secret?: string;
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

  const token = clean(input.shopify_token);
  if (token) patch.shopify_token_enc = encrypt(token, keyOverride);
  const secret = clean(input.shopify_webhook_secret);
  if (secret) patch.shopify_webhook_secret_enc = encrypt(secret, keyOverride);
  const kapso = clean(input.kapso_api_key);
  if (kapso) patch.kapso_api_key_enc = encrypt(kapso, keyOverride);
  const flow = clean(input.flow_webhook_secret);
  if (flow) patch.flow_webhook_secret_enc = encrypt(flow, keyOverride);

  return patch;
}
