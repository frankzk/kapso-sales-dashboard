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
import { listProducts } from "@/lib/aliclik";
import { syncAliclikCatalog } from "@/lib/aliclik-catalog";
import { env } from "@/lib/env";
import { describeShalomError, describeShalomProbeFailure } from "@/lib/shalom/client";
import { clientFor, loadStoreShalom, mintSession, publicClient } from "@/lib/shalom/session";

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
    // Estos dos existían en el formulario pero no se leían acá, así que la
    // clave de Anthropic por tienda (5l del DEPLOY) nunca llegaba a guardarse.
    anthropic_api_key: get("anthropic_api_key"),
    anthropic_model: get("anthropic_model"),
  }, undefined, {
    shalom_pro_email: (currentStore as { shalom_pro_email?: string | null } | null)?.shalom_pro_email ?? null,
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

  const report = await syncAliclikCatalog(storeId, { apiToken: creds.aliclik_api_token }, ctx.admin);
  revalidatePath(`/dashboard/${storeId}/settings`);
  if (!report.ok) return { error: report.errors.join("; ") || "No se pudo sincronizar." };
  const detail = `${report.skus} SKUs, ${report.agencies} agencias, ${report.autoMapped} mapeos automáticos`;
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
