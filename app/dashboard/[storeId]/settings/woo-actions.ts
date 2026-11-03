"use server";

// Ajustes → WooCommerce (MOM §38.11): guardar el sitio y las claves de
// WooCommerce de una tienda, probar la conexión y generar el secreto de los
// webhooks. Con el mismo permiso que las demás credenciales de la tienda
// («Administrar tiendas», `stores.manage`).
//
// Van aparte de actions.ts porque no pasan por `updateStore`: las claves de
// WooCommerce se prueban antes de guardarse, y la clave del sitio no se cambia
// una vez que hay pedidos con ella.
//
// LOS SECRETOS NO SALEN. Se cifran aquí y se descifran aquí, solo para probar
// la conexión. Ninguna respuesta los lleva, salvo el secreto de webhooks recién
// generado, UNA vez, para pegarlo en WooCommerce (como el de Kapso). Y las
// claves de la API guardadas solo se mandan al sitio guardado: para probar o
// guardar otra dirección hay que escribirlas de nuevo (`WOO_NEW_SITE_NEEDS_KEYS`).
//
// LOS WEBHOOKS (MOM §38.14). Con la conexión probada, «Guardar» y «Probar
// conexión» leen además la lista de webhooks del sitio con las mismas claves
// (solo `GET`) y dicen si los cuatro temas tienen uno activo que entrega a esta
// tienda; con lo guardado, el resultado queda en `sync_state` y en
// `woo_last_error`, como el de la revisión de cada hora.
//
// NADA DE SHOPIFY. Estas acciones solo escriben columnas `woo_*`. No cambian
// `stores.platform` (dónde crea Kapta los pedidos nuevos): ese cambio es del día
// del corte, lo decide el owner y tiene su propia acción con confirmación
// (woo-platform-actions.ts, MOM §38.1 y §38.12).

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { encrypt } from "@/lib/crypto";
import { WooError, normalizeWooSiteUrl, wooGetPage, wooRequest, type WooClientOpts } from "@/lib/woocommerce";
import { WOO_STORE_COLUMNS, recordWooLastError, withWooAuthFallback, wooCredsFromRow, wooHostOf } from "@/lib/woocommerce-intake";
import { checkWooWebhooks, recordWooWebhooksCheck, wooWebhooksNotice } from "@/lib/woocommerce-webhooks-health";
import {
  WOO_NEW_SITE_NEEDS_KEYS,
  WOO_SETTINGS_FIELDS,
  buildWooSettingsPatch,
  isWooMigrationMissing,
  validateWooSettings,
  wooUniqueViolationMessage,
  type WooSettingsInput,
} from "@/lib/woocommerce-settings";
import type { SettingsState } from "./actions";

/** Lo que devuelven estas acciones: lo de siempre, más el secreto recién generado (una vez). */
export interface WooSettingsState extends SettingsState {
  wooSecret?: string;
}

const MIGRATION_MISSING = "Falta aplicar la migración 0274 (WooCommerce) en la base: no se guardó nada.";

/** La puerta: la tienda existe, hay sesión y quien pide tiene «Administrar tiendas» en su organización. */
async function requireWooAdmin(storeId: string): Promise<{ admin: SupabaseClient } | null> {
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
  return { admin };
}

async function loadWooRow(
  admin: SupabaseClient,
  storeId: string,
): Promise<{ row: Record<string, unknown> } | { error: string }> {
  const { data, error } = await admin.from("stores").select(WOO_STORE_COLUMNS).eq("id", storeId).maybeSingle();
  if (error) return { error: isWooMigrationMissing(error) ? MIGRATION_MISSING : "No se pudo leer la tienda." };
  if (!data) return { error: "No se encontró la tienda." };
  return { row: data as Record<string, unknown> };
}

/** ¿Hay pedidos de WooCommerce en esta tienda? Si no se puede saber, se responde que sí (la clave no se toca). */
async function storeHasWooOrders(admin: SupabaseClient, storeId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("orders")
    .select("id")
    .eq("store_id", storeId)
    .eq("platform", "woocommerce")
    .limit(1);
  if (error) return true;
  return Array.isArray(data) && data.length > 0;
}

function formInput(formData: FormData): WooSettingsInput {
  const get = (name: string) => {
    const v = formData.get(name);
    return typeof v === "string" ? v : "";
  };
  return {
    siteUrl: get(WOO_SETTINGS_FIELDS.siteUrl),
    siteKey: get(WOO_SETTINGS_FIELDS.siteKey),
    consumerKey: get(WOO_SETTINGS_FIELDS.consumerKey),
    consumerSecret: get(WOO_SETTINGS_FIELDS.consumerSecret),
    webhookSecret: get(WOO_SETTINGS_FIELDS.webhookSecret),
  };
}

/**
 * «Probar conexión»: `GET /wp-json/wc/v3/orders?per_page=1` (lo mismo que lee la
 * pasada) y, si se puede, la moneda de la tienda. No lee ni guarda pedidos.
 */
async function probeWoo(opts: WooClientOpts): Promise<{ ok: true; notice: string } | { ok: false; error: string }> {
  try {
    const { value: page, auth } = await withWooAuthFallback(opts, (o) =>
      wooGetPage(o, "/orders", { per_page: 1, status: "any" }),
    );
    const parts = [`Conexión correcta con ${wooHostOf(opts.siteUrl)}`];
    parts[0] += page.total != null ? `: ${page.total} pedido${page.total === 1 ? "" : "s"} en el sitio.` : ".";
    if (auth === "query") {
      parts.push(
        "El hosting borra la cabecera Authorization: Kapta manda las claves en la dirección (por https). Conviene pedir al hosting que deje pasar la cabecera.",
      );
    }
    try {
      const { data } = await wooRequest<{ value?: unknown }>(
        { ...opts, auth },
        { path: "/settings/general/woocommerce_currency" },
      );
      const currency = typeof data?.value === "string" ? data.value.trim().toUpperCase() : "";
      if (currency && currency !== "PEN") parts.push(`Ojo: la moneda del sitio es ${currency}, no PEN.`);
      else if (currency) parts.push("Moneda: PEN.");
    } catch {
      /* la moneda es un extra: sin permiso para leerla, la conexión igual sirve */
    }
    return { ok: true, notice: parts.join(" ") };
  } catch (e) {
    return { ok: false, error: e instanceof WooError ? e.message : "No se pudo conectar con WooCommerce." };
  }
}

/**
 * «Guardar»: el sitio, la clave del sitio, las claves de la API y el secreto de
 * los webhooks. Si cambian el sitio o las claves de la API, se prueban antes:
 * si no sirven, no se guarda nada; si sirven, después de guardar se revisan
 * los webhooks del sitio con ellas. Un campo en blanco conserva lo guardado.
 */
export async function saveWooSettings(_prev: WooSettingsState, formData: FormData): Promise<WooSettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireWooAdmin(storeId);
  if (!ctx) return { error: "Sin permiso para editar esta tienda." };
  const loaded = await loadWooRow(ctx.admin, storeId);
  if ("error" in loaded) return { error: loaded.error };
  const stored = wooCredsFromRow(loaded.row);

  const validation = validateWooSettings(formInput(formData), {
    siteUrl: stored.siteUrl,
    siteKey: stored.siteKey,
    hasConsumerKey: Boolean(stored.consumerKey),
    hasConsumerSecret: Boolean(stored.consumerSecret),
    hasWebhookSecret: Boolean(stored.webhookSecret),
    hasWooOrders: stored.siteKey ? await storeHasWooOrders(ctx.admin, storeId) : false,
  });
  if (!validation.ok) return { error: validation.error };
  const { values } = validation;

  let probeNotice: string | null = null;
  // Lo que se probó y salió bien: con eso mismo se revisan después los webhooks.
  let probed: WooClientOpts | null = null;
  if (validation.apiChanged && validation.apiComplete) {
    // Con una dirección nueva, solo las claves escritas ahora (la validación ya
    // lo exige): las guardadas no viajan a otro sitio.
    const newSite = Boolean(values.siteUrl);
    const consumerKey = newSite ? values.consumerKey : (values.consumerKey ?? stored.consumerKey);
    const consumerSecret = newSite ? values.consumerSecret : (values.consumerSecret ?? stored.consumerSecret);
    if (!consumerKey || !consumerSecret) return { error: WOO_NEW_SITE_NEEDS_KEYS };
    const target: WooClientOpts = {
      siteUrl: values.siteUrl ?? stored.siteUrl ?? "",
      consumerKey,
      consumerSecret,
    };
    const probe = await probeWoo(target);
    if (!probe.ok) return { error: `No se guardó: ${probe.error}` };
    probeNotice = probe.notice;
    probed = target;
  }

  const patch: Record<string, unknown> = buildWooSettingsPatch(values);
  if (probeNotice) patch.woo_last_error = null;
  // La primera vez que la tienda queda con las claves de la API, desde ahora
  // entran sus pedidos de WooCommerce: lo creado antes (la historia de Shopify
  // importada al WordPress) no entra como pedido nuevo (MOM §38.11). No se
  // mueve después.
  let intakeFromNow = false;
  if (validation.apiComplete && values.consumerKey && values.consumerSecret && !loaded.row.woo_intake_from) {
    patch.woo_intake_from = new Date().toISOString();
    intakeFromNow = true;
  }
  const { error } = await ctx.admin.from("stores").update(patch).eq("id", storeId);
  if (error) {
    return {
      error:
        wooUniqueViolationMessage(error) ?? (isWooMigrationMissing(error) ? MIGRATION_MISSING : "No se pudo guardar."),
    };
  }

  // Guardado lo que se probó, los webhooks del sitio con esas mismas claves
  // (MOM §38.14): el parche dejó `woo_last_error` en null, así que lo que
  // encuentre es lo único que queda. Solo lectura; nunca frena el guardado.
  let webhooksLine: string | null = null;
  if (probed) {
    const check = await checkWooWebhooks(probed, storeId);
    await recordWooWebhooksCheck(ctx.admin, storeId, check, null);
    webhooksLine = wooWebhooksNotice(check);
  }
  revalidatePath(`/dashboard/${storeId}/settings`);

  const lines = ["Guardado."];
  if (probeNotice) lines.push(probeNotice);
  if (validation.apiComplete) {
    lines.push("Desde ahora la sincronización trae cada 5 minutos los pedidos de este sitio al Master.");
    if (intakeFromNow) {
      lines.push("Solo entran los pedidos creados desde este momento: los anteriores del sitio (por ejemplo, la historia importada de Shopify) no.");
    }
  } else {
    lines.push("Faltan la Consumer key y el Consumer secret para traer pedidos por la API.");
  }
  if (webhooksLine) lines.push(webhooksLine);
  return { notice: lines.join(" ") };
}

/**
 * «Probar conexión»: con lo escrito en el formulario si se escribió algo, si no
 * con lo guardado. No guarda nada de lo escrito. Si la conexión sirve, revisa
 * también los webhooks del sitio. Si prueba lo guardado, deja el resultado en
 * `woo_last_error` (lo limpia si salió bien) y la revisión en `sync_state`.
 */
export async function testWooConnection(_prev: WooSettingsState, formData: FormData): Promise<WooSettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireWooAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const loaded = await loadWooRow(ctx.admin, storeId);
  if ("error" in loaded) return { error: loaded.error };
  const stored = wooCredsFromRow(loaded.row);
  const typed = formInput(formData);

  const typedUrl = (typed.siteUrl ?? "").trim();
  const siteUrl = typedUrl ? normalizeWooSiteUrl(typedUrl) : stored.siteUrl;
  if (typedUrl && !siteUrl) return { error: "La dirección del sitio tiene que ser https://… de un dominio público." };
  const typedKey = (typed.consumerKey ?? "").trim();
  const typedSecret = (typed.consumerSecret ?? "").trim();
  // Las claves guardadas solo viajan al sitio guardado: con otra dirección, las
  // dos tienen que venir escritas.
  if (siteUrl && siteUrl !== stored.siteUrl && (stored.consumerKey || stored.consumerSecret) && !(typedKey && typedSecret)) {
    return { error: WOO_NEW_SITE_NEEDS_KEYS };
  }
  const sameSite = siteUrl === stored.siteUrl;
  const consumerKey = typedKey || (sameSite ? stored.consumerKey : null);
  const consumerSecret = typedSecret || (sameSite ? stored.consumerSecret : null);
  if (!siteUrl || !consumerKey || !consumerSecret) {
    return { error: "Para probar hacen falta la dirección del sitio, la Consumer key y el Consumer secret (escritos o guardados)." };
  }
  const usingStored =
    siteUrl === stored.siteUrl && consumerKey === stored.consumerKey && consumerSecret === stored.consumerSecret;

  const probe = await probeWoo({ siteUrl, consumerKey, consumerSecret });
  // Con la conexión buena, también los webhooks del sitio (MOM §38.14), con las
  // mismas claves y solo lectura.
  const webhooks = probe.ok ? await checkWooWebhooks({ siteUrl, consumerKey, consumerSecret }, storeId) : null;
  if (usingStored) {
    await recordWooLastError(ctx.admin, storeId, probe.ok ? null : `Conexión: ${probe.error}`, stored.lastError);
    // La prueba buena acaba de dejar `woo_last_error` en null.
    if (webhooks) await recordWooWebhooksCheck(ctx.admin, storeId, webhooks, null);
    revalidatePath(`/dashboard/${storeId}/settings`);
  }
  if (!probe.ok) return { error: probe.error };
  const notice = webhooks ? `${probe.notice} ${wooWebhooksNotice(webhooks)}` : probe.notice;
  return { notice: usingStored ? notice : `${notice} (Probado con lo escrito; todavía no se guardó.)` };
}

/**
 * «Generar secreto»: uno nuevo, hexadecimal (WooCommerce firma igual de los dos
 * lados), cifrado en la tienda. Se muestra UNA vez para pegarlo en cada webhook.
 * Los webhooks con el anterior fallan con 401 hasta que se cambie allí.
 */
export async function generateWooWebhookSecret(_prev: WooSettingsState, formData: FormData): Promise<WooSettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireWooAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const secret = randomBytes(24).toString("hex");
  const { error } = await ctx.admin
    .from("stores")
    .update({ woo_webhook_secret_enc: encrypt(secret) })
    .eq("id", storeId);
  if (error) return { error: isWooMigrationMissing(error) ? MIGRATION_MISSING : "No se pudo guardar el secreto." };
  revalidatePath(`/dashboard/${storeId}/settings`);
  return {
    notice:
      "Secreto nuevo guardado. Pégalo en el campo «Secreto» de cada webhook de WooCommerce (los cuatro temas): no se vuelve a mostrar.",
    wooSecret: secret,
  };
}
