// Ajustes → WooCommerce (MOM §37.11): qué se acepta al guardar las credenciales
// de WooCommerce de una tienda, y el parche cifrado para `stores` (0273).
//
// Puro salvo `encrypt` (lib/crypto). Lo usa la acción de servidor
// (`app/dashboard/[storeId]/settings/woo-actions.ts`); el navegador no lo
// importa: nunca ve un secreto, solo si hay uno.
//
// LO QUE CUIDA:
//   · La dirección del sitio es https, de un dominio público y sin redirección
//     a otra parte (`normalizeWooSiteUrl`): Kapta le manda las claves.
//   · La clave del sitio va dentro del id de cada pedido (`wc-kp-1532`): una vez
//     que hay pedidos de WooCommerce con ella, no se cambia.
//   · Las claves de la API van de a dos (la Consumer key con su secret) y con la
//     forma que les da WooCommerce (`ck_…`, `cs_…`).
//   · El secreto de los webhooks no lleva `& < > " '`: WooCommerce lo pasa por
//     `wp_specialchars_decode` antes de firmar, y con esos caracteres firmaría
//     con otro secreto que el guardado.
//   · Un campo en blanco conserva lo guardado. Nada se borra desde aquí.

import { encrypt } from "@/lib/crypto";
import { isValidWooSiteKey, normalizeWooSiteUrl } from "@/lib/woocommerce";

/** Los `name` del formulario. La prueba de cableado comprueba que la acción lea todos. */
export const WOO_SETTINGS_FIELDS = {
  siteUrl: "woo_site_url",
  siteKey: "woo_site_key",
  consumerKey: "woo_consumer_key",
  consumerSecret: "woo_consumer_secret",
  webhookSecret: "woo_webhook_secret",
} as const;

export interface WooSettingsInput {
  siteUrl?: string | null;
  siteKey?: string | null;
  consumerKey?: string | null;
  consumerSecret?: string | null;
  webhookSecret?: string | null;
}

/** Lo que ya tiene la tienda (sin secretos: solo si hay uno). */
export interface WooSettingsCurrent {
  siteUrl: string | null;
  siteKey: string | null;
  hasConsumerKey: boolean;
  hasConsumerSecret: boolean;
  hasWebhookSecret: boolean;
  /** ¿Ya hay pedidos de WooCommerce en esta tienda? Entonces la clave del sitio no cambia. */
  hasWooOrders: boolean;
}

/** Lo que se va a guardar, ya validado. Solo lo que cambia. */
export interface WooSettingsValues {
  siteUrl?: string;
  siteKey?: string;
  consumerKey?: string;
  consumerSecret?: string;
  webhookSecret?: string;
}

export type WooSettingsValidation =
  | {
      ok: true;
      values: WooSettingsValues;
      /** Cambian el sitio o las claves de la API: hay que probarlos antes de guardar. */
      apiChanged: boolean;
      /** Con lo nuevo y lo guardado, ¿la tienda queda con todo para leer pedidos? */
      apiComplete: boolean;
    }
  | { ok: false; error: string };

const CONSUMER_KEY_RE = /^ck_[A-Za-z0-9]{8,128}$/;
const CONSUMER_SECRET_RE = /^cs_[A-Za-z0-9]{8,128}$/;
/** Sin espacios ni `& < > " '`, de 16 a 200. */
const WEBHOOK_SECRET_RE = /^[^\s&<>"']{16,200}$/;

function clean(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

/** Valida lo que llegó del formulario contra lo que ya hay. Puro. */
export function validateWooSettings(input: WooSettingsInput, current: WooSettingsCurrent): WooSettingsValidation {
  const values: WooSettingsValues = {};

  const siteUrlRaw = clean(input.siteUrl);
  if (siteUrlRaw) {
    const siteUrl = normalizeWooSiteUrl(siteUrlRaw);
    if (!siteUrl) {
      return {
        ok: false,
        error:
          "La dirección del sitio tiene que ser https://… de un dominio público (sin IP, sin puerto, sin usuario ni «/wp-json»). Ejemplo: https://kenku.pe",
      };
    }
    if (siteUrl !== current.siteUrl) values.siteUrl = siteUrl;
  }

  const siteKeyRaw = clean(input.siteKey).toLowerCase();
  if (siteKeyRaw) {
    if (!isValidWooSiteKey(siteKeyRaw)) {
      return {
        ok: false,
        error: "La clave del sitio son minúsculas y dígitos, de 2 a 12, empezando por letra (por ejemplo «kp» o «aur»).",
      };
    }
    if (siteKeyRaw !== current.siteKey) {
      if (current.siteKey && current.hasWooOrders) {
        return {
          ok: false,
          error: `La clave del sitio no se cambia: ya hay pedidos de WooCommerce guardados como «wc-${current.siteKey}-…». No se guardó nada.`,
        };
      }
      values.siteKey = siteKeyRaw;
    }
  }

  const consumerKey = clean(input.consumerKey);
  if (consumerKey) {
    if (!CONSUMER_KEY_RE.test(consumerKey)) {
      return { ok: false, error: "La Consumer key de WooCommerce empieza por «ck_». Cópiala de WooCommerce → Ajustes → Avanzado → API REST." };
    }
    values.consumerKey = consumerKey;
  }
  const consumerSecret = clean(input.consumerSecret);
  if (consumerSecret) {
    if (!CONSUMER_SECRET_RE.test(consumerSecret)) {
      return { ok: false, error: "El Consumer secret de WooCommerce empieza por «cs_». Cópialo de WooCommerce → Ajustes → Avanzado → API REST." };
    }
    values.consumerSecret = consumerSecret;
  }
  // Una clave nueva sin su secreto (o al revés) dejaría una pareja que no
  // existe en WooCommerce.
  if (Boolean(values.consumerKey) !== Boolean(values.consumerSecret)) {
    return {
      ok: false,
      error: "La Consumer key y el Consumer secret van juntos: pega los dos de la misma clave de la API REST.",
    };
  }

  const webhookSecret = clean(input.webhookSecret);
  if (webhookSecret) {
    if (!WEBHOOK_SECRET_RE.test(webhookSecret)) {
      return {
        ok: false,
        error:
          "El secreto de los webhooks tiene de 16 a 200 caracteres, sin espacios ni & < > \" ' (WooCommerce los transforma antes de firmar). Usa «Generar secreto».",
      };
    }
    values.webhookSecret = webhookSecret;
  }

  if (!Object.keys(values).length) return { ok: false, error: "No hay cambios que guardar." };

  const siteUrl = values.siteUrl ?? current.siteUrl;
  const siteKey = values.siteKey ?? current.siteKey;
  if (!siteUrl) return { ok: false, error: "Falta la dirección del sitio WooCommerce (https://…)." };
  if (!siteKey) return { ok: false, error: "Falta la clave del sitio (por ejemplo «kp» o «aur»): va en el id de cada pedido." };

  const hasKey = Boolean(values.consumerKey) || current.hasConsumerKey;
  const hasSecret = Boolean(values.consumerSecret) || current.hasConsumerSecret;
  return {
    ok: true,
    values,
    apiChanged: Boolean(values.siteUrl || values.consumerKey || values.consumerSecret),
    apiComplete: hasKey && hasSecret,
  };
}

/** El parche de `stores` (0273): las claves cifradas, la dirección y la clave del sitio tal cual. */
export function buildWooSettingsPatch(values: WooSettingsValues, keyOverride?: string): Record<string, string> {
  const patch: Record<string, string> = {};
  if (values.siteUrl) patch.woo_site_url = values.siteUrl;
  if (values.siteKey) patch.woo_site_key = values.siteKey;
  if (values.consumerKey) patch.woo_consumer_key_enc = encrypt(values.consumerKey, keyOverride);
  if (values.consumerSecret) patch.woo_consumer_secret_enc = encrypt(values.consumerSecret, keyOverride);
  if (values.webhookSecret) patch.woo_webhook_secret_enc = encrypt(values.webhookSecret, keyOverride);
  return patch;
}

/** ¿Este error de la base es por la clave o el sitio ya usados en otra tienda? */
export function wooUniqueViolationMessage(error: { code?: string | null; message?: string | null } | null): string | null {
  if (!error || error.code !== "23505") return null;
  const msg = String(error.message ?? "");
  if (msg.includes("stores_woo_site_key_uniq")) return "Esa clave del sitio ya la usa otra tienda de Kapta. No se guardó nada.";
  if (msg.includes("stores_woo_site_url_uniq")) return "Ese sitio WooCommerce ya está en otra tienda de Kapta: cada pedido entraría dos veces. No se guardó nada.";
  return "Ese valor ya lo usa otra tienda de Kapta. No se guardó nada.";
}

/** El aviso de que la 0273 no está aplicada (columna `woo_*` o `platform` inexistente). */
export function isWooMigrationMissing(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  return error.code === "42703" || /column .*(woo_|platform)/i.test(String(error.message ?? ""));
}
