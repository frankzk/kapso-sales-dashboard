// Lo que Ajustes → WooCommerce muestra de la revisión de los webhooks (MOM
// §38.14, 25-10-2026): la línea «Revisión de los webhooks…», el aviso aparte
// con lo que falta y la chapa de la sección.
//
// Puro y sin imports: lo usa la sección del navegador
// (components/woocommerce-settings-section.tsx), que no puede arrastrar
// `node:crypto`, y la página de Ajustes para tomar su fila de `sync_state`. La
// revisión misma (la lectura de WooCommerce, lo que se guarda) está en
// lib/woocommerce-webhooks-health.ts, que reexporta las constantes de aquí.

/** La fuente de `sync_state` de la revisión. */
export const WOO_WEBHOOKS_SOURCE = "woo_webhooks";
/**
 * Prefijo de lo que la revisión deja en `stores.woo_last_error`. Distinto del
 * «Webhook: » del aviso que entra (que lo limpia un aviso bueno) y del
 * «Sincronización: » de la pasada (que lo limpia una pasada buena): este solo
 * lo limpia una revisión que encuentra todo bien.
 */
export const WOO_WEBHOOKS_ERROR_PREFIX = "Webhooks en WooCommerce: ";
/** Cómo empieza el texto de una revisión que no pudo leer la lista (`error`). */
export const WOO_WEBHOOKS_UNCHECKED_PREFIX = "no se pudieron revisar: ";
/** Hasta dónde corta `recordWooLastError` (lib/woocommerce-intake.ts) el último fallo. */
export const WOO_LAST_ERROR_MAX = 500;

/** Una fila de `sync_state` como la lee la página de Ajustes. */
export interface WooSyncStateRow {
  source: string;
  status: string | null;
  last_run_at: string | null;
  error: string | null;
}

/** Lo que la sección recibe de una fila de `sync_state`: sin la fuente. */
export type WooSyncStateView = Omit<WooSyncStateRow, "source">;

/** La fila de `sync_state` de esa fuente (`woo_orders`, `woo_webhooks`), o null si todavía no corrió. */
export function wooSyncStateRow(rows: readonly WooSyncStateRow[] | null | undefined, source: string): WooSyncStateView | null {
  const row = (rows ?? []).find((r) => r.source === source);
  return row ? { status: row.status, last_run_at: row.last_run_at, error: row.error } : null;
}

/**
 * Lo que la revisión deja en `stores.woo_last_error` para ese texto: con su
 * prefijo y cortado como lo corta `recordWooLastError`.
 */
export function wooWebhooksLastErrorText(message: string | null): string {
  return `${WOO_WEBHOOKS_ERROR_PREFIX}${message ?? "algo no está bien."}`.slice(0, WOO_LAST_ERROR_MAX);
}

/** Lo que dice la línea cuando la revisión encontró los cuatro temas bien. */
export const WOO_WEBHOOKS_OK_SUMMARY = "los cuatro activos y con la dirección de esta tienda";

export interface WooWebhooksView {
  /** Si va la línea de la revisión: con el sitio y las claves, o si ya hubo una revisión. */
  showLine: boolean;
  /** Lo que dice la línea después de la hora; null si todavía no corrió. */
  summary: string | null;
  /**
   * Lo que falta, en su propio aviso: solo si `woo_last_error` no lo dice ya
   * (otro fallo lo pudo pisar después).
   */
  detail: string | null;
  /** Si la revisión deja la sección «Con error» (encontró algo mal). */
  flagsError: boolean;
}

/**
 * La revisión de los webhooks en Ajustes. Que algo falta queda en
 * `woo_last_error` y, si otro fallo lo pisó, en su propio aviso. Que no se
 * pudo revisar lo dice la línea, con el motivo cuando el último fallo no lo
 * dice ya (WooCommerce caído o lento no llega a `woo_last_error`). Pura.
 */
export function wooWebhooksView(input: {
  webhooks: WooSyncStateView | null;
  lastError: string | null;
  apiReady: boolean;
}): WooWebhooksView {
  const hooks = input.webhooks;
  // Lo escribió esta misma revisión: el último fallo es su texto, tal cual.
  const said = Boolean(hooks?.error) && input.lastError === wooWebhooksLastErrorText(hooks!.error);
  const detail = hooks?.status === "warning" && hooks.error && !said ? hooks.error : null;
  const unchecked = hooks?.status === "error" && hooks.error && !said ? hooks.error : "";
  const reason = (
    unchecked.startsWith(WOO_WEBHOOKS_UNCHECKED_PREFIX) ? unchecked.slice(WOO_WEBHOOKS_UNCHECKED_PREFIX.length) : unchecked
  )
    .replace(/\.\s*$/, "")
    .trim();
  const summary = !hooks?.last_run_at
    ? null
    : hooks.status === "ok"
      ? WOO_WEBHOOKS_OK_SUMMARY
      : hooks.status === "warning"
        ? "falta algo"
        : `no se pudo revisar${reason ? `: ${reason}` : ""}`;
  return {
    showLine: input.apiReady || hooks !== null,
    summary,
    detail,
    flagsError: hooks?.status === "warning",
  };
}

export type WooSectionBadge = "con_error" | "conectada" | "incompleta" | "sin_configurar";

/** La chapa de la sección: «Con error» con un último fallo o con algo mal en la revisión de los webhooks. Pura. */
export function wooSectionBadge(input: {
  lastError: string | null;
  webhooksFlagError: boolean;
  apiReady: boolean;
  hasWebhookSecret: boolean;
  siteUrl: string | null;
}): WooSectionBadge {
  if (input.lastError || input.webhooksFlagError) return "con_error";
  if (input.apiReady && input.hasWebhookSecret) return "conectada";
  if (input.apiReady || input.siteUrl) return "incompleta";
  return "sin_configurar";
}
