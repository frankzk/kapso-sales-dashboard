"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { buildStoreUpdate } from "@/lib/store-settings";
import { getStoreCreds, runStoreSync } from "@/lib/ingest";
import { registerOrderWebhooks } from "@/lib/shopify";
import { env } from "@/lib/env";

export interface SettingsState {
  error?: string;
  notice?: string;
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
  });

  if (!Object.keys(patch).length) return { notice: "No hay cambios para guardar." };

  const { error } = await ctx.admin.from("stores").update(patch).eq("id", storeId);
  if (error) return { error: error.message };

  revalidatePath(`/dashboard/${storeId}/settings`);
  revalidatePath(`/dashboard/${storeId}`);
  revalidatePath("/dashboard/stores");
  return { notice: "Tienda actualizada." };
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
