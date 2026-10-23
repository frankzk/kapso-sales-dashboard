// Ajustes → WooCommerce → «Crear los pedidos nuevos en» (MOM §38.1, §38.12):
// qué se acepta al cambiar `stores.platform` de una tienda y el parche para
// `stores` (0274). Puro y sin imports: lo usan la acción de servidor
// (`app/dashboard/[storeId]/settings/woo-platform-actions.ts`) y, para los
// nombres del formulario, la sección de Ajustes en el navegador.
//
// LO QUE CUIDA:
//   · Solo `shopify` o `woocommerce` (`stores_platform_check`), y solo si
//     cambia: elegir la plataforma que ya tiene no escribe nada.
//   · Una confirmación explícita: el cambio decide dónde se crea cada venta de
//     Leads desde ese instante.
//   · A WooCommerce, solo con las claves de la API completas (lo mismo que
//     exige `stores_woo_platform_check`; si la base lo rechaza igual, el mensaje
//     es el mismo).
//   · `platform_switched_at` se fija la PRIMERA vez que la tienda pasa a
//     WooCommerce y no se mueve después: si la tienda no tiene `woo_intake_from`
//     es el piso de la entrada de pedidos (§38.11), y moverlo dejaría fuera
//     pedidos que Kapta todavía no trajo.
//   · Volver a Shopify solo cambia `platform`. Nada de esto toca
//     `woo_intake_from`, las claves de WooCommerce ni el token de Shopify: la
//     entrada de pedidos de las dos sigue igual (§38.11).

export type StorePlatform = "shopify" | "woocommerce";

/** Los `name` del formulario. La prueba de cableado comprueba que la acción los lea. */
export const WOO_PLATFORM_FIELDS = {
  target: "platform_target",
  confirm: "platform_confirm",
} as const;

export const PLATFORM_LABEL: Record<StorePlatform, string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
};

/** Lo que se contesta si faltan las claves para pasar a WooCommerce. */
export const WOO_PLATFORM_NEEDS_CREDS =
  "Para crear los pedidos en WooCommerce la tienda necesita guardados la dirección del sitio, la clave del sitio, la Consumer key y el Consumer secret (arriba, en «Sitio y claves de la API»). No se cambió nada.";

export function isStorePlatform(value: unknown): value is StorePlatform {
  return value === "shopify" || value === "woocommerce";
}

export interface PlatformSwitchCurrent {
  platform: string;
  /** ¿Tiene guardados el sitio, la clave del sitio y las dos claves de la API (y se pueden descifrar)? */
  apiComplete: boolean;
}

export type PlatformSwitchValidation = { ok: true; target: StorePlatform } | { ok: false; error: string };

/** Valida el cambio pedido contra lo que tiene la tienda. Puro. */
export function validatePlatformSwitch(
  input: { target: unknown; confirm: unknown },
  current: PlatformSwitchCurrent,
): PlatformSwitchValidation {
  const target = typeof input.target === "string" ? input.target.trim() : "";
  if (!isStorePlatform(target)) return { ok: false, error: "Elige Shopify o WooCommerce." };
  if (target === current.platform) {
    return { ok: false, error: `La tienda ya crea sus pedidos nuevos en ${PLATFORM_LABEL[target]}. No se cambió nada.` };
  }
  const confirm = typeof input.confirm === "string" ? input.confirm.trim() : "";
  if (confirm !== "1") {
    return { ok: false, error: "Marca la confirmación: el cambio decide dónde se crea cada venta de Leads. No se cambió nada." };
  }
  if (target === "woocommerce" && !current.apiComplete) return { ok: false, error: WOO_PLATFORM_NEEDS_CREDS };
  return { ok: true, target };
}

/**
 * El parche de `stores`: `platform` y, la primera vez que pasa a WooCommerce,
 * `platform_switched_at`. Nada más.
 */
export function buildPlatformSwitchPatch(
  target: StorePlatform,
  current: { platformSwitchedAt: string | null },
  nowIso: string,
): Record<string, string> {
  if (target === "woocommerce" && !current.platformSwitchedAt) {
    return { platform: "woocommerce", platform_switched_at: nowIso };
  }
  return { platform: target };
}

/** El error de la base al cambiar, en palabras de la operación. */
export function platformSwitchErrorMessage(error: { code?: string | null; message?: string | null } | null): string {
  const msg = String(error?.message ?? "");
  if (error?.code === "23514" && msg.includes("stores_woo_platform_check")) return WOO_PLATFORM_NEEDS_CREDS;
  if (error?.code === "23514") return "La base no aceptó ese valor de plataforma. No se cambió nada.";
  if (error?.code === "42703" || /column .*(woo_|platform)/i.test(msg)) {
    return "Falta aplicar la migración 0274 (WooCommerce) en la base: no se cambió nada.";
  }
  return "No se pudo guardar el cambio. No se cambió nada.";
}

/** El aviso de que salió bien: qué cambia desde ahora y qué no. */
export function platformSwitchNotice(target: StorePlatform): string {
  return target === "woocommerce"
    ? "Listo: desde ahora «Generar pedido», «Venta telefónica» y los buscadores de productos de esta tienda usan WooCommerce. La entrada de pedidos de Shopify y de WooCommerce sigue igual. Para volver, elige Shopify."
    : "Listo: los pedidos nuevos de esta tienda vuelven a crearse en Shopify. WooCommerce sigue trayendo sus pedidos al Master.";
}
