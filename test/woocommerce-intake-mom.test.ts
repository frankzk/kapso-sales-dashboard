// MOM §38.11 (la entrada de pedidos de WooCommerce) atado a lo que de verdad
// corre: los nombres, los topes y los códigos HTTP que el MOM promete son los
// del código. Las reglas, a fondo, en test/woocommerce-webhook.test.ts,
// test/woocommerce-sync.test.ts y test/woocommerce-settings.test.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WOO_INTAKE_TOPICS,
  WOO_SYNC_BUDGET_MS,
  WOO_SYNC_MAX_PAGES,
  WOO_SYNC_OVERLAP_MS,
  WOO_SYNC_PER_PAGE,
  WOO_SYNC_SOURCE,
  wooWebhookHttpStatus,
} from "@/lib/woocommerce-intake";
import { WOO_ORDER_TOPICS, WOO_TIMEOUT_MS } from "@/lib/woocommerce";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const MOM = read("docs/mom/master-pedidos-v1.md");

function section(title: string): string {
  const start = MOM.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const level = title.match(/^#+/)![0].length;
  const rest = MOM.slice(start + title.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

const S = section("### 38.11 La entrada de pedidos de WooCommerce");

describe("MOM §38.11 · el webhook", () => {
  it("los temas son los del código y los de la base técnica (38.8)", () => {
    expect([...WOO_INTAKE_TOPICS].sort()).toEqual([...WOO_ORDER_TOPICS].sort());
    for (const t of WOO_INTAKE_TOPICS) expect(S).toContain(`\`${t}\``);
  });

  it("los códigos HTTP que promete el MOM", () => {
    expect(S).toContain("recibe **200 antes de mirar la firma**");
    expect(wooWebhookHttpStatus({ status: "ping", ping: true })).toBe(200);
    expect(S).toContain("si la tienda no existe, **404**");
    expect(wooWebhookHttpStatus({ status: "unknown_store", ping: true })).toBe(404);
    expect(S).toContain("Si no se pudo leer la tienda, 503");
    expect(wooWebhookHttpStatus({ status: "error", ping: true })).toBe(503);
    expect(S).toContain("que no cuadra recibe **401**");
    expect(wooWebhookHttpStatus({ status: "unauthorized" })).toBe(401);
    expect(S).toContain("**Todo lo demás contesta 200**");
    for (const status of ["ok", "duplicate", "ignored", "error", "unknown_store"] as const) {
      expect(wooWebhookHttpStatus({ status }), status).toBe(200);
    }
  });

  it("repetidos por el sha256 del cuerpo, y el borrado nunca borra", () => {
    expect(S).toContain('`webhook_events.webhook_id = "wc:" + sha256 del cuerpo`');
    expect(S).toContain("Nunca el `X-WC-Webhook-Delivery-ID` solo");
    expect(S).toContain("**Kapta nunca lo borra**, y un pedido que no tiene no lo crea desde la papelera.");
    expect(S).toContain("Primero lo vuelve a leer por la API (`GET /wp-json/wc/v3/orders/<id>`");
    expect(S).toContain("**Un estado más viejo no pisa uno más nuevo.**");
    expect(S).toContain("**Un anulado que nunca fue pedido no entra.**");
  });
});

describe("MOM §38.11 · la sincronización", () => {
  it("la fuente, la petición y los topes son los del código", () => {
    expect(S).toContain(`fuente \`${WOO_SYNC_SOURCE}\``);
    expect(S).toContain(
      "`GET /wp-json/wc/v3/orders?modified_after=<cursor>&dates_are_gmt=true&orderby=modified&order=asc&per_page=100&page=N`",
    );
    expect(WOO_SYNC_PER_PAGE).toBe(100);
    expect(WOO_SYNC_MAX_PAGES).toBe(10);
    expect(S).toContain(`**${WOO_SYNC_MAX_PAGES} páginas de ${WOO_SYNC_PER_PAGE}**`);
    expect(S).toContain(`**${WOO_SYNC_BUDGET_MS / 1000} segundos** por tienda`);
    expect(S).toContain(`corta a los ${WOO_TIMEOUT_MS / 1000} s`);
    expect(WOO_SYNC_OVERLAP_MS).toBe(2 * 60_000);
    expect(S).toContain("**menos 2 minutos**");
  });

  it("guardar las claves completas es activarla, y un fallo no corta Shopify", () => {
    expect(S).toContain("**guardar las claves completas es activarla.**");
    expect(S).toContain("**no corta** las pasadas de Shopify, Kapso ni leads");
  });
});

describe("MOM §38.11 · Ajustes", () => {
  it("con «Administrar tiendas», sin mostrar secretos, sin tocar la plataforma", () => {
    expect(S).toContain("«Administrar tiendas», `stores.manage`");
    expect(S).toContain("**Los secretos se guardan cifrados y nunca vuelven a la pantalla:**");
    expect(S).toContain("**No cambia `stores.platform`**");
  });

  it("los archivos que nombra existen", () => {
    for (const f of [
      "app/api/webhooks/woocommerce/[storeId]/route.ts",
      "lib/woocommerce-intake.ts",
      "lib/woocommerce-settings.ts",
      "app/dashboard/[storeId]/settings/woo-actions.ts",
      "components/woocommerce-settings-section.tsx",
      "test/woocommerce-webhook.test.ts",
      "test/woocommerce-sync.test.ts",
      "test/woocommerce-settings.test.ts",
    ]) {
      expect(S, f).toContain(`\`${f}\``);
      expect(() => read(f), f).not.toThrow();
    }
  });
});
