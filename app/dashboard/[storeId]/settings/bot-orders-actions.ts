"use server";

// Ajustes → «Bot de Kapso → pedidos por Kapta» (MOM §38.13): generar, cambiar y
// desactivar el secreto con el que el bot de Kapso pide pedidos a Kapta
// (`POST /api/internal/orders/<storeId>`, lib/bot-orders.ts). Con «Administrar
// tiendas» (`stores.manage`), como las demás credenciales de la tienda.
//
// EL SECRETO NO SE GUARDA. Se genera aquí, se guarda solo su sha256
// (`bot_order_secrets.secret_hash`, 0277) y vuelve UNA vez en la respuesta,
// para pegarlo en la acción de Kapso. Kapta no puede volver a mostrarlo: si se
// pierde, se genera otro (el anterior deja de servir en ese instante).
//
// Nada de aquí cambia `stores.platform` ni llama a WooCommerce o a Shopify.

import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { BOT_ORDERS_MIGRATION_MISSING, generateBotSecret, hashBotSecret, isBotOrdersMigrationMissing } from "@/lib/bot-orders";
import type { SettingsState } from "./actions";

/** Lo de siempre, más el secreto recién generado (una vez). */
export interface BotOrdersSettingsState extends SettingsState {
  botSecret?: string;
}

/** La puerta: la tienda existe, hay sesión y quien pide tiene «Administrar tiendas». */
async function requireBotOrdersAdmin(storeId: string): Promise<{ admin: SupabaseClient; userId: string } | null> {
  if (!storeId) return null;
  const admin = createAdminSupabase();
  const { data: store } = await admin.from("stores").select("id, org_id").eq("id", storeId).maybeSingle();
  if (!store) return null;
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  if (!(await hasOrgPermission((store as { org_id: string }).org_id, "stores.manage"))) return null;
  return { admin, userId: user.id };
}

/**
 * «Generar secreto» / «Cambiar secreto». La primera vez crea la fila
 * (`created_at`); después solo cambia el hash y `rotated_at`: el secreto
 * anterior deja de servir en el mismo instante. Deja una línea `[bot-orders]`
 * en el registro (tienda, quién y cuándo), sin el secreto.
 */
export async function generateBotOrdersSecret(_prev: BotOrdersSettingsState, formData: FormData): Promise<BotOrdersSettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireBotOrdersAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const secret = generateBotSecret();
  const at = new Date().toISOString();
  const { data: before, error: readErr } = await ctx.admin
    .from("bot_order_secrets")
    .select("store_id")
    .eq("store_id", storeId)
    .maybeSingle();
  if (readErr) return { error: isBotOrdersMigrationMissing(readErr) ? BOT_ORDERS_MIGRATION_MISSING : "No se pudo leer el secreto actual." };
  const { error } = before
    ? await ctx.admin.from("bot_order_secrets").update({ secret_hash: hashBotSecret(secret), rotated_at: at }).eq("store_id", storeId)
    : await ctx.admin
        .from("bot_order_secrets")
        .insert({ store_id: storeId, secret_hash: hashBotSecret(secret), created_at: at, rotated_at: at });
  if (error) return { error: isBotOrdersMigrationMissing(error) ? BOT_ORDERS_MIGRATION_MISSING : "No se pudo guardar el secreto." };
  console.info(`[bot-orders] ${JSON.stringify({ store: storeId, step: before ? "secret_rotated" : "secret_created", by: ctx.userId, at })}`);
  revalidatePath(`/dashboard/${storeId}/settings`);
  return {
    notice: before
      ? "Secreto nuevo guardado. El anterior ya no sirve: pega este en la acción de Kapso ahora. No se vuelve a mostrar."
      : "Secreto guardado. Pégalo en la acción de Kapso («Authorization: Bearer …»): no se vuelve a mostrar.",
    botSecret: secret,
  };
}

/**
 * «Desactivar»: borra el secreto. Desde ese instante el endpoint contesta 401 a
 * esta tienda y el bot deriva a una asesora. Los candados y pedidos ya creados
 * no se tocan.
 */
export async function revokeBotOrdersSecret(_prev: BotOrdersSettingsState, formData: FormData): Promise<BotOrdersSettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireBotOrdersAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const { error } = await ctx.admin.from("bot_order_secrets").delete().eq("store_id", storeId);
  if (error) return { error: isBotOrdersMigrationMissing(error) ? BOT_ORDERS_MIGRATION_MISSING : "No se pudo desactivar." };
  console.info(`[bot-orders] ${JSON.stringify({ store: storeId, step: "secret_revoked", by: ctx.userId, at: new Date().toISOString() })}`);
  revalidatePath(`/dashboard/${storeId}/settings`);
  return { notice: "Desactivado: el bot ya no puede pedir pedidos a Kapta en esta tienda hasta que generes otro secreto." };
}
