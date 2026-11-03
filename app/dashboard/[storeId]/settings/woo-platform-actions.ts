"use server";

// Ajustes → WooCommerce → «Crear los pedidos nuevos en: Shopify / WooCommerce»
// (MOM §38.1, §38.12): cambia `stores.platform`, que decide dónde crean sus
// pedidos «Generar pedido», «Venta telefónica» y los buscadores de productos de
// la tienda. Con «Administrar tiendas» (`stores.manage`), como las demás
// credenciales.
//
// Va aparte de woo-actions.ts a propósito: aquellas acciones guardan las
// claves y nunca tocan la plataforma; esta solo toca la plataforma (y, la
// primera vez, `platform_switched_at`). Ni `woo_intake_from`, ni las claves de
// WooCommerce, ni el token de Shopify (lib/woocommerce-platform.ts).
//
// PASAR A WOOCOMMERCE PRUEBA ANTES. Con las claves guardadas y solo contra el
// sitio guardado, dos llamadas:
//   · leer: `GET /wp-json/wc/v3/orders?per_page=1`;
//   · escribir sin cambiar nada: `POST /wp-json/wc/v3/orders/batch` con `{}`
//     (sin crear, editar ni borrar: WooCommerce contesta una lista vacía). La
//     entrada de pedidos solo necesita leer, así que una clave de «Lectura»
//     pasa la primera prueba; con ella cada «Generar pedido» fallaría en el
//     POST (401 «does not have write permissions»,
//     WC_REST_Authentication::check_permissions, que mira el método antes que
//     la ruta).
// Si alguna falla, no se cambia: una tienda que crea sus ventas en un sitio
// que no responde, o que no la deja escribir, no vende. VOLVER A SHOPIFY NO
// PRUEBA NADA: es la vuelta atrás y tiene que poder hacerse siempre.

import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { WooError, wooGetPage, wooRequest } from "@/lib/woocommerce";
import {
  WOO_STORE_COLUMNS,
  hasWooApiCredentials,
  withWooAuthFallback,
  wooClientOpts,
  wooCredsFromRow,
} from "@/lib/woocommerce-intake";
import { isWooMigrationMissing } from "@/lib/woocommerce-settings";
import {
  WOO_PLATFORM_FIELDS,
  buildPlatformSwitchPatch,
  platformSwitchErrorMessage,
  platformSwitchNotice,
  validatePlatformSwitch,
} from "@/lib/woocommerce-platform";
import type { SettingsState } from "./actions";

/** La puerta: la tienda existe, hay sesión y quien pide tiene «Administrar tiendas». */
async function requirePlatformAdmin(storeId: string): Promise<{ admin: SupabaseClient; userId: string } | null> {
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
 * «Cambiar»: la plataforma donde Kapta crea los pedidos nuevos de la tienda.
 * Deja una línea en el registro del servidor (tienda, de qué a qué, quién y
 * cuándo), sin secretos.
 */
export async function switchStorePlatform(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requirePlatformAdmin(storeId);
  if (!ctx) return { error: "Sin permiso para cambiar esta tienda." };

  const { data, error } = await ctx.admin.from("stores").select(WOO_STORE_COLUMNS).eq("id", storeId).maybeSingle();
  if (error) return { error: isWooMigrationMissing(error) ? platformSwitchErrorMessage(error) : "No se pudo leer la tienda." };
  if (!data) return { error: "No se encontró la tienda." };
  const row = data as Record<string, unknown>;
  const creds = wooCredsFromRow(row);
  const from = creds.platform;

  const validation = validatePlatformSwitch(
    {
      target: formData.get(WOO_PLATFORM_FIELDS.target),
      confirm: formData.get(WOO_PLATFORM_FIELDS.confirm),
    },
    { platform: from, apiComplete: hasWooApiCredentials(creds) },
  );
  if (!validation.ok) return { error: validation.error };
  const target = validation.target;

  if (target === "woocommerce" && hasWooApiCredentials(creds)) {
    let auth: "basic" | "query";
    try {
      ({ auth } = await withWooAuthFallback(wooClientOpts(creds), (o) => wooGetPage(o, "/orders", { per_page: 1, status: "any" })));
    } catch (e) {
      return {
        error: `No se cambió: WooCommerce no responde con las claves guardadas. ${e instanceof WooError ? e.message : "No se pudo conectar."}`,
      };
    }
    try {
      await wooRequest({ ...wooClientOpts(creds), auth }, { method: "POST", path: "/orders/batch", body: {} });
    } catch (e) {
      return {
        error: `No se cambió: las claves guardadas leen pero no pueden crear pedidos en WooCommerce. ${e instanceof WooError ? e.message : "No se pudo conectar."}`,
      };
    }
  }

  const at = new Date().toISOString();
  const patch = buildPlatformSwitchPatch(
    target,
    { platformSwitchedAt: typeof row.platform_switched_at === "string" ? row.platform_switched_at : null },
    at,
  );
  // Solo si sigue en la plataforma que se leyó: dos personas cambiando a la vez
  // no se pisan en silencio.
  const { data: updated, error: upErr } = await ctx.admin
    .from("stores")
    .update(patch)
    .eq("id", storeId)
    .eq("platform", from)
    .select("id");
  if (upErr) return { error: platformSwitchErrorMessage(upErr) };
  if (!Array.isArray(updated) || updated.length !== 1) {
    return { error: "Alguien cambió la plataforma de esta tienda recién. Recarga la página y vuelve a intentarlo." };
  }
  console.info(
    `[woo-platform] ${JSON.stringify({ storeId, from, to: target, by: ctx.userId, at, firstSwitch: "platform_switched_at" in patch })}`,
  );
  revalidatePath(`/dashboard/${storeId}/settings`);
  revalidatePath("/dashboard/leads");
  return { notice: platformSwitchNotice(target) };
}
