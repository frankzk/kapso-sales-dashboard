// Origen de un pedido: por dónde entró exactamente, en pocas palabras (MOM §3,
// «Origen en la ficha», 30-10-2026).
//
// No es un canal nuevo. Junta las señales que Kapta YA guarda y las lee con las
// reglas que ya existen —el canal de venta por etiquetas (`salesChannel`, §3),
// la precedencia del canal de cierre (§17.3: la venta de la asesora gana, luego
// la recompra automática, luego el bot…) y el `kapta_channel` de WooCommerce
// (§38.5)— para decir, en la ficha de UN pedido, el detalle que esos canales
// agrupan: qué asesora y con qué botón, qué carrito se completó, si fue el bot
// de Kapso o Chatby, si pagó en el checkout.
//
// Lo que no se sabe no se inventa: un carrito completado sin venta de asesora
// pudo cerrarlo la clienta o el bot (Shopify no lo distingue, §17.3) y así se
// dice; un pedido sin ninguna marca es «Sin marca».
//
// Pura: `getOrderMasterDetail` lee los hechos (solo para el pedido abierto) y
// esta función decide el texto. test/order-origin.test.ts la prueba.

import { salesChannel } from "@/lib/sales-channel";

/** Los hechos que ya existen sobre el pedido. Todo es opcional: falta = no se sabe. */
export interface OrderOriginFacts {
  platform: "shopify" | "woocommerce";
  /** `orders.tags`. */
  tags: readonly unknown[] | null;
  /** `orders.kapso_conversation_id`. */
  kapsoConversationId: string | null;
  /** `orders.payment_gateway` (lib/payment-gateway.ts): checkout / manual / cod. */
  paymentGateway: string | null;
  /** De `orders.raw` (`orderOriginRawFacts`). */
  raw: OrderOriginRawFacts;
  /** La venta registrada en `order_sales` (append-only, §17.3), si hay. */
  sale: {
    /** Quién la registró (correo o nombre); null si no se pudo leer. */
    sellerName: string | null;
    /** `sale_action` (el botón) o `backfill_match` (emparejada después). */
    source: string | null;
    /** `leads.source` del lead de la venta: `manual` = «Venta telefónica». */
    leadSource: string | null;
  } | null;
  /** El borrador / carrito de `draft_orders` que terminó en este pedido. */
  draftName: string | null;
  /** Es el pedido de una prueba de recompra (`auto_order_trials`). */
  autoOrderTrial: boolean;
}

/** Lo que se lee de `orders.raw`, con la forma de Shopify REST/GraphQL o la copia de WooCommerce (§38.7). */
export interface OrderOriginRawFacts {
  /** `raw.woo.created_via`: cod-core-form, cod-core-chatby, kapta, rest-api, admin, checkout… */
  wooCreatedVia: string | null;
  /** `raw.woo.payment_method` (`flowpayment` = Flow, «Tarjeta o Yape»). */
  wooPaymentMethod: string | null;
  /** El meta `kapta_channel` (§38.5). */
  kaptaChannel: string | null;
  /** `raw.source_name` de Shopify REST (`web`, `shopify_draft_order`, el id de una app). */
  sourceName: string | null;
  /**
   * Las marcas del enlace por el que llegó la clienta (`utm_*`), de los
   * atributos del pedido (en WooCommerce, la atribución `_wc_order_attribution_utm_*`
   * que `wooNoteAttributes` copia como `utm_*`) o, en Shopify, de `landing_site`.
   * null = no trae ninguna.
   */
  utm: OrderUtm | null;
}

export interface OrderUtm {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  id: string | null;
}

export interface OrderOrigin {
  /** El origen en pocas palabras: «Web · formulario contra entrega». */
  label: string;
  /** De dónde se dedujo, una pista por señal. */
  evidence: string[];
  /**
   * De dónde llegó la clienta, si el enlace traía marca (27-11-2026, owner: «haz
   * que Kapta muestre el origen del correo»): «Correo · black_friday_2026»,
   * «Anuncio de Meta · CBO Cayenne Pepper | 0608». No cambia `label`: uno dice
   * por dónde se creó el pedido y el otro por dónde entró la clienta.
   */
  arrival?: OrderArrival | null;
}

export interface OrderArrival {
  kind: "correo" | "meta" | "tiktok" | "google" | "otro";
  label: string;
  /** Las marcas tal cual: «utm_source = resend · utm_medium = email · …». */
  evidence: string;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const UTM_KEYS = ["source", "medium", "campaign", "content", "id"] as const;

/** Las `utm_*` de la URL de entrada de Shopify (`landing_site`: «/?utm_source=…»). */
function utmFromLandingSite(landing: string | null): Partial<Record<(typeof UTM_KEYS)[number], string>> {
  if (!landing || !landing.includes("utm_")) return {};
  const q = landing.indexOf("?");
  if (q < 0) return {};
  const out: Partial<Record<(typeof UTM_KEYS)[number], string>> = {};
  try {
    const params = new URLSearchParams(landing.slice(q + 1));
    for (const k of UTM_KEYS) {
      const v = text(params.get(`utm_${k}`));
      if (v) out[k] = v;
    }
  } catch {
    return {};
  }
  return out;
}

/** Lee de `orders.raw` las señales de origen. Tolera cualquier forma (o nada). */
export function orderOriginRawFacts(raw: unknown): OrderOriginRawFacts {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const woo = r.woo && typeof r.woo === "object" ? (r.woo as Record<string, unknown>) : {};
  let kaptaChannel: string | null = null;
  const utm: Partial<Record<(typeof UTM_KEYS)[number], string>> = {};
  // REST: note_attributes [{name,value}]; GraphQL: customAttributes [{key,value}].
  for (const list of [r.note_attributes, r.customAttributes]) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (!a || typeof a !== "object") continue;
      const attr = a as Record<string, unknown>;
      const name = (text(attr.name) ?? text(attr.key) ?? "").toLowerCase().replace(/^_/, "");
      if (name === "kapta_channel" && !kaptaChannel) kaptaChannel = text(attr.value)?.toLowerCase() ?? null;
      const k = name.startsWith("utm_") ? name.slice(4) : null;
      if (k && (UTM_KEYS as readonly string[]).includes(k)) {
        const v = text(attr.value);
        if (v && !utm[k as (typeof UTM_KEYS)[number]]) utm[k as (typeof UTM_KEYS)[number]] = v;
      }
    }
  }
  for (const [k, v] of Object.entries(utmFromLandingSite(text(r.landing_site)))) {
    if (!utm[k as (typeof UTM_KEYS)[number]]) utm[k as (typeof UTM_KEYS)[number]] = v;
  }
  const hasUtm = UTM_KEYS.some((k) => utm[k]);
  return {
    wooCreatedVia: text(woo.created_via)?.toLowerCase() ?? null,
    wooPaymentMethod: text(woo.payment_method)?.toLowerCase() ?? null,
    kaptaChannel,
    sourceName: text(r.source_name),
    utm: hasUtm
      ? {
          source: utm.source ?? null,
          medium: utm.medium ?? null,
          campaign: utm.campaign ?? null,
          content: utm.content ?? null,
          id: utm.id ?? null,
        }
      : null,
  };
}

/** Quien envía correos de marketing: su nombre en `utm_source` basta. */
const EMAIL_SOURCES = new Set(["resend", "klaviyo", "mailchimp", "brevo", "sendinblue", "email", "newsletter"]);

/** «CBO+Cayenne+Pepper+|+0608» → «CBO Cayenne Pepper | 0608». */
function utmText(v: string | null): string | null {
  if (!v) return null;
  let out = v.replace(/\+/g, " ");
  try {
    out = decodeURIComponent(out);
  } catch {
    /* tal cual */
  }
  out = out.replace(/\s+/g, " ").trim();
  return out ? (out.length > 70 ? `${out.slice(0, 69)}…` : out) : null;
}

/**
 * De dónde llegó la clienta, por las marcas del enlace (MOM §3, «Llegó por»).
 * Correo: `utm_medium = email` o una fuente de correo (Resend…). Meta: `fb`,
 * `facebook`, `ig`, `instagram` o una ubicación de Meta (Facebook_Mobile_Feed…)
 * en la fuente, el medio o el contenido. TikTok y Google por su nombre. Lo
 * demás, la fuente tal cual. Sin marcas, null.
 */
export function orderArrival(utm: OrderUtm | null): OrderArrival | null {
  if (!utm) return null;
  const evidence = UTM_KEYS.filter((k) => utm[k])
    .map((k) => `utm_${k} = ${utmText(utm[k])}`)
    .join(" · ");
  const low = (v: string | null) => (v ?? "").toLowerCase();
  const source = low(utm.source);
  const medium = low(utm.medium);
  const all = `${source} ${medium} ${low(utm.content)}`;
  const campaign = utmText(utm.campaign);
  const withCampaign = (base: string) => (campaign ? `${base} · ${campaign}` : base);
  if (/(^|[^a-z])e-?mail([^a-z]|$)|newsletter/.test(medium) || EMAIL_SOURCES.has(source)) {
    return { kind: "correo", label: withCampaign("Correo"), evidence };
  }
  if (/tiktok/.test(all)) return { kind: "tiktok", label: withCampaign("Anuncio de TikTok"), evidence };
  if (/^(fb|ig|meta)$/.test(source) || /facebook|instagram|messenger|audience_network/.test(all)) {
    return { kind: "meta", label: withCampaign("Anuncio de Meta"), evidence };
  }
  if (/google|youtube/.test(source) || medium === "cpc") return { kind: "google", label: withCampaign("Google"), evidence };
  const src = utmText(utm.source);
  return { kind: "otro", label: withCampaign(src ?? "Enlace con marca"), evidence };
}

/** `created_via` de un pedido cargado a mano en wp-admin (no es un rol de Kapta). */
const WOO_VIA_WP_ADMIN = "admin";

/** Lo que dice `created_via` de WooCommerce, para la evidencia. */
const WOO_VIA: Record<string, string> = {
  "cod-core-form": "formulario COD de la web",
  "cod-core-chatby": "Chatby",
  kapta: "Kapta",
  "rest-api": "la API de WooCommerce",
  admin: "wp-admin",
  checkout: "el checkout de WooCommerce",
  "store-api": "el checkout de WooCommerce",
};

/** El origen del pedido y por dónde llegó la clienta. Nunca falla: sin señales, «Sin marca». */
export function orderOrigin(f: OrderOriginFacts): OrderOrigin {
  return { ...orderCreationOrigin(f), arrival: orderArrival(f.raw.utm ?? null) };
}

/** Por dónde se creó el pedido (la regla de 30-10-2026). */
function orderCreationOrigin(f: OrderOriginFacts): OrderOrigin {
  const ev: string[] = [];
  const { raw } = f;
  const woo = f.platform === "woocommerce";
  const via = raw.wooCreatedVia;
  const lowerTags = (f.tags ?? []).filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase());
  const channel = salesChannel(f.tags, f.kapsoConversationId);
  const draft = f.draftName;

  if (woo && raw.kaptaChannel) ev.push(`kapta_channel = ${raw.kaptaChannel}`);
  if (woo && via) ev.push(`creado por ${WOO_VIA[via] ?? via} (created_via = ${via})`);
  const channelTags = lowerTags.filter((t) =>
    ["venta_manual", "kapso", "whatsapp", "carrito recuperado", "bot", "bot (whatsapp_cloud)", "catalogo-wsp", "easysell-abandoned-checkout", "abandoned_checkout_releasit_cod_form", "easysell_cod_form", "promo-whatsapp"].includes(t),
  );
  if (!woo && channelTags.length) ev.push(`etiquetas: ${channelTags.join(", ")}`);
  if (draft) ev.push(`borrador ${draft} que terminó en este pedido (draft_orders)`);

  // 1. La venta registrada de la asesora: gana a cualquier etiqueta (§17.3).
  if (f.sale) {
    const by = f.sale.sellerName ? ` · por ${f.sale.sellerName}` : "";
    ev.unshift(
      f.sale.source === "backfill_match"
        ? "venta de asesora emparejada después (order_sales, backfill)"
        : "venta registrada por la asesora (order_sales)",
    );
    // Un carrito (etiquetas del formulario abandonado) que la asesora cerró.
    // Si no, el borrador es el que crea el propio «Generar pedido» en Shopify.
    const cart = channel === "web_carrito" ? (draft ? ` · carrito ${draft}` : " · carrito") : "";
    if (f.sale.leadSource === "manual") {
      ev.push("lead creado por «Venta telefónica» (leads.source = manual)");
      return { label: `Venta telefónica${cart}${by}`, evidence: ev };
    }
    if (cart) return { label: `Kapta Leads · completó el carrito${draft ? ` ${draft}` : ""}${by}`, evidence: ev };
    if (f.sale.source === "backfill_match") return { label: `Kapta Leads${by}`, evidence: ev };
    return { label: `Kapta Leads · Generar pedido${by}`, evidence: ev };
  }

  // 2. La prueba de recompra: nadie lo cerró (§17.3).
  if (f.autoOrderTrial) {
    ev.unshift("pedido de la prueba de recompra (auto_order_trials)");
    return { label: draft ? `Recompra automática · carrito ${draft}` : "Recompra automática", evidence: ev };
  }

  switch (channel) {
    case "asesora":
      // `venta_manual` sin venta registrada.
      if (woo && via === WOO_VIA_WP_ADMIN) return { label: "Cargado en wp-admin", evidence: ev };
      if (woo && via === "kapta") {
        ev.push("sin venta registrada en order_sales");
        return { label: "Kapta Leads · Generar pedido", evidence: ev };
      }
      ev.push("sin venta registrada en order_sales");
      return { label: "Asesora · sin venta registrada", evidence: ev };
    case "chatbot":
      if (f.kapsoConversationId) ev.push("trae conversación de Kapso");
      return { label: draft ? `Bot de WhatsApp (Kapso) · carrito ${draft}` : "Bot de WhatsApp (Kapso)", evidence: ev };
    case "bot_carritos":
      return { label: "Bot de carritos externo · carrito recuperado", evidence: ev };
    case "catalogo":
      return { label: "Catálogo de WhatsApp", evidence: ev };
    case "web_carrito": {
      if (woo && via === "cod-core-chatby") {
        return { label: draft ? `Chatby · carrito recuperado ${draft}` : "Chatby · carrito recuperado", evidence: ev };
      }
      // Sin venta de asesora: la clienta o el bot; Shopify no lo distingue (§17.3).
      ev.push("sin venta de asesora: lo completó la clienta o un bot (la tienda no lo distingue)");
      return { label: draft ? `Carrito completado · ${draft}` : "Web · carrito completado", evidence: ev };
    }
    case "web_formulario": {
      const flow = woo && raw.wooPaymentMethod === "flowpayment";
      if (flow || f.paymentGateway === "checkout") {
        ev.push(flow ? "pagó con Flow (payment_method = flowpayment)" : "pagó en el checkout (payment_gateway = checkout)");
        return { label: flow ? "Web · checkout (Flow)" : "Web · checkout", evidence: ev };
      }
      return { label: draft ? `Web · formulario contra entrega · borrador ${draft}` : "Web · formulario contra entrega", evidence: ev };
    }
    default:
      break;
  }

  // 3. Sin etiqueta de canal: lo que diga la plataforma, si dice algo.
  if (woo) {
    if (via === WOO_VIA_WP_ADMIN) return { label: "Cargado en wp-admin", evidence: ev };
    if (via === "checkout" || via === "store-api") return { label: "Web · checkout", evidence: ev };
    if (raw.kaptaChannel) ev.push("ese kapta_channel no está en la tabla de §38.5");
    return { label: "Sin marca", evidence: ev.length ? ev : ["ni kapta_channel ni etiqueta de canal"] };
  }
  const src = raw.sourceName;
  if (src) ev.push(`source_name = ${src}`);
  if (draft || src === "shopify_draft_order") {
    return { label: draft ? `Shopify admin · borrador ${draft}` : "Shopify admin · borrador", evidence: ev };
  }
  if (src === "web") return { label: "Web", evidence: ev };
  if (src && /^\d+$/.test(src)) return { label: "App de Shopify", evidence: ev };
  if (!ev.length) ev.push("ninguna etiqueta de canal ni venta registrada");
  return { label: "Sin marca", evidence: ev };
}
