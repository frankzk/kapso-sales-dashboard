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
import { sendTelegramToAll } from "@/lib/telegram";
import {
  listMetaAdAccounts,
  probeMetaConnection,
  type MetaAdAccount,
  type MetaConnectionProbe,
  type StoreMetaAdAccount,
} from "@/lib/meta-marketing";
import { metaInsightsRange, syncMetaInsightsHistory } from "@/lib/meta-insights-sync";
import { listProducts } from "@/lib/aliclik";
import { syncAliclikCatalog } from "@/lib/aliclik-catalog";
import { env } from "@/lib/env";
import { REPLY_TOKENS } from "@/lib/wa-reply-templates";
import { PAYMENT_METHOD_KINDS } from "@/lib/payment-methods";
import { normalizeDistrictKey, type DistrictCoverageValue } from "@/lib/district-coverage";
import { saveDistrictCoverageRow } from "@/lib/district-coverage-access";
import { applyConfirmationCycleToStore, recomputeOrderMasterSafe } from "@/lib/order-master";
import { describeShalomError, describeShalomProbeFailure } from "@/lib/shalom/client";
import { clientFor, loadStoreShalom, mintSession, publicClient } from "@/lib/shalom/session";
import { FlowClient } from "@/lib/flow/client";
import { confirmationUrl } from "@/lib/flow/link";
import { processTransitNotifications } from "@/lib/shalom/transit-notify";
import { resolveAgentNames } from "@/lib/agent-names";

export interface SettingsState {
  error?: string;
  notice?: string;
  /** One-time reveal of a freshly generated Kapso webhook secret. Never stored
   *  in plaintext, so it is only ever returned here, once, right after minting. */
  kapsoSecret?: string;
  /** Igual que `kapsoSecret`, para el webhook de Aliclik (0054). */
  aliclikSecret?: string;
  /**
   * Catálogo de la cuenta de Shalom, tal como lo devolvió «Probar conexión».
   * Sirve para que «tipo de paquete por defecto» sea un desplegable: los ids son
   * POR CUENTA (los de la documentación no valen) y el catálogo llega a repetir
   * uno — esta cuenta devuelve `id=2` para «Caja Paquete L» y «Otra Medida» —
   * así que escribirlo a mano es justo donde se cuela el error.
   */
  shalomProducts?: { id: number; title: string; content: string | null }[];
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

  // El email de Shalom llega rellenado en cada guardado: hace falta el valor
  // actual para saber si lo cambiaron de verdad y solo entonces tirar el token
  // de sesión (ver buildStoreUpdate).
  const { data: currentStore } = await ctx.admin
    .from("stores")
    .select("shalom_pro_email")
    .eq("id", storeId)
    .maybeSingle();

  const patch = buildStoreUpdate({
    name: get("name"),
    currency: get("currency"),
    timezone: get("timezone"),
    whatsapp_phone_number_id: get("whatsapp_phone_number_id"),
    kapso_project_id: get("kapso_project_id"),
    order_prefix: get("order_prefix"),
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
    return_recovery_enabled: get("return_recovery_enabled"),
    return_recovery_auto: get("return_recovery_auto"),
    return_recovery_template_name: get("return_recovery_template_name"),
    return_recovery_template_language: get("return_recovery_template_language"),
    return_recovery_params: get("return_recovery_params"),
    return_recovery_phone_number_id: get("return_recovery_phone_number_id"),
    return_recovery_hour_start: get("return_recovery_hour_start"),
    return_recovery_hour_end: get("return_recovery_hour_end"),
    return_recovery_max_days: get("return_recovery_max_days"),
    confirmation_cycle_days: get("confirmation_cycle_days"),
    telegram_chat_id: get("telegram_chat_id"),
    telegram_bot_token: get("telegram_bot_token"),
    meta_access_token: get("meta_access_token"),
    aliclik_api_token: get("aliclik_api_token"),
    aliclik_enabled: get("aliclik_enabled"),
    tanders_email: get("tanders_email"),
    tanders_password: get("tanders_password"),
    tanders_origin_address: get("tanders_origin_address"),
    tanders_origin_lat: get("tanders_origin_lat"),
    tanders_origin_lng: get("tanders_origin_lng"),
    shalom_pro_email: get("shalom_pro_email"),
    shalom_pro_password: get("shalom_pro_password"),
    shalom_origin_terminal_id: get("shalom_origin_terminal_id"),
    shalom_origin_terminal_name: get("shalom_origin_terminal_name"),
    shalom_default_product_id: get("shalom_default_product_id"),
    // Aviso de guía en tránsito (0166).
    shalom_transit_template_enabled: get("shalom_transit_template_enabled"),
    shalom_transit_template_name: get("shalom_transit_template_name"),
    shalom_transit_template_language: get("shalom_transit_template_language"),
    shalom_transit_params: get("shalom_transit_params"),
    shalom_transit_attach_ticket: get("shalom_transit_attach_ticket"),
    shalom_transit_phone_number_id: get("shalom_transit_phone_number_id"),
    shalom_transit_hour_start: get("shalom_transit_hour_start"),
    shalom_transit_hour_end: get("shalom_transit_hour_end"),
    shalom_transit_payment_link: get("shalom_transit_payment_link"),
    shalom_arrival_template_enabled: get("shalom_arrival_template_enabled"),
    shalom_arrival_template_name: get("shalom_arrival_template_name"),
    shalom_arrival_params: get("shalom_arrival_params"),
    shalom_arrival_attach_ticket: get("shalom_arrival_attach_ticket"),
    shalom_voucher_intake_enabled: get("shalom_voucher_intake_enabled"),
    shalom_pickup_key_autosend_enabled: get("shalom_pickup_key_autosend_enabled"),
    flowcl_link_enabled: get("flowcl_link_enabled"),
    flowcl_link_email: get("flowcl_link_email"),
    flowcl_link_ttl_hours: get("flowcl_link_ttl_hours"),
    flowcl_link_yape_only: get("flowcl_link_yape_only"),
    // Estos dos existían en el formulario pero no se leían acá, así que la
    // clave de Anthropic por tienda (5l del DEPLOY) nunca llegaba a guardarse.
    anthropic_api_key: get("anthropic_api_key"),
    anthropic_model: get("anthropic_model"),
    // Flow.cl (0161). Mismo tropiezo que el de arriba, repetido: los campos
    // salieron en el formulario y en buildStoreUpdate, pero no acá, así que el
    // formulario los enviaba y el servidor los tiraba en silencio —la pantalla
    // seguía diciendo «no configurado» sin ningún error—. Hay una prueba que
    // ahora compara los dos ficheros para que no haya una tercera vez.
    flowcl_api_key: get("flowcl_api_key"),
    flowcl_secret_key: get("flowcl_secret_key"),
    flowcl_webhook_secret: get("flowcl_webhook_secret"),
  }, undefined, {
    shalom_pro_email: (currentStore as { shalom_pro_email?: string | null } | null)?.shalom_pro_email ?? null,
  });

  if (!Object.keys(patch).length) return { notice: "No hay cambios para guardar." };

  const { error } = await ctx.admin.from("stores").update(patch).eq("id", storeId);
  if (error) return { error: error.message };

  // El ciclo cambia una fecha DERIVADA de cada pedido en confirmación. Sin
  // reescribirla, la cola seguiría repartida con el ciclo viejo hasta que el
  // barrido pasara pedido por pedido, y quien acaba de guardar no vería nada.
  if (typeof patch.confirmation_cycle_days === "number") {
    await applyConfirmationCycleToStore(ctx.admin, storeId, patch.confirmation_cycle_days);
    revalidatePath("/dashboard/pedidos");
  }

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

/**
 * Acuña el secreto del webhook de Aliclik.
 *
 * Aliclik NO firma sus notificaciones —su documentación no define ni HMAC ni
 * cabecera de autenticación— así que este secreto en la URL es la única barrera
 * entre su webhook y cualquiera que descubra el endpoint. Mismo patrón que el de
 * Kapso: hex (URL-safe), y el texto plano se revela UNA vez.
 */
export async function generateAliclikWebhookSecret(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso para editar esta tienda." };

  const secret = randomBytes(32).toString("hex");
  const patch = buildStoreUpdate({ aliclik_webhook_secret: secret });
  const { error } = await ctx.admin.from("stores").update(patch).eq("id", storeId);
  if (error) return { error: error.message };

  revalidatePath(`/dashboard/${storeId}/settings`);
  return {
    notice: "Secreto de webhook de Aliclik generado. Cópialo ahora: no se vuelve a mostrar.",
    aliclikSecret: secret,
  };
}

/**
 * Comprueba el token de Aliclik contra su API. Solo LECTURA: pide una página de
 * catálogo. Sirve para saber que el token es válido y que el host configurado
 * responde, sin arriesgar ninguna escritura.
 */
export async function testAliclikConnection(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };

  const creds = await getStoreCreds(storeId, ctx.admin);
  if (!creds?.aliclik_api_token) return { error: "Esta tienda no tiene token de Aliclik." };

  // Se prueban las DOS salidas en un solo clic, a propósito.
  //
  // Hoy la directa recibe un 403 de Cloudflare. La de Edge sale por otra red y
  // es la hipótesis que queda por descartar. Probar ambas de una vez convierte
  // este botón en el diagnóstico completo: sea cual sea el resultado, se
  // aprende algo — y quien lo pulsa puede estar en el móvil, sin manera de
  // cambiar variables de entorno ni de repetir la prueba con otra config.
  const token = creds.aliclik_api_token;
  const [direct, edge] = await Promise.all([
    listProducts({ apiToken: token, egress: "direct" }, { limit: 1 }),
    listProducts({ apiToken: token, egress: "edge" }, { limit: 1 }),
  ]);

  const base = env.aliclikApiBase();
  const label = (r: typeof direct) => (r.ok ? `OK (${r.data.count ?? 0} productos)` : r.error);

  if (direct.ok || edge.ok) {
    const via = direct.ok ? "salida directa" : "salida por Edge";
    const count = direct.ok ? direct.data.count : edge.ok ? edge.data.count : 0;
    const extra = direct.ok && !edge.ok ? " (la salida por Edge no; se usará la directa)" : "";
    const flag =
      !direct.ok && edge.ok
        ? " Para que TODO el panel use esta ruta, hay que poner ALICLIK_EGRESS=edge en el entorno."
        : "";
    return {
      notice: `Conexión correcta con ${base} vía ${via} — el catálogo tiene ${count ?? 0} productos.${extra}${flag}`,
    };
  }

  // Las dos fallaron: se informan ambas, porque el par de mensajes es lo que
  // dice si el bloqueo depende de la red de salida o no.
  return {
    error: `Ninguna de las dos salidas llegó a ${base}.\n· Directa (AWS): ${label(direct)}\n· Edge (otra red): ${label(edge)}`,
  };
}

/** Sincroniza el catálogo de Aliclik bajo demanda (además del cron diario). */
export async function syncAliclikCatalogNow(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };

  const creds = await getStoreCreds(storeId, ctx.admin);
  if (!creds?.aliclik_api_token) return { error: "Esta tienda no tiene token de Aliclik." };

  const report = await syncAliclikCatalog(
    storeId,
    { apiToken: creds.aliclik_api_token },
    ctx.admin,
    creds.shopify_token
      ? { domain: creds.shopify_domain, token: creds.shopify_token }
      : undefined,
  );
  revalidatePath(`/dashboard/${storeId}/settings`);
  if (!report.ok) return { error: report.errors.join("; ") || "No se pudo sincronizar." };
  const detail = `${report.shopifySkus} SKUs activos de Shopify, ${report.skus} SKUs de Aliclik, ${report.agencies} agencias, ${report.autoMapped} mapeos automáticos`;
  return {
    notice: report.errors.length
      ? `Catálogo sincronizado (${detail}), con avisos: ${report.errors.join("; ")}`
      : `Catálogo sincronizado: ${detail}.`,
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

/** Validate the saved Meta token, selected accounts and a real Insights query. */
export async function testStoreMetaConnection(
  storeId: string,
): Promise<{ result: MetaConnectionProbe } | { error: string }> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const creds = await getStoreCreds(storeId, ctx.admin);
  if (!creds?.meta_access_token) {
    return { error: "Primero pega el access token de Meta arriba y guarda los cambios." };
  }
  const limaDate = (offsetDays: number) => {
    const date = new Date(Date.now() + offsetDays * 86_400_000);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Lima",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  };
  const result = await probeMetaConnection(
    creds.meta_access_token,
    creds.meta_ad_accounts,
    { from: limaDate(-6), to: limaDate(0) },
  );
  return { result };
}

/** Rebuild the auditable daily ad-level history for the last 90 calendar days. */
export async function backfillStoreMetaInsights(
  storeId: string,
): Promise<{ notice: string } | { error: string }> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const creds = await getStoreCreds(storeId, ctx.admin);
  if (!creds?.meta_access_token) return { error: "Esta tienda no tiene access token de Meta." };
  if (!creds.meta_ad_accounts.length) return { error: "Selecciona al menos una cuenta publicitaria." };

  const report = await syncMetaInsightsHistory(
    ctx.admin,
    storeId,
    creds.meta_access_token,
    creds.meta_ad_accounts,
    metaInsightsRange(90),
  );
  revalidatePath(`/dashboard/${storeId}`);
  revalidatePath(`/dashboard/${storeId}/settings`);
  const summary =
    `${report.rows.toLocaleString("es-PE")} filas diarias · ` +
    `${report.ads.toLocaleString("es-PE")} anuncios · ` +
    `${report.accountsOk}/${report.accounts} cuentas`;
  if (!report.accountsOk) {
    return { error: `No se pudo cargar el histórico: ${report.errors.join("; ")}` };
  }
  return {
    notice: report.errors.length
      ? `Backfill parcial de 90 días: ${summary}. Avisos: ${report.errors.join("; ")}`
      : `Histórico de Meta actualizado (90 días): ${summary}.`,
  };
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
    const res = await sendTelegramToAll(creds.telegram_bot_token, creds.telegram_chat_id, text);
    if (!res.sent) {
      const why = res.results.find((r) => !r.ok)?.error ?? "sin chat id válido";
      return { error: `Telegram rechazó el envío: ${why}` };
    }
    const failed = res.results.filter((r) => !r.ok);
    const extra = failed.length
      ? ` (falló para ${failed.map((r) => r.chatId).join(", ")}: revisa que cada uno haya iniciado el bot)`
      : "";
    return {
      notice: `Resumen de ${date} enviado a Telegram ✓ — ${res.sent}/${res.total} destinatario(s), ${summary.totalOrders} pedidos${extra}.`,
    };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

/**
 * «Enviar ahora los avisos en cola»: drena la cola de esta tienda sin esperar
 * al cron.
 *
 * POR QUÉ EXISTE. El cron corre cada 30 minutos, y cuando se acaba de encender
 * el aviso —o de reactivar unas filas a mano— media hora a ciegas es media hora
 * sin saber si la plantilla tiene bien los parámetros. Con esto se ve al
 * momento, que es cuando se puede corregir.
 *
 * NO FUERZA NADA: manda lo que YA está en `pending` y le toca. El horario, los
 * reintentos y el interruptor de la tienda siguen mandando igual — un botón que
 * se saltara el horario mandaría WhatsApps a las tres de la mañana.
 */
export async function sendTransitQueueNow(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };

  try {
    // Presupuesto corto: hay alguien mirando la pantalla. Lo que no quepa se
    // queda en la cola y lo toma el cron.
    const r = await processTransitNotifications(ctx.admin, { storeId, budgetMs: 45_000 });
    revalidatePath(`/dashboard/${storeId}/settings`);
    const partes = [
      `${r.sent} enviado(s)`,
      r.failed ? `${r.failed} fallido(s)` : null,
      r.skipped ? `${r.skipped} descartado(s)` : null,
      r.deferred ? `${r.deferred} para más tarde` : null,
    ].filter(Boolean);
    const motivos = r.errors.length ? ` — ${r.errors.slice(0, 3).join(" · ")}` : "";
    return { notice: `Cola de avisos: ${partes.join(", ")}.${motivos}` };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

/**
 * «Probar cobro por Flow»: crea una orden real por el importe que se le dé y
 * devuelve el link.
 *
 * POR QUÉ UNA ORDEN DE VERDAD. Flow no tiene un endpoint de prueba, y lo que
 * hay que comprobar es justo lo que solo se ve cobrando: que la firma con el
 * secretKey vale, que la cuenta acepta la moneda, y —lo que no estaba
 * comprobado contra la API real— QUE ADMITE IMPORTES CON DECIMALES. Por eso el
 * importe lleva céntimos: un saldo de verdad casi siempre los tiene, y
 * descubrirlo con la primera clienta es descubrirlo tarde.
 *
 * ES UNA SONDA, NO UN COBRO NUESTRO: no se escribe en `flowcl_payment_links`
 * porque no hay pedido al que colgarla, y caduca en 30 minutos.
 *
 * SI SE PAGA, EL DINERO ES REAL Y NO SE CUELGA DE NINGÚN PEDIDO. El webhook
 * busca el token en `flowcl_payment_links`, no lo encuentra y contesta
 * «desconocido», que es la verdad: entró plata en la cuenta de Flow y Kapta no
 * sabe de quién es. Por eso el importe por omisión es pequeño y el aviso está
 * escrito al lado del botón, no enterrado aquí.
 */
export async function testFlowclLink(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };

  const creds = await getStoreCreds(storeId, ctx.admin);
  if (!creds?.flowcl_api_key || !creds.flowcl_secret_key) {
    return { error: "Configura primero la apiKey y la secretKey de Flow.cl (y guarda)." };
  }
  if (!creds.flowcl_webhook_secret) {
    return { error: "Falta el secreto de la url de confirmación (y guardar)." };
  }
  // EL EMAIL SE LEE DE LA PANTALLA, no de la base. El botón de la sonda envía
  // este mismo formulario a otra acción, así que lo que el usuario acaba de
  // escribir viaja aquí — pero NO queda guardado, y React vacía el campo al
  // terminar. Exigir que estuviera guardado convertía al botón en una trampa:
  // se escribe el email justo encima, se pulsa, y contesta que falta el email
  // que se acaba de escribir. Las credenciales sí tienen que estar guardadas,
  // porque son secretos cifrados y el formulario no las trae en claro.
  const email = (String(formData.get("flowcl_link_email") ?? "") || creds.flowcl_link_email || "").trim();
  if (!email) {
    return {
      error:
        "Escribe el email de respaldo del cobro aquí arriba: Flow exige un email del pagador y " +
        "casi ningún pedido trae uno.",
    };
  }

  // El importe lo pone quien prueba: 1.10 sirve para ver que la firma vale,
  // pero Yape y las tarjetas tienen mínimos propios, y para probar un cobro de
  // punta a punta hace falta uno que se pueda pagar de verdad.
  const pedido = Number(String(formData.get("amount") ?? "").replace(",", "."));
  const monto = Number.isFinite(pedido) && pedido > 0 ? pedido : 20;
  if (monto > 500) {
    return { error: "Para una prueba, 500 es más que suficiente. Si necesitas más, dilo a mano." };
  }
  const amount = (Math.round(monto * 100) / 100).toFixed(2);

  const site = env.siteUrl();
  if (!/^https:\/\//i.test(site)) {
    return {
      error: `NEXT_PUBLIC_SITE_URL es «${site}»: con eso el cobro se crea pero el pago no vuelve nunca.`,
    };
  }

  try {
    const client = new FlowClient({
      apiKey: creds.flowcl_api_key,
      secretKey: creds.flowcl_secret_key,
      baseUrl: env.flowclApiBase(),
    });
    const pago = await client.createPayment({
      commerceOrder: `PRUEBA-${randomBytes(4).toString("hex")}`,
      subject: "Prueba de configuración (no hace falta pagarla)",
      amount,
      currency: creds.currency ?? "PEN",
      email,
      urlConfirmation: confirmationUrl(site, storeId, creds.flowcl_webhook_secret),
      urlReturn: `${site.replace(/\/$/, "")}/pago/gracias`,
      timeout: 1800,
    });
    const decimales = amount.endsWith(".00") ? "" : " (con céntimos)";
    const sinGuardar =
      email !== (creds.flowcl_link_email ?? "").trim()
        ? " Ojo: ese email todavía no está guardado — dale a «Guardar cambios» si lo quieres dejar."
        : "";
    return {
      notice:
        `Flow aceptó un cobro de S/ ${amount}${decimales} ✓ — orden ${pago.flowOrder}. ` +
        `Caduca en 30 minutos. Si lo pagas, el dinero entra de verdad y NO queda ` +
        `colgado de ningún pedido: ${pago.link}${sinGuardar}`,
    };
  } catch (e) {
    return { error: `Flow rechazó la prueba: ${errMsg(e)}` };
  }
}

/**
 * "Probar conexión" de Shalom: la sonda de `scripts/shalom-probe.mjs`, pero
 * corriendo en el servidor y en un clic.
 *
 * Prueba las dos mitades por separado porque fallan por motivos distintos y las
 * arregla gente distinta:
 *
 *   1. La API key global (`SHALOM_API_KEY`) contra el directorio de agencias,
 *      que no toca la cuenta de nadie. Si esto falla, el problema es del
 *      despliegue y no hay nada que la tienda pueda hacer.
 *   2. La cuenta de Shalom Pro de la tienda, pidiendo el token de sesión. ES LA
 *      PARTE LENTA (~90 s, hasta 2 min): el wrapper entra de verdad al panel.
 *
 * Si las dos pasan, se listan los productos de la cuenta — que es de donde sale
 * el id que hay que poner como producto por defecto, porque el catálogo es por
 * cuenta y los ids de la documentación no valen.
 *
 * Todo son LECTURAS: no crea ninguna guía. Y deja la sesión caliente, así que la
 * primera guía después de probar ya no espera.
 */
export async function testShalomConnection(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };

  if (!env.shalomConfigured()) {
    return {
      error:
        "Falta SHALOM_API_KEY en el servidor. Es global (una para todas las tiendas), así que se configura en las variables de entorno del despliegue, no acá.",
    };
  }

  // ── 1. La API key ─────────────────────────────────────────────────────────
  const probe = publicClient();
  try {
    await probe.searchAgencies({ q: "lima" });
  } catch (e) {
    return { error: describeShalomProbeFailure(e, env.shalomApiBase()) };
  }
  const cupo =
    probe.rateLimit.remaining != null
      ? ` (quedan ${probe.rateLimit.remaining}/${probe.rateLimit.limit ?? 60} llamadas este minuto)`
      : "";

  // ── 2. La cuenta de la tienda ─────────────────────────────────────────────
  const store = await loadStoreShalom(ctx.admin, storeId);
  if (!store?.shalom_pro_email || !store.shalom_pro_password_enc) {
    return {
      notice: `✓ La API key del wrapper funciona${cupo}. Falta la cuenta de Shalom Pro de esta tienda: cárgala abajo y vuelve a probar.`,
    };
  }

  let session: Awaited<ReturnType<typeof mintSession>>;
  try {
    session = await mintSession(ctx.admin, storeId, store);
  } catch (e) {
    return {
      error: `La API key funciona, pero la cuenta de Shalom Pro fue rechazada: ${describeShalomError(e)}`,
    };
  }
  if ("error" in session) return { error: session.error };

  const comoLlego =
    session.source === "login"
      ? "sesión nueva"
      : session.source === "shared"
        ? "reusando la sesión de otra tienda con la misma cuenta"
        : "sesión que ya estaba activa";
  const vence = new Date(session.expiresAt).toLocaleString("es-PE", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });

  // ── 3. El catálogo, que es lo que hace falta para terminar de configurar ──
  //
  // Se devuelve además EN CRUDO (`shalomProducts`), no solo como texto: es lo
  // que convierte el «tipo de paquete por defecto» en un desplegable en vez de
  // un id a mano. Leerlo exige la sesión de Shalom Pro —los ~90 s de login— así
  // que no se puede pedir al abrir Ajustes sin volver la página inservible;
  // colgarlo de esta prueba, que ya paga esa sesión, es lo único que sale
  // gratis. Mientras no se pruebe la conexión, el campo sigue aceptando el id.
  let productos = "";
  let shalomProducts: SettingsState["shalomProducts"];
  try {
    const { client } = clientFor(await loadStoreShalom(ctx.admin, storeId) ?? store);
    const list = await client.products();
    if (list.length) {
      shalomProducts = list.map((p) => ({ id: p.id, title: p.title, content: p.content ?? null }));
      productos = `\nProductos de esta cuenta (ya cargados en el desplegable de «tipo de paquete por defecto»):\n${list
        .map((p) => `  · id ${p.id} — ${p.title}${p.content ? ` (${p.content})` : ""}`)
        .join("\n")}`;
    } else {
      productos = "\nLa cuenta no devolvió productos, lo cual es raro: revísalo en pro.shalom.pe.";
    }
  } catch (e) {
    productos = `\nNo se pudo leer el catálogo de productos: ${describeShalomError(e)}`;
  }

  revalidatePath(`/dashboard/${storeId}/settings`);
  return {
    shalomProducts,
    notice:
      `✓ Todo conectado.\n` +
      `API key del wrapper: OK${cupo}.\n` +
      `Cuenta ${store.shalom_pro_email}: OK — ${comoLlego}, vence ${vence}.${productos}`,
  };
}

/**
 * Busca agencias desde Ajustes, que es donde hace falta: el id de la agencia de
 * ORIGEN se configura acá y no hay otra forma de averiguarlo. Solo pide la API
 * key global, así que responde rápido y funciona aunque la cuenta de la tienda
 * todavía no esté cargada.
 */
export async function findShalomAgencies(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  if (!(await requireStoreAdmin(storeId))) return { error: "Sin permiso." };
  if (!env.shalomConfigured()) return { error: "Falta SHALOM_API_KEY en el servidor." };

  const q = String(formData.get("shalom_agency_q") ?? "").trim();
  if (q.length < 2) return { error: "Escribe al menos 2 letras para buscar." };

  try {
    const found = await publicClient().searchAgencies({ q });
    if (!found.length) return { notice: `Ninguna agencia coincide con "${q}".` };
    return {
      notice:
        `Agencias que coinciden con "${q}" — copia el id en «agencia de origen»:\n` +
        found
          .slice(0, 20)
          .map((a) => {
            const donde = [a.departamento, a.provincia, a.distrito].filter(Boolean).join(" · ");
            return `  · id ${a.id} — ${a.nombre}${donde ? ` (${donde})` : ""}`;
          })
          .join("\n"),
    };
  } catch (e) {
    // Misma lógica que en «Probar conexión»: esta búsqueda solo usa la API key,
    // así que un 404 también apunta a la URL base y no a la agencia buscada.
    return { error: describeShalomProbeFailure(e, env.shalomApiBase()) };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Catálogo de plantillas de respuesta manual (0113)
//
// Es lo que el asesor puede enviar desde el drawer con la ventana de 24 h
// cerrada. Vive acá y no en el drawer —a diferencia de las respuestas rápidas,
// que sí las escribe cualquiera— porque un nombre de plantilla mal escrito no
// rompe un chat: Meta lo rechaza y le baja la calidad a la WABA entera.
// ───────────────────────────────────────────────────────────────────────────

/** Una fila del catálogo, tal como la edita Ajustes. */
export interface ReplyTemplateRow {
  id: string;
  label: string;
  template_name: string;
  language: string;
  body_preview: string | null;
  params: string;
  active: boolean;
  sort: number;
}

/** Lee el catálogo. Tolera que la 0113 no esté aplicada todavía: devuelve vacío
 *  en vez de tumbar la página entera de Ajustes. */
export async function listReplyTemplates(storeId: string): Promise<ReplyTemplateRow[]> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return [];
  const { data, error } = await ctx.admin
    .from("wa_reply_templates")
    .select("id, label, template_name, language, body_preview, params, active, sort")
    .eq("store_id", storeId)
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data as ReplyTemplateRow[] | null) ?? [];
}

export async function addReplyTemplate(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso para editar esta tienda." };

  const label = String(formData.get("label") ?? "").trim();
  const templateName = String(formData.get("template_name") ?? "").trim().toLowerCase();
  const language = String(formData.get("language") ?? "").trim() || "es";
  const bodyPreview = String(formData.get("body_preview") ?? "").trim();
  const rawParams = String(formData.get("params") ?? "").trim();

  if (!label) return { error: "Ponle un nombre que el asesor reconozca." };
  if (label.length > 60) return { error: "El nombre visible es muy largo (máx. 60)." };
  // Meta solo acepta minúsculas, dígitos y guion bajo. Decirlo acá evita el
  // 132001 en el envío, que llega como un número sin explicación.
  if (!/^[a-z0-9_]{1,512}$/.test(templateName)) {
    return { error: "El nombre en Meta solo lleva minúsculas, números y guion bajo." };
  }
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(language)) {
    return { error: "El idioma va como 'es' o 'es_PE'." };
  }

  // Los tokens desconocidos se RECHAZAN acá, aunque el envío los ignore: este es
  // el único momento en que alguien puede corregir la config antes de que un
  // parámetro de menos se convierta en un rechazo de Meta.
  const tokens = rawParams
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const unknown = tokens.filter((t) => !(REPLY_TOKENS as readonly string[]).includes(t));
  if (unknown.length) {
    return {
      error: `Token desconocido: ${unknown.join(", ")}. Válidos: ${REPLY_TOKENS.join(", ")}.`,
    };
  }
  // El cuerpo debe declarar tantos {{n}} como tokens configurados, o el envío
  // sale con parámetros de más o de menos y Meta lo rechaza con #132018.
  if (bodyPreview) {
    const highest = [...bodyPreview.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].reduce(
      (max, m) => Math.max(max, Number(m[1])),
      0,
    );
    if (highest !== tokens.length) {
      return {
        error: `El cuerpo usa hasta {{${highest}}} pero configuraste ${tokens.length} parámetro(s).`,
      };
    }
  }

  const { error } = await ctx.admin.from("wa_reply_templates").insert({
    store_id: storeId,
    label,
    template_name: templateName,
    language,
    body_preview: bodyPreview || null,
    params: tokens.join(","),
  });
  if (error) {
    if (error.code === "23505") return { error: "Esa plantilla ya está cargada en este idioma." };
    return { error: error.message };
  }
  revalidatePath(`/dashboard/${storeId}/settings`);
  return { notice: `Plantilla «${label}» agregada ✓` };
}

/** Retirar sin borrar. Meta pausa plantillas y las deja obsoletas; apagarla la
 *  saca del desplegable del drawer y conserva a qué apuntaba lo ya enviado. */
export async function setReplyTemplateActive(
  storeId: string,
  id: string,
  active: boolean,
): Promise<SettingsState> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const { error } = await ctx.admin
    .from("wa_reply_templates")
    .update({ active })
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${storeId}/settings`);
  return { notice: active ? "Plantilla activada ✓" : "Plantilla retirada ✓" };
}

export async function deleteReplyTemplate(storeId: string, id: string): Promise<SettingsState> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const { error } = await ctx.admin
    .from("wa_reply_templates")
    .delete()
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${storeId}/settings`);
  return { notice: "Plantilla eliminada ✓" };
}

// ---------------------------------------------------------------------------
// Cuentas de cobro que ve el cliente (0166)
// ---------------------------------------------------------------------------
//
// Lo que se contesta a los botones del aviso de guía en tránsito («Pagar con
// Yape», «Transferencia Depósito») y lo que rellena {{yape}} en la plantilla.
// Es una lista por tienda, como las plantillas de respuesta: N cuentas que
// cambian sin desplegar. NO es `store_collection_accounts`, que sirve para
// verificar comprobantes — ver lib/payment-methods.ts.

export async function addPaymentMethod(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso para editar esta tienda." };

  const kind = String(formData.get("kind") ?? "").trim().toLowerCase();
  const label = String(formData.get("label") ?? "").trim();
  const holder = String(formData.get("holder") ?? "").trim();
  const account = String(formData.get("account") ?? "").trim();
  const detail = String(formData.get("detail") ?? "").trim();
  const primaryYape = String(formData.get("primary_yape") ?? "") === "true";

  if (!(PAYMENT_METHOD_KINDS as readonly string[]).includes(kind)) {
    return { error: `Tipo desconocido. Válidos: ${PAYMENT_METHOD_KINDS.join(", ")}.` };
  }
  if (!label || label.length > 40) return { error: "Ponle un nombre corto (máx. 40): BCP, YAPE 1…" };
  if (!holder || holder.length > 80) return { error: "Falta a nombre de quién está la cuenta." };
  // Dígitos, guiones y espacios: es lo que el cliente va a teclear en su app.
  if (!/^[0-9][0-9 -]{4,40}$/.test(account)) {
    return { error: "El número solo lleva dígitos, guiones y espacios." };
  }
  if (primaryYape && kind !== "yape") {
    return { error: "El Yape principal tiene que ser de tipo Yape." };
  }

  // Un solo Yape principal por tienda: si este lo es, el anterior deja de serlo.
  if (primaryYape) {
    await ctx.admin
      .from("store_payment_methods")
      .update({ primary_yape: false, updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("primary_yape", true);
  }

  const { error } = await ctx.admin.from("store_payment_methods").insert({
    store_id: storeId,
    kind,
    label,
    holder,
    account,
    detail: detail || null,
    primary_yape: primaryYape,
  });
  if (error) {
    if (error.code === "23505") return { error: "Ya hay una cuenta con ese nombre en esta tienda." };
    return { error: error.message };
  }
  revalidatePath(`/dashboard/${storeId}/settings`);
  return { notice: `Cuenta «${label}» agregada ✓` };
}

/** Retirar sin borrar: una cuenta que dejó de usarse sigue nombrada en
 *  respuestas ya enviadas. */
export async function setPaymentMethodActive(
  storeId: string,
  id: string,
  active: boolean,
): Promise<SettingsState> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const { error } = await ctx.admin
    .from("store_payment_methods")
    // Al retirar el Yape principal deja de serlo: el índice parcial solo mira
    // los activos, pero el botón no debe contestar una cuenta retirada.
    .update({ active, ...(active ? {} : { primary_yape: false }), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${storeId}/settings`);
  return { notice: active ? "Cuenta activada ✓" : "Cuenta retirada ✓" };
}

/** La cuenta que contesta a «Pagar con Yape» y rellena {{yape}}. Una sola. */
export async function setPrimaryYape(storeId: string, id: string): Promise<SettingsState> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const { data: row } = await ctx.admin
    .from("store_payment_methods")
    .select("kind,active")
    .eq("id", id)
    .eq("store_id", storeId)
    .maybeSingle();
  const r = (row ?? null) as { kind: string; active: boolean } | null;
  if (!r) return { error: "No se encontró la cuenta." };
  if (r.kind !== "yape") return { error: "El Yape principal tiene que ser de tipo Yape." };
  if (!r.active) return { error: "Activa la cuenta antes de hacerla principal." };

  const now = new Date().toISOString();
  const cleared = await ctx.admin
    .from("store_payment_methods")
    .update({ primary_yape: false, updated_at: now })
    .eq("store_id", storeId)
    .eq("primary_yape", true);
  if (cleared.error) return { error: cleared.error.message };
  const { error } = await ctx.admin
    .from("store_payment_methods")
    .update({ primary_yape: true, updated_at: now })
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${storeId}/settings`);
  return { notice: "Yape principal actualizado ✓" };
}

export async function deletePaymentMethod(storeId: string, id: string): Promise<SettingsState> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const { error } = await ctx.admin
    .from("store_payment_methods")
    .delete()
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${storeId}/settings`);
  return { notice: "Cuenta eliminada ✓" };
}

// ---------------------------------------------------------------------------
// Excepciones de cobertura por distrito (0121)
// ---------------------------------------------------------------------------
//
// La regla general clasifica por geografía: Pucusana está en la provincia de
// Lima, luego «Lima». Pero a Pucusana el reparto propio no llega y sale por
// agencia — una decisión de la operación que hasta ahora solo se podía cambiar
// tocando código. Acá se guardan esas excepciones.
//
// Quien decide de verdad es `order_coverage_for` en la base, que consulta esta
// tabla ANTES que cualquier regla automática. Estas acciones solo la editan y se
// encargan de lo que la tabla por sí sola no hace: que los pedidos YA abiertos
// de ese distrito cambien de etapa, en vez de esperar a que alguien los toque.

export interface DistrictCoverageRow {
  id: string;
  store_id: string | null;
  district: string;
  coverage: string;
  note: string | null;
  updated_at: string;
}

export async function listDistrictCoverage(storeId: string): Promise<DistrictCoverageRow[]> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return [];
  // Se listan las globales Y las de esta tienda: son las dos que pueden afectar
  // a sus pedidos, y ocultar las globales haría parecer que no hay ninguna regla.
  const { data, error } = await ctx.admin
    .from("district_coverage")
    .select("id,store_id,district,coverage,note,updated_at")
    .or(`store_id.is.null,store_id.eq.${storeId}`)
    .order("district", { ascending: true });
  if (error) return [];
  return (data as DistrictCoverageRow[] | null) ?? [];
}

/**
 * Recalcula los pedidos abiertos del distrito tocado.
 *
 * Sin esto la excepción solo valdría para los pedidos nuevos y los de hoy
 * seguirían mostrando la cobertura anterior — el mismo desfase del read-model
 * que costó 69 pedidos congelados en «Por confirmar» (ver MOM §19.1). Se acota a
 * los NO cerrados: reclasificar un pedido entregado hace dos meses cambiaría su
 * historia sin que nadie lo haya pedido.
 */
async function recomputeDistrictOrders(
  admin: ReturnType<typeof createAdminSupabase>,
  storeId: string,
  district: string,
  scopeAllStores: boolean,
): Promise<number> {
  let q = admin
    .from("order_master")
    .select("order_id")
    .ilike("district", district)
    .not("macro_stage", "in", "(finalizado)")
    .limit(2000);
  if (!scopeAllStores) q = q.eq("store_id", storeId);
  const { data } = await q;
  const ids = ((data ?? []) as { order_id: string }[]).map((r) => r.order_id);
  if (!ids.length) return 0;
  const done = await recomputeOrderMasterSafe(admin, ids);
  return done.written;
}

export async function saveDistrictCoverage(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso para editar esta tienda." };

  const raw = String(formData.get("district") ?? "").trim();
  const district = normalizeDistrictKey(raw);
  const coverage = String(formData.get("coverage") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;
  const allStores = String(formData.get("all_stores") ?? "") === "on";

  if (!district) return { error: "Indica el distrito." };
  if (!["lima", "provincia_cod", "agencia"].includes(coverage)) {
    return { error: "Cobertura no válida." };
  }

  const { error } = await saveDistrictCoverageRow(ctx.admin, {
    storeId: allStores ? null : storeId,
    district,
    coverage: coverage as DistrictCoverageValue,
    note,
    updatedBy: null,
  });
  if (error) return { error };

  const recomputed = await recomputeDistrictOrders(ctx.admin, storeId, district, allStores);
  revalidatePath(`/dashboard/${storeId}/settings`);
  revalidatePath("/dashboard/pedidos");
  return {
    notice:
      `«${raw}» queda como ${coverage === "provincia_cod" ? "Provincia COD" : coverage === "lima" ? "Lima" : "Agencia"}.` +
      (recomputed ? ` ${recomputed} pedido(s) abiertos reclasificados.` : ""),
  };
}

export async function deleteDistrictCoverage(
  storeId: string,
  id: string,
): Promise<SettingsState> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso para editar esta tienda." };

  const { data: row } = await ctx.admin
    .from("district_coverage")
    .select("district,store_id")
    .eq("id", id)
    .maybeSingle();
  const { error } = await ctx.admin.from("district_coverage").delete().eq("id", id);
  if (error) return { error: error.message };

  const target = row as { district: string; store_id: string | null } | null;
  const recomputed = target
    ? await recomputeDistrictOrders(ctx.admin, storeId, target.district, target.store_id === null)
    : 0;
  revalidatePath(`/dashboard/${storeId}/settings`);
  return {
    notice:
      "Excepción eliminada; ese distrito vuelve a la regla general." +
      (recomputed ? ` ${recomputed} pedido(s) abiertos reclasificados.` : ""),
  };
}

// ── La escalera de la cola de cobranza (0172) ───────────────────────────────

/** Quién atiende, en qué orden y cuántos minutos espera cada uno. */
export async function listEscalation(
  storeId: string,
): Promise<{ id: string; userId: string; name: string; minutes: number; sort: number }[]> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return [];
  const { data } = await ctx.admin
    .from("store_collection_escalation")
    .select("id,user_id,minutes,sort")
    .eq("store_id", storeId)
    .order("sort", { ascending: true });
  const rows = ((data ?? []) as { id: string; user_id: string; minutes: number; sort: number }[]);
  if (!rows.length) return [];
  const names = await resolveAgentNames(
    rows.map((r) => r.user_id),
    ctx.admin,
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: names[r.user_id] ?? r.user_id.slice(0, 8),
    minutes: r.minutes,
    sort: r.sort,
  }));
}

export async function addEscalationStep(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const userId = String(formData.get("user_id") ?? "").trim();
  if (!userId) return { error: "Elige a quién añadir." };
  const minutes = Math.max(1, Math.min(1440, Number(formData.get("minutes") ?? 30) || 30));

  // Al final de la escalera: el que llega nuevo no le quita el turno a nadie.
  const { data: last } = await ctx.admin
    .from("store_collection_escalation")
    .select("sort")
    .eq("store_id", storeId)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sort = ((last as { sort?: number } | null)?.sort ?? 0) + 10;

  const { error } = await ctx.admin
    .from("store_collection_escalation")
    .insert({ store_id: storeId, user_id: userId, minutes, sort });
  if (error) {
    if ((error as { code?: string }).code === "23505") return { error: "Esa persona ya está en la escalera." };
    return { error: error.message };
  }
  revalidatePath(`/dashboard/${storeId}/settings`);
  return { notice: "Añadido a la escalera ✓" };
}

export async function removeEscalationStep(storeId: string, id: string): Promise<SettingsState> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const { error } = await ctx.admin.from("store_collection_escalation").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${storeId}/settings`);
  return { notice: "Quitado de la escalera ✓" };
}

/** Mueve un escalón arriba o abajo intercambiando su `sort` con el vecino. */
export async function moveEscalationStep(
  storeId: string,
  id: string,
  direction: "up" | "down",
): Promise<SettingsState> {
  const ctx = await requireStoreAdmin(storeId);
  if (!ctx) return { error: "Sin permiso." };
  const { data } = await ctx.admin
    .from("store_collection_escalation")
    .select("id,sort")
    .eq("store_id", storeId)
    .order("sort", { ascending: true });
  const rows = ((data ?? []) as { id: string; sort: number }[]);
  const i = rows.findIndex((r) => r.id === id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= rows.length) return { error: "Ya está en el extremo." };
  await ctx.admin.from("store_collection_escalation").update({ sort: rows[j]!.sort }).eq("id", rows[i]!.id);
  await ctx.admin.from("store_collection_escalation").update({ sort: rows[i]!.sort }).eq("id", rows[j]!.id);
  revalidatePath(`/dashboard/${storeId}/settings`);
  return { notice: "Orden actualizado ✓" };
}
