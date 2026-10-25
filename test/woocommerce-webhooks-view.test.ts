// Ajustes → WooCommerce: lo que se ve de la revisión de los webhooks (MOM
// §38.14, 25-10-2026). Es lo que el owner mira hoy: la chapa «Con error» cuando
// falta un webhook, la línea «Revisión de los webhooks en WooCommerce (cada
// hora)», el aviso aparte con lo que falta si otro fallo pisó el último fallo,
// y que la página tome la fila `woo_webhooks` de `sync_state`. Se prueba la
// vista pura (lib/woocommerce-webhooks-view.ts) y la sección renderizada; las
// acciones de servidor van simuladas: aquí no sale nada a la red.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/dashboard/[storeId]/settings/woo-actions", () => ({
  saveWooSettings: vi.fn(async () => ({})),
  testWooConnection: vi.fn(async () => ({})),
  generateWooWebhookSecret: vi.fn(async () => ({})),
}));
vi.mock("@/app/dashboard/[storeId]/settings/woo-platform-actions", () => ({
  switchStorePlatform: vi.fn(async () => ({})),
}));

import { WooCommerceSettingsSection, type WooSettingsView } from "@/components/woocommerce-settings-section";
import { WOO_INTAKE_TOPICS, WOO_SYNC_SOURCE } from "@/lib/woocommerce-intake";
import {
  WOO_LAST_ERROR_MAX,
  WOO_WEBHOOKS_ERROR_PREFIX,
  WOO_WEBHOOKS_OK_SUMMARY,
  WOO_WEBHOOKS_SOURCE,
  wooSectionBadge,
  wooSyncStateRow,
  wooWebhooksLastErrorText,
  wooWebhooksView,
  type WooSyncStateView,
} from "@/lib/woocommerce-webhooks-view";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const AT = "2026-10-25T16:34:05.000Z";
/** Lo que deja la revisión cuando a Kenku le faltan order.created, order.deleted y order.restored. */
const MISSING =
  "falta order.created, falta order.deleted, falta order.restored. La sincronización trae lo demás cada 5 minutos, pero no ve la papelera: sin order.deleted, un pedido mandado a la papelera sigue vivo en Kapta. Se arregla en WooCommerce → Ajustes → Avanzado → Webhooks: uno «Activo» por tema, con la dirección y el secreto de esta tienda.";

const row = (over: Partial<WooSyncStateView> = {}): WooSyncStateView => ({ status: "ok", last_run_at: AT, error: null, ...over });
const warning = row({ status: "warning", error: MISSING });

// ── La vista ────────────────────────────────────────────────────────────────

describe("wooSyncStateRow: la fila de cada fuente", () => {
  const rows = [
    { source: WOO_SYNC_SOURCE, status: "ok", last_run_at: AT, error: null, cursor: "2026-10-25T16:30:00.000Z" },
    { source: WOO_WEBHOOKS_SOURCE, status: "warning", last_run_at: AT, error: MISSING },
    { source: "orders", status: "ok", last_run_at: AT, error: null },
  ];

  it("toma la de esa fuente, sin la fuente ni el cursor", () => {
    expect(wooSyncStateRow(rows, WOO_WEBHOOKS_SOURCE)).toEqual({ status: "warning", last_run_at: AT, error: MISSING });
    expect(wooSyncStateRow(rows, WOO_SYNC_SOURCE)).toEqual({ status: "ok", last_run_at: AT, error: null });
    expect(WOO_WEBHOOKS_SOURCE).toBe("woo_webhooks");
  });

  it("sin la fila (todavía no corrió) o sin filas: null", () => {
    expect(wooSyncStateRow(rows.slice(0, 1), WOO_WEBHOOKS_SOURCE)).toBeNull();
    expect(wooSyncStateRow(null, WOO_WEBHOOKS_SOURCE)).toBeNull();
    expect(wooSyncStateRow([], WOO_WEBHOOKS_SOURCE)).toBeNull();
  });
});

describe("wooWebhooksView: la línea, el aviso aparte y si deja la sección con error", () => {
  const said = wooWebhooksLastErrorText(MISSING);

  it("todavía no corrió: la línea solo con el sitio y las claves", () => {
    expect(wooWebhooksView({ webhooks: null, lastError: null, apiReady: false })).toEqual({
      showLine: false,
      summary: null,
      detail: null,
      flagsError: false,
    });
    expect(wooWebhooksView({ webhooks: null, lastError: null, apiReady: true })).toEqual({
      showLine: true,
      summary: null,
      detail: null,
      flagsError: false,
    });
  });

  it("todo bien", () => {
    expect(wooWebhooksView({ webhooks: row(), lastError: null, apiReady: true })).toEqual({
      showLine: true,
      summary: WOO_WEBHOOKS_OK_SUMMARY,
      detail: null,
      flagsError: false,
    });
  });

  it("falta algo y el último fallo es ese texto: «falta algo», con error, sin repetirlo", () => {
    expect(wooWebhooksView({ webhooks: warning, lastError: said, apiReady: true })).toEqual({
      showLine: true,
      summary: "falta algo",
      detail: null,
      flagsError: true,
    });
  });

  it("falta algo y otro fallo pisó el último fallo (o no hay): el detalle va aparte", () => {
    for (const lastError of ["Sincronización: WooCommerce falló (HTTP 500).", "Webhook: llegó un aviso firmado desde otro sitio.", null]) {
      expect(wooWebhooksView({ webhooks: warning, lastError, apiReady: true }), String(lastError)).toMatchObject({
        detail: MISSING,
        flagsError: true,
      });
    }
    // Un último fallo de una revisión ANTERIOR (otro texto) tampoco lo dice.
    expect(wooWebhooksView({ webhooks: warning, lastError: wooWebhooksLastErrorText("falta order.restored. …"), apiReady: true }).detail).toBe(MISSING);
  });

  it("no se pudo revisar: con el motivo si el último fallo no lo dice (WooCommerce lento no llega a él)", () => {
    const slow = row({ status: "error", error: "no se pudieron revisar: WooCommerce no respondió a tiempo (15 s)." });
    expect(wooWebhooksView({ webhooks: slow, lastError: null, apiReady: true })).toEqual({
      showLine: true,
      summary: "no se pudo revisar: WooCommerce no respondió a tiempo (15 s)",
      detail: null,
      flagsError: false,
    });
    // Sin permiso sí llega al último fallo: la línea no repite el motivo.
    const denied = row({ status: "error", error: "no se pudieron revisar: WooCommerce no dio permiso (HTTP 403)." });
    expect(wooWebhooksView({ webhooks: denied, lastError: wooWebhooksLastErrorText(denied.error), apiReady: true }).summary).toBe(
      "no se pudo revisar",
    );
  });

  it("el último fallo cortado a 500 sigue siendo el de la revisión", () => {
    const long = row({ status: "error", error: `no se pudieron revisar: ${"x".repeat(600)}` });
    const lastError = wooWebhooksLastErrorText(long.error);
    expect(lastError).toHaveLength(WOO_LAST_ERROR_MAX);
    expect(lastError.startsWith(WOO_WEBHOOKS_ERROR_PREFIX)).toBe(true);
    expect(wooWebhooksView({ webhooks: long, lastError, apiReady: true }).summary).toBe("no se pudo revisar");
  });
});

describe("wooSectionBadge: la chapa de la sección", () => {
  const base = { lastError: null, webhooksFlagError: false, apiReady: true, hasWebhookSecret: true, siteUrl: "https://kenku.pe" };

  it("«Con error» con un último fallo o con algo mal en la revisión de los webhooks", () => {
    expect(wooSectionBadge(base)).toBe("conectada");
    expect(wooSectionBadge({ ...base, webhooksFlagError: true })).toBe("con_error");
    expect(wooSectionBadge({ ...base, lastError: "Sincronización: WooCommerce falló (HTTP 500)." })).toBe("con_error");
  });

  it("incompleta y sin configurar", () => {
    expect(wooSectionBadge({ ...base, hasWebhookSecret: false })).toBe("incompleta");
    expect(wooSectionBadge({ ...base, apiReady: false })).toBe("incompleta");
    expect(wooSectionBadge({ ...base, apiReady: false, hasWebhookSecret: false, siteUrl: null })).toBe("sin_configurar");
  });
});

// ── La sección renderizada ──────────────────────────────────────────────────

function data(over: Partial<WooSettingsView> = {}): WooSettingsView {
  return {
    siteUrl: "https://64-176-27-178.sslip.io",
    siteKey: "kp",
    suggestedSiteKey: "kp",
    platform: "shopify",
    platformSwitchedAt: null,
    hasConsumerKey: true,
    hasConsumerSecret: true,
    hasWebhookSecret: true,
    lastError: null,
    webhookUrl: `https://kapta.example/api/webhooks/woocommerce/${STORE_ID}`,
    topics: WOO_INTAKE_TOPICS,
    sync: row(),
    webhooks: row(),
    migrationMissing: false,
    ...over,
  };
}

/** El texto visible de la sección, sin etiquetas y con los espacios juntos. */
function render(over: Partial<WooSettingsView> = {}): string {
  const html = renderToStaticMarkup(createElement(WooCommerceSettingsSection, { storeId: STORE_ID, data: data(over) }));
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const count = (text: string, part: string) => text.split(part).length - 1;
const LINE = "Revisión de los webhooks en WooCommerce (cada hora):";
/** La hora como la muestra la sección (Lima), con los espacios juntos como en `render`. */
const WHEN = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
  .format(new Date(AT))
  .replace(/\s+/g, " ");

describe("Ajustes → WooCommerce con la revisión de los webhooks", () => {
  it("todo bien: «Conectada» y la línea con los cuatro activos", () => {
    const text = render();
    expect(text).toContain("Conectada");
    expect(text).not.toContain("Con error");
    expect(text).toContain(`${LINE} ${WHEN} · ${WOO_WEBHOOKS_OK_SUMMARY}.`);
    expect(text).not.toContain("Webhooks en WooCommerce ");
  });

  it("falta algo y nadie lo pisó: «Con error» y el texto una sola vez, en el último fallo", () => {
    const text = render({ webhooks: warning, lastError: wooWebhooksLastErrorText(MISSING) });
    expect(text).toContain("Con error");
    expect(text).not.toContain("Conectada");
    expect(text).toContain(`${LINE} ${WHEN} · falta algo.`);
    expect(text).toContain("Último fallo con WooCommerce");
    expect(count(text, MISSING)).toBe(1);
  });

  it("falta algo pero otro fallo pisó el último fallo: el detalle va en su propio aviso", () => {
    const text = render({ webhooks: warning, lastError: "Sincronización: WooCommerce falló (HTTP 500). Intenta de nuevo en unos minutos." });
    expect(text).toContain("Con error");
    expect(text).toContain(`Webhooks en WooCommerce ${MISSING}`);
    expect(text).toContain("Último fallo con WooCommerce Sincronización: WooCommerce falló (HTTP 500).");
    expect(count(text, MISSING)).toBe(1);
  });

  it("falta algo sin último fallo (lo limpió otra cosa): igual «Con error» y el detalle", () => {
    const text = render({ webhooks: warning, lastError: null });
    expect(text).toContain("Con error");
    expect(text).toContain(`Webhooks en WooCommerce ${MISSING}`);
    expect(text).not.toContain("Último fallo con WooCommerce");
  });

  it("no se pudo revisar por WooCommerce lento: la línea da el motivo y la chapa no cambia", () => {
    const text = render({ webhooks: row({ status: "error", error: "no se pudieron revisar: WooCommerce no respondió a tiempo (15 s)." }) });
    expect(text).toContain(`${LINE} ${WHEN} · no se pudo revisar: WooCommerce no respondió a tiempo (15 s).`);
    expect(text).toContain("Conectada");
  });

  it("con las claves y sin revisión: «todavía no corrió»; sin el sitio, ni la línea", () => {
    expect(render({ webhooks: null })).toContain(`${LINE} todavía no corrió.`);
    const none = render({
      webhooks: null,
      sync: null,
      siteUrl: null,
      siteKey: null,
      hasConsumerKey: false,
      hasConsumerSecret: false,
      hasWebhookSecret: false,
    });
    expect(none).not.toContain(LINE);
    expect(none).toContain("Sin configurar");
  });

  it("la ayuda de los webhooks dice que la papelera solo llega por order.deleted", () => {
    expect(render()).toContain("lo que se manda a la papelera solo llega por order.deleted");
  });
});

// ── La página ───────────────────────────────────────────────────────────────

describe("la página de Ajustes manda la fila de la revisión y la dirección que la revisión acepta", () => {
  const PAGE = readFileSync(join(process.cwd(), "app/dashboard/[storeId]/settings/page.tsx"), "utf8");
  const woo = PAGE.slice(PAGE.indexOf("    woo: {"), PAGE.indexOf("    botOrders: {"));

  it("la fila woo_webhooks de sync_state, y la de woo_orders, con wooSyncStateRow", () => {
    expect(woo).toContain("webhooks: wooSyncStateRow(sync as WooSyncStateRow[] | null, WOO_WEBHOOKS_SOURCE),");
    expect(woo).toContain("sync: wooSyncStateRow(sync as WooSyncStateRow[] | null, WOO_SYNC_SOURCE),");
    expect(PAGE).toContain('import { WOO_WEBHOOKS_SOURCE, wooSyncStateRow, type WooSyncStateRow } from "@/lib/woocommerce-webhooks-view";');
    // La consulta trae las columnas que la vista usa.
    expect(PAGE).toContain('.select("source, status, last_run_at, cursor, error")');
  });

  it("la dirección de los webhooks, con la dirección de Kapta que acepta la revisión", () => {
    expect(woo).toContain("webhookUrl: wooWebhookDeliveryUrl(kaptaWebhookOrigins()[0] ?? (siteUrl || env.siteUrl()), storeId),");
  });
});
