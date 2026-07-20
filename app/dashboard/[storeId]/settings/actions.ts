"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { buildStoreUpdate } from "@/lib/store-settings";
import { getStoreCreds, runStoreSync } from "@/lib/ingest";
import { registerOrderWebhooks } from "@/lib/shopify";
import { buildStoreDailySummary, formatDailySummary, limaDayBounds } from "@/lib/daily-summary";
import { sendTelegramMessage } from "@/lib/telegram";
import { listMetaAdAccounts, type MetaAdAccount, type StoreMetaAdAccount } from "@/lib/meta-marketing";
import { env } from "@/lib/env";

export interface SettingsState {
  error?: string;
  notice?: string;
  /** One-time reveal of a freshly generated Kapso webhook secret. Never stored
   *  in plaintext, so it is only ever returned here, once, right after minting. */
  kapsoSecret?: string;
}

async function requireStoreAdmin(
  storeId: string,
): Promise<{ admin: SupabaseClient; orgId: string } | null> {
  if (!storeId) return null;
  const admin = createAdminSupabase();
  const { data: store } = await admin
    .from("stores")
    .select("id, org_id")
    .eq("id", storeId)
    .maybeSingle();
  if (!store) return null;

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data: m } = await sb
    .from("memberships")
    .select("role")
    .eq("org_id", store.org_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!m || (m.role !== "owner" && m.role !== "admin")) return null;
  return { admin, orgId: store.org_id };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function updateStore(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso para editar esta tienda." };

  const get = (k: string) => {
    const v = formData.get(k);
    return v == null ? undefined : String(v);
  };
  const patch = buildStoreUpdate({
    name: get("name"),
    currency: get("currency"),
    timezone: get("timezone"),
    whatsapp_phone_number_id: get("whatsapp_phone_number_id"),
    kapso_project_id: get("kapso_project_id"),
    status: get("status"),
    shopify_token: get("shopify_token"),
    shopify_webhook_secret: get("shopify_webhook_secret"),
    kapso_api_key: get("kapso_api_key"),
    flow_webhook_secret: get("flow_webhook_secret"),
    kapso_webhook_secret: get("kapso_webhook_secret"),
    browse_template_enabled: get("browse_template_enabled"),
    browse_template_name: get("browse_template_name"),
    browse_template_language: get("browse_template_language"),
    winback_template_enabled: get("winback_template_enabled"),
    winback_template_name: get("winback_template_name"),
    winback_template_language: get("winback_template_language"),
    drip_template_enabled: get("drip_template_enabled"),
    drip_template_name: get("drip_template_name"),
    drip_template_language: get("drip_template_language"),
    cart_seq_enabled: get("cart_seq_enabled"),
    cart_seq_template_1_name: get("cart_seq_template_1_name"),
    cart_seq_template_1_language: get("cart_seq_template_1_language"),
    cart_seq_template_2_name: get("cart_seq_template_2_name"),
    cart_seq_template_2_language: get("cart_seq_template_2_language"),
    cart_seq_hours_1: get("cart_seq_hours_1"),
    cart_seq_hours_2: get("cart_seq_hours_2"),
    cart_seq_hour_start: get("cart_seq_hour_start"),
    cart_seq_hour_end: get("cart_seq_hour_end"),
    telegram_chat_id: get("telegram_chat_id"),
    telegram_bot_token: get("telegram_bot_token"),
    meta_access_token: get("meta_access_token"),
  });

  if (!Object.keys(patch).length) return { notice: "No hay cambios para guardar." };

  const { error } = await ctx.admin.from("stores").update(patch).eq("id", storeId);
  if (error) return { error: error.message };

  revalidatePath(`/dashboard/${storeId}/settings`);
  revalidatePath(`/dashboard/${storeId}`);
  revalidatePath("/dashboard/stores");
  return { notice: "Tienda actualizada." };
}

/**
 * Mint a fresh per-store Kapso webhook secret, store it encrypted, and reveal
 * the plaintext ONCE (it can't be read back afterwards). This is how a store
 * owner secures their Kapso webhook without ever touching the shared CRON_SECRET
 * — the returned URL goes into both Kapso webhooks. Regenerating invalidates the
 * previous secret, so the owner must re-paste the new URL in Kapso.
 */
export async function generateKapsoWebhookSecret(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso para editar esta tienda." };

  // URL-safe (hex) so it drops straight into the webhook `?secret=` param.
  const secret = randomBytes(32).toString("hex");
  const patch = buildStoreUpdate({ kapso_webhook_secret: secret });
  const { error } = await ctx.admin.from("stores").update(patch).eq("id", storeId);
  if (error) return { error: error.message };

  revalidatePath(`/dashboard/${storeId}/settings`);
  return {
    notice: "Secreto de webhook de Kapso generado. Cópialo ahora: no se vuelve a mostrar.",
    kapsoSecret: secret,
  };
}

export async function reRegisterWebhooks(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };

  const creds = await getStoreCreds(storeId, ctx.admin);
  if (!creds?.shopify_token) return { error: "La tienda no tiene token de Shopify configurado." };
  try {
    const callbackUrl = `${env.siteUrl()}/api/webhooks/shopify/${storeId}`;
    const results = await registerOrderWebhooks({
      domain: creds.shopify_domain,
      token: creds.shopify_token,
      callbackUrl,
    });
    const failed = results.filter((r) => r.error);
    if (failed.length) {
      return { error: `Webhooks con problemas: ${failed.map((f) => `${f.topic}: ${f.error}`).join("; ")}` };
    }
    return { notice: `Webhooks registrados: ${results.map((r) => r.topic).join(", ")}.` };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

export async function syncNow(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  try {
    const r = await runStoreSync(storeId, ctx.admin);
    revalidatePath(`/dashboard/${storeId}/settings`);
    revalidatePath(`/dashboard/${storeId}`);
    const e = r.enriched;
    const summary =
      `${r.shopifyOrders} órdenes · ${r.draftOrders} carritos · ${r.kapsoConversations} conversaciones · ops ${r.opsCaptured ? "✓" : "—"}` +
      ` · ${r.whatsappNumbers} números WhatsApp` +
      ` · leads enriquecidos ${e.fetched}/${e.candidates} (🛒${e.cart} 📍${e.district} 💬${e.inbound})`;
    return r.errors.length
      ? { error: `Sync con errores: ${r.errors.join("; ")}`, notice: summary }
      : { notice: `Sync completado: ${summary}.` };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

/** List the ad accounts the store's Meta token can access (for the picker). */
export async function listStoreMetaAdAccounts(
  storeId: string,
): Promise<{ accounts: MetaAdAccount[] } | { error: string }> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const creds = await getStoreCreds(storeId, ctx.admin);
  if (!creds?.meta_access_token) {
    return { error: "Primero pega el access token de Meta arriba y guarda los cambios." };
  }
  const res = await listMetaAdAccounts(creds.meta_access_token);
  if (!res.ok) return { error: `Meta rechazó la consulta: ${res.error}` };
  return { accounts: res.accounts };
}

/** Persist the SELECTED Meta ad accounts (several per store) — their combined
 *  spend will later power ROAS. Sanitizes/dedupes the client payload. */
export async function saveMetaAdAccounts(
  storeId: string,
  accounts: StoreMetaAdAccount[],
): Promise<SettingsState> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const clean: StoreMetaAdAccount[] = [];
  for (const a of accounts ?? []) {
    const id = (a?.id ?? "").trim();
    if (!id || clean.some((x) => x.id === id)) continue;
    clean.push({ id, name: (a?.name ?? "").trim() || null });
  }
  const { error } = await ctx.admin
    .from("stores")
    .update({
      meta_ad_accounts: clean,
      // Keep the legacy single columns in sync (first = primary) for back-compat.
      meta_ad_account_id: clean[0]?.id ?? null,
      meta_ad_account_name: clean[0]?.name ?? null,
    })
    .eq("id", storeId);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${storeId}/settings`);
  return {
    notice: clean.length
      ? `${clean.length} ${clean.length === 1 ? "cuenta guardada" : "cuentas guardadas"} ✓`
      : "Se quitaron las cuentas publicitarias.",
  };
}

export async function sendTelegramTest(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };

  const creds = await getStoreCreds(storeId, ctx.admin);
  if (!creds?.telegram_bot_token || !creds.telegram_chat_id) {
    return { error: "Configura primero el token y el chat id de Telegram (y guarda)." };
  }
  try {
    const { date, startIso, endIso, label } = limaDayBounds(null);
    const summary = await buildStoreDailySummary(ctx.admin, storeId, startIso, endIso, "America/Lima");
    const text = formatDailySummary(creds.name, label, summary, creds.currency);
    const res = await sendTelegramMessage(creds.telegram_bot_token, creds.telegram_chat_id, text);
    if (!res.ok) return { error: `Telegram rechazó el envío: ${res.error}` };
    return { notice: `Resumen de ${date} enviado a Telegram ✓ (${summary.totalOrders} pedidos).` };
  } catch (e) {
    return { error: errMsg(e) };
  }
}
